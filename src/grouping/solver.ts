import {
  buildViolations,
  checkTeam,
  poolFacts,
  teamHardCost,
} from './constraints';
import type { TeamCheck } from './constraints';
import { createRng } from './prng';
import { aggregateScore, computeTeamStat, zeroScore } from './score';
import type { TeamStat, ThemeLookup } from './score';
import { buildBuckets } from './themes';
import type {
  ScoreBreakdown,
  SolvedTeam,
  SolverInput,
  SolverParams,
  SolverParticipant,
  SolverResult,
  SolverStats,
} from './types';

/**
 * The solver (spec §6.5). Pure and seeded: same seed + same input produces
 * byte-identical output, including array ordering. Every sort below carries a
 * tie-break on participant id or team index so equal keys can never reorder, and the
 * only source of randomness is the mulberry32 stream in `prng.ts`.
 *
 * `Date.now()` appears exactly once, to fill in `duration_ms`. It never reaches a
 * decision.
 */

/** Floating-point slack for "strictly improves". */
const EPS = 1e-12;

export function computeTeamCount(n: number, params: SolverParams): number {
  if (!Number.isFinite(n) || n <= 0) return 0;
  const min = Math.max(1, Math.floor(params.min_team_size));
  const max = Math.max(min, Math.floor(params.max_team_size));
  const target = Math.min(max, Math.max(min, Math.floor(params.target_team_size) || min));
  // Too few people for even one legal team: still make one team, and H1 says so.
  if (n < min) return 1;
  let k = Math.round(n / target);
  const lower = Math.ceil(n / max); // fewer teams than this and some team must exceed max
  const upper = Math.floor(n / min); // more teams than this and some team must fall below min
  if (k < lower) k = lower;
  if (k > upper) k = upper;
  return Math.max(1, k);
}

/** Sizes as even as possible, the larger teams first, summing exactly to `n`. */
export function computeTeamSizes(n: number, teamCount: number): number[] {
  if (!Number.isFinite(teamCount) || teamCount <= 0) return [];
  const k = Math.floor(teamCount);
  const total = Number.isFinite(n) && n > 0 ? Math.floor(n) : 0;
  const base = Math.floor(total / k);
  const remainder = total % k;
  const out: number[] = [];
  for (let i = 0; i < k; i++) out.push(base + (i < remainder ? 1 : 0));
  return out;
}

function byId(a: SolverParticipant, b: SolverParticipant): number {
  return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
}

/**
 * Draft order. Deliberately lexicographic across the four axes in a fixed priority
 * (building first, because that is what H3 needs), NOT a sum of the four — §3.1. Ties
 * fall through to participant id so the order is total.
 */
const DRAFT_AXIS_PRIORITY = ['building', 'prompting', 'tools', 'understanding'] as const;

function byCapability(a: SolverParticipant, b: SolverParticipant): number {
  for (const axis of DRAFT_AXIS_PRIORITY) {
    const d = (b.skills[axis] ?? 1) - (a.skills[axis] ?? 1);
    if (d !== 0) return d;
  }
  return byId(a, b);
}

function emptyStats(attending: number, teamCount: number, startedAt: number): SolverStats {
  return {
    team_count: teamCount,
    attending_count: attending,
    local_search_iterations: 0,
    local_search_improvements: 0,
    repair_swaps: 0,
    duration_ms: Date.now() - startedAt,
  };
}

export function solve(input: SolverInput): SolverResult {
  const startedAt = Date.now(); // timing only
  const params = input.params;

  // Deduplicate and impose a total order before anything else touches the data.
  const sorted = [...(input.participants ?? [])].filter((p) => !!p && typeof p.id === 'string').sort(byId);
  const participants: SolverParticipant[] = [];
  for (const p of sorted) {
    if (participants[participants.length - 1]?.id === p.id) continue;
    participants.push(p);
  }
  const n = participants.length;
  const teamCount = computeTeamCount(n, params);

  if (n === 0 || teamCount === 0) {
    return { teams: [], score: zeroScore(), violations: [], stats: emptyStats(n, 0, startedAt) };
  }

  const byIdMap = new Map<string, SolverParticipant>();
  for (const p of participants) byIdMap.set(p.id, p);
  const get = (id: string): SolverParticipant => byIdMap.get(id)!;
  const materialize = (ids: readonly string[]): SolverParticipant[] => ids.map(get);

  // ---- 1-2. themes -> buckets -> team slots --------------------------------
  const buckets = buildBuckets(participants, input.themes ?? [], teamCount, params);
  const bucketOf = new Map<string, number>();
  const themeKeys = new Map<string, string>();
  const themeOf: ThemeLookup = themeKeys;
  buckets.forEach((b, bi) => {
    for (const id of b.member_ids) {
      bucketOf.set(id, bi);
      // Keyed by bucket index, not label: two themes may come back with the same label.
      themeKeys.set(id, String(bi));
    }
  });
  const teamBucket: number[] = new Array<number>(teamCount).fill(0);
  buckets.forEach((b, bi) => {
    for (const t of b.team_indexes) if (t >= 0 && t < teamCount) teamBucket[t] = bi;
  });

  const memberIds: string[][] = Array.from({ length: teamCount }, () => []);
  const capacity: number[] = new Array<number>(teamCount).fill(params.max_team_size);
  for (const b of buckets) {
    const sizes = computeTeamSizes(b.member_ids.length, b.team_indexes.length);
    b.team_indexes.forEach((t, i) => {
      if (t >= 0 && t < teamCount) capacity[t] = Math.max(1, sizes[i] ?? params.target_team_size);
    });
  }

  // ---- 3. seed: highest Building first, one per team -----------------------
  const capabilityOrder = [...participants].sort(byCapability);
  const seeded = new Set<string>();
  const isEmpty: boolean[] = new Array<boolean>(teamCount).fill(true);
  let emptyCount = teamCount;
  for (const p of capabilityOrder) {
    if (emptyCount === 0) break;
    const bi = bucketOf.get(p.id);
    let target = -1;
    if (bi !== undefined) {
      for (const t of buckets[bi]?.team_indexes ?? []) {
        if (isEmpty[t]) {
          target = t;
          break;
        }
      }
    }
    if (target === -1) {
      // This person's theme is already fully seeded, so front-loading H3 wins over
      // theme cohesion: take the lowest-index team that is still empty.
      for (let t = 0; t < teamCount; t++) {
        if (isEmpty[t]) {
          target = t;
          break;
        }
      }
    }
    if (target === -1) break;
    memberIds[target]!.push(p.id);
    isEmpty[target] = false;
    emptyCount--;
    seeded.add(p.id);
  }

  // ---- 4. snake draft the remainder, within each theme ---------------------
  const leftovers: SolverParticipant[] = [];
  for (const b of buckets) {
    const teams = b.team_indexes.filter((t) => t >= 0 && t < teamCount);
    const queue = b.member_ids.filter((id) => !seeded.has(id)).map(get).sort(byCapability);
    if (teams.length === 0) {
      leftovers.push(...queue);
      continue;
    }
    let cursor = 0;
    for (let round = 0; cursor < queue.length; round++) {
      // Alternating direction each round is what deliberately mixes high and low.
      const order = round % 2 === 0 ? teams : [...teams].reverse();
      let placed = 0;
      for (const t of order) {
        if (cursor >= queue.length) break;
        if (memberIds[t]!.length >= (capacity[t] ?? params.target_team_size)) continue;
        memberIds[t]!.push(queue[cursor++]!.id);
        placed++;
      }
      if (placed === 0) break; // every team of this theme is full
    }
    leftovers.push(...queue.slice(cursor));
  }
  for (const p of leftovers.sort(byCapability)) {
    let target = 0;
    for (let t = 1; t < teamCount; t++) {
      if (memberIds[t]!.length < memberIds[target]!.length) target = t;
    }
    memberIds[target]!.push(p.id);
  }

  // ---- running state for scoring and feasibility ---------------------------
  const stats: TeamStat[] = memberIds.map((ids) => computeTeamStat(materialize(ids), themeOf));
  const checks: TeamCheck[] = memberIds.map((ids, t) => checkTeam(t, materialize(ids), params));
  const costs: number[] = checks.map((c) => teamHardCost(c, params));
  let score: ScoreBreakdown = aggregateScore(stats, params.weights);

  const refresh = (t: number): void => {
    const members = materialize(memberIds[t]!);
    stats[t] = computeTeamStat(members, themeOf);
    checks[t] = checkTeam(t, members, params);
    costs[t] = teamHardCost(checks[t]!, params);
  };

  /** Score of a hypothetical arrangement of two teams, without mutating anything. */
  const scoreWith = (t1: number, m1: readonly string[], t2: number, m2: readonly string[]): ScoreBreakdown => {
    const trial = stats.slice();
    trial[t1] = computeTeamStat(materialize(m1), themeOf);
    trial[t2] = computeTeamStat(materialize(m2), themeOf);
    return aggregateScore(trial, params.weights);
  };
  const costWith = (t: number, members: readonly string[]): number =>
    teamHardCost(checkTeam(t, materialize(members), params), params);

  // ---- 5. repair pass ------------------------------------------------------
  let repair_swaps = 0;
  const stuck = new Set<number>();
  const repairBudget = teamCount * 6 + 40;
  for (let pass = 0; pass < repairBudget; pass++) {
    let target = -1;
    for (let t = 0; t < teamCount; t++) {
      if ((costs[t] ?? 0) > 0 && !stuck.has(t)) {
        target = t;
        break;
      }
    }
    if (target === -1) break;

    const fix = findBestFix(target);
    if (!fix) {
      stuck.add(target);
      continue;
    }
    memberIds[fix.a] = fix.aMembers;
    memberIds[fix.b] = fix.bMembers;
    refresh(fix.a);
    refresh(fix.b);
    score = aggregateScore(stats, params.weights);
    repair_swaps++;
    // Every accepted fix strictly lowers total hard cost, so re-examining teams that
    // were previously unfixable cannot loop.
    stuck.clear();
  }

  interface Fix {
    a: number;
    b: number;
    aMembers: string[];
    bMembers: string[];
    total: number;
    key: string;
  }

  function consider(
    best: Fix | null,
    a: number,
    aMembers: string[],
    b: number,
    bMembers: string[],
    key: string,
  ): Fix | null {
    const costA = costWith(a, aMembers);
    const costB = costWith(b, bMembers);
    const before = (costs[a] ?? 0) + (costs[b] ?? 0);
    // The team we are repairing must strictly improve, and no one else may pay for it.
    if (costA >= (costs[a] ?? 0)) return best;
    if (costA + costB > before) return best;
    const total = scoreWith(a, aMembers, b, bMembers).weighted_total;
    if (best === null) return { a, b, aMembers, bMembers, total, key };
    if (total > best.total + EPS) return { a, b, aMembers, bMembers, total, key };
    if (Math.abs(total - best.total) <= EPS && key < best.key) {
      return { a, b, aMembers, bMembers, total, key };
    }
    return best;
  }

  /** The swap or move that fixes team `t` at the smallest cost in soft score. */
  function findBestFix(t: number): Fix | null {
    const check = checks[t]!;
    const mine = memberIds[t]!;
    let best: Fix | null = null;

    if (check.undersized && mine.length < params.max_team_size) {
      for (let u = 0; u < teamCount; u++) {
        if (u === t) continue;
        const theirs = memberIds[u]!;
        if (theirs.length <= params.min_team_size && theirs.length <= mine.length) continue;
        for (let j = 0; j < theirs.length; j++) {
          const moved = theirs[j]!;
          best = consider(
            best,
            t,
            mine.concat(moved),
            u,
            theirs.filter((_, k) => k !== j),
            `in:${moved}`,
          );
        }
      }
      return best;
    }

    if (check.oversized) {
      for (let i = 0; i < mine.length; i++) {
        const moved = mine[i]!;
        for (let u = 0; u < teamCount; u++) {
          if (u === t) continue;
          const theirs = memberIds[u]!;
          if (theirs.length >= params.max_team_size) continue;
          best = consider(
            best,
            t,
            mine.filter((_, k) => k !== i),
            u,
            theirs.concat(moved),
            `out:${moved}:${u}`,
          );
        }
      }
      return best;
    }

    for (let i = 0; i < mine.length; i++) {
      const x = mine[i]!;
      for (let u = 0; u < teamCount; u++) {
        if (u === t) continue;
        const theirs = memberIds[u]!;
        for (let j = 0; j < theirs.length; j++) {
          const y = theirs[j]!;
          best = consider(
            best,
            t,
            mine.map((id, k) => (k === i ? y : id)),
            u,
            theirs.map((id, k) => (k === j ? x : id)),
            `swap:${x}:${y}`,
          );
        }
      }
    }
    return best;
  }

  // ---- 6. local search on the soft score -----------------------------------
  const rng = createRng(input.seed);
  const maxIterations = Math.max(0, Math.floor(params.max_local_search_iterations));
  const patience = Math.max(1, Math.floor(params.local_search_patience));
  let iterations = 0;
  let improvements = 0;
  let sinceImprovement = 0;
  if (teamCount >= 2) {
    while (iterations < maxIterations && sinceImprovement < patience) {
      iterations++;
      sinceImprovement++;
      const a = rng.int(teamCount);
      const b = rng.int(teamCount);
      if (a === b) continue;
      const aMembersNow = memberIds[a]!;
      const bMembersNow = memberIds[b]!;
      if (aMembersNow.length === 0 || bMembersNow.length === 0) continue;
      const i = rng.int(aMembersNow.length);
      const j = rng.int(bMembersNow.length);
      const x = aMembersNow[i]!;
      const y = bMembersNow[j]!;
      const nextA = aMembersNow.map((id, k) => (k === i ? y : id));
      const nextB = bMembersNow.map((id, k) => (k === j ? x : id));
      // Feasibility, gated by the enforce_* toggles inside teamHardCost.
      const costBefore = (costs[a] ?? 0) + (costs[b] ?? 0);
      if (costWith(a, nextA) + costWith(b, nextB) > costBefore) continue;
      const candidate = scoreWith(a, nextA, b, nextB);
      if (candidate.weighted_total <= score.weighted_total + EPS) continue;
      memberIds[a] = nextA;
      memberIds[b] = nextB;
      refresh(a);
      refresh(b);
      score = candidate;
      improvements++;
      sinceImprovement = 0;
    }
  }

  // ---- 7. emit -------------------------------------------------------------
  const finalChecks = memberIds.map((ids, t) => checkTeam(t, materialize(ids), params));
  const facts = poolFacts(participants, teamCount, params);
  const violations = buildViolations(finalChecks, facts, params, { unassigned: 0, duplicated: 0 });

  const teams: SolvedTeam[] = memberIds.map((ids, t) => {
    const bucket = buckets[teamBucket[t] ?? 0];
    return {
      index: t,
      theme_label: bucket?.label ?? 'Mixed',
      theme_summary: bucket?.summary ?? '',
      member_ids: [...ids],
    };
  });

  return {
    teams,
    score: aggregateScore(stats, params.weights),
    violations,
    stats: {
      team_count: teamCount,
      attending_count: n,
      local_search_iterations: iterations,
      local_search_improvements: improvements,
      repair_swaps,
      duration_ms: Date.now() - startedAt,
    },
  };
}
