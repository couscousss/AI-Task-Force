import { SKILL_AXES } from '../config';
import type { SoftScoreWeights } from '../config';
import { aggregateScore, computeTeamStat, zeroScore } from './score';
import type { ThemeLookup } from './score';
import type {
  ArrangementTeam,
  Evaluation,
  ScoreBreakdown,
  SolverParams,
  SolverParticipant,
  Violation,
} from './types';

/**
 * Hard constraints (spec §6.3) and the human-readable register of everything the
 * current arrangement — or the participant pool itself — cannot satisfy.
 *
 * `params.constraints.enforce_*` gates *repair and local search* only. Violations are
 * always computed and always reported: an organizer who has switched off the laptop
 * rule still needs to know how many teams are short.
 */

export function teamLabel(index: number): string {
  return `Team ${index + 1}`;
}

/** Everything the four hard constraints need to know about one team, computed once. */
export interface TeamCheck {
  index: number;
  size: number;
  laptops: number;
  has_builder: boolean;
  /** True only for a non-empty team where every member is at or below the novice threshold on all four axes. */
  all_novice: boolean;
  undersized: boolean;
  oversized: boolean;
}

export function isNovice(p: SolverParticipant, params: SolverParams): boolean {
  // Checked axis by axis; there is deliberately no "total skill" number to compare.
  return SKILL_AXES.every((axis) => (p.skills[axis] ?? 1) <= params.novice_threshold);
}

export function isBuilder(p: SolverParticipant, params: SolverParams): boolean {
  return (p.skills.building ?? 1) >= params.builder_threshold;
}

export function checkTeam(
  index: number,
  members: readonly SolverParticipant[],
  params: SolverParams,
): TeamCheck {
  let laptops = 0;
  let has_builder = false;
  let all_novice = members.length > 0;
  for (const m of members) {
    if (m.has_laptop) laptops++;
    if (isBuilder(m, params)) has_builder = true;
    if (all_novice && !isNovice(m, params)) all_novice = false;
  }
  return {
    index,
    size: members.length,
    laptops,
    has_builder,
    all_novice,
    undersized: members.length < params.min_team_size,
    oversized: members.length > params.max_team_size,
  };
}

/**
 * How many *enforced* hard constraints this team breaks. Used as the feasibility test
 * for repair and local search: a move is only allowed if the total over the teams it
 * touches does not go up. Phrasing it as a cost rather than a boolean is what lets the
 * solver keep working on a pool that can never be fully feasible.
 */
export function teamHardCost(check: TeamCheck, params: SolverParams): number {
  let cost = 0;
  if (check.undersized) cost += params.min_team_size - check.size;
  if (check.oversized) cost += check.size - params.max_team_size;
  if (params.constraints.enforce_laptops && check.size > 0) {
    cost += Math.max(0, params.min_laptops_per_team - check.laptops);
  }
  if (params.constraints.enforce_builder && check.size > 0 && !check.has_builder) cost += 1;
  if (params.constraints.enforce_not_all_novice && check.all_novice) cost += 1;
  return cost;
}

/** Short inline messages for the review board chips. Kept under ~90 characters each. */
export function teamChips(check: TeamCheck, params: SolverParams): string[] {
  const chips: string[] = [];
  if (check.size === 0) {
    chips.push('No members yet — drag someone in');
    return chips;
  }
  if (check.undersized) {
    chips.push(`Only ${check.size} ${check.size === 1 ? 'member' : 'members'} — teams need ${params.min_team_size}`);
  }
  if (check.oversized) {
    chips.push(`${check.size} members — the maximum is ${params.max_team_size}`);
  }
  if (check.laptops < params.min_laptops_per_team) {
    chips.push(
      check.laptops === 0
        ? `No laptops — needs ${params.min_laptops_per_team}`
        : `Only ${check.laptops} laptop${check.laptops === 1 ? '' : 's'} — needs ${params.min_laptops_per_team}`,
    );
  }
  if (!check.has_builder) {
    chips.push(`No one rating ${params.builder_threshold}+ on Building`);
  }
  if (check.all_novice) {
    chips.push(`Everyone here rates ${params.novice_threshold} or below on all four axes`);
  }
  return chips;
}

/** What the pool itself can supply, independent of how it happens to be arranged. */
export interface PoolFacts {
  people: number;
  team_count: number;
  laptops: number;
  laptops_needed: number;
  builders: number;
  non_novices: number;
}

export function poolFacts(
  participants: readonly SolverParticipant[],
  teamCount: number,
  params: SolverParams,
): PoolFacts {
  let laptops = 0;
  let builders = 0;
  let non_novices = 0;
  for (const p of participants) {
    if (p.has_laptop) laptops++;
    if (isBuilder(p, params)) builders++;
    if (!isNovice(p, params)) non_novices++;
  }
  return {
    people: participants.length,
    team_count: teamCount,
    laptops,
    laptops_needed: teamCount * params.min_laptops_per_team,
    builders,
    non_novices,
  };
}

function listTeams(indexes: readonly number[]): string {
  const labels = indexes.map(teamLabel);
  if (labels.length <= 4) return labels.join(', ');
  return `${labels.slice(0, 3).join(', ')} and ${labels.length - 3} more`;
}

function plural(n: number, one: string, many: string): string {
  return n === 1 ? one : many;
}

/** "1 laptop" / "9 laptops" — every number in a violation message goes through this. */
function count(n: number, one: string, many: string): string {
  return `${n} ${n === 1 ? one : many}`;
}

/**
 * The violation register. One entry per constraint: `pool` when the participant pool
 * makes it impossible (the organizer needs to recruit, merge or lower a threshold) and
 * `team` when this particular arrangement is at fault (they can fix it by dragging).
 * Every message states the shortfall in real numbers and ends with something to do.
 */
export function buildViolations(
  checks: readonly TeamCheck[],
  facts: PoolFacts,
  params: SolverParams,
  extra: { unassigned: number; duplicated: number },
): Violation[] {
  const violations: Violation[] = [];
  const nonEmpty = checks.filter((c) => c.size > 0);

  // ---- H1 size -------------------------------------------------------------
  if (facts.people > 0 && facts.people < params.min_team_size) {
    violations.push({
      code: 'H1',
      scope: 'pool',
      team_indexes: [],
      message:
        `H1: ${count(facts.people, 'person is', 'people are')} attending, fewer than the ` +
        `minimum team size of ${params.min_team_size}. Run this as one group, or lower the minimum team size.`,
    });
  }
  const under = checks.filter((c) => c.undersized && c.size > 0).map((c) => c.index);
  const empty = checks.filter((c) => c.size === 0).map((c) => c.index);
  const over = checks.filter((c) => c.oversized).map((c) => c.index);
  if (empty.length > 0) {
    violations.push({
      code: 'H1',
      scope: 'team',
      team_indexes: empty,
      message:
        `H1: ${count(empty.length, 'team has', 'teams have')} no members (${listTeams(empty)}). ` +
        `Move people across, or delete the empty ${plural(empty.length, 'team', 'teams')} and re-run.`,
    });
  }
  if (under.length > 0) {
    const shortfall = checks
      .filter((c) => c.undersized && c.size > 0)
      .reduce((acc, c) => acc + (params.min_team_size - c.size), 0);
    violations.push({
      code: 'H1',
      scope: 'team',
      team_indexes: under,
      message:
        `H1: ${count(under.length, 'team has', 'teams have')} fewer than ${params.min_team_size} members ` +
        `(${listTeams(under)}). Move ${count(shortfall, 'person', 'people')} across, or lower the team count ` +
        `and re-run.`,
    });
  }
  if (over.length > 0) {
    const excess = checks
      .filter((c) => c.oversized)
      .reduce((acc, c) => acc + (c.size - params.max_team_size), 0);
    violations.push({
      code: 'H1',
      scope: 'team',
      team_indexes: over,
      message:
        `H1: ${count(over.length, 'team has', 'teams have')} more than ${params.max_team_size} members ` +
        `(${listTeams(over)}). Move ${count(excess, 'person', 'people')} to a smaller team.`,
    });
  }
  if (extra.unassigned > 0) {
    violations.push({
      code: 'H1',
      scope: 'team',
      team_indexes: [],
      message:
        `H1: ${count(extra.unassigned, 'person is', 'people are')} not on any team. ` +
        `Drag ${plural(extra.unassigned, 'them', 'each of them')} onto a team before publishing.`,
    });
  }
  if (extra.duplicated > 0) {
    violations.push({
      code: 'H1',
      scope: 'team',
      team_indexes: [],
      message:
        `H1: ${count(extra.duplicated, 'person appears', 'people appear')} on more than one team. ` +
        `Remove the duplicate ${plural(extra.duplicated, 'entry', 'entries')} before publishing.`,
    });
  }

  // ---- H2 laptops ----------------------------------------------------------
  const shortLaptops = nonEmpty.filter((c) => c.laptops < params.min_laptops_per_team).map((c) => c.index);
  if (facts.team_count > 0 && facts.laptops < facts.laptops_needed) {
    const missing = facts.laptops_needed - facts.laptops;
    violations.push({
      code: 'H2',
      scope: 'pool',
      team_indexes: [],
      message:
        `H2: ${count(shortLaptops.length, 'team has', 'teams have')} fewer than ` +
        `${count(params.min_laptops_per_team, 'laptop', 'laptops')}. ` +
        (facts.laptops === 0
          ? `No one has said they can bring a laptop, and ${facts.laptops_needed} are needed across ` +
            `${count(facts.team_count, 'team', 'teams')}. `
          : `Only ${count(facts.laptops, 'laptop', 'laptops')} across ` +
            `${count(facts.team_count, 'team', 'teams')}, where ${facts.laptops_needed} are needed. `) +
        `Ask ${missing} more ${plural(missing, 'person', 'people')} to bring one, or lower the laptop ` +
        `minimum to ${Math.max(1, params.min_laptops_per_team - 1)}.`,
    });
  } else if (shortLaptops.length > 0) {
    violations.push({
      code: 'H2',
      scope: 'team',
      team_indexes: shortLaptops,
      message:
        `H2: ${count(shortLaptops.length, 'team has', 'teams have')} fewer than ` +
        `${count(params.min_laptops_per_team, 'laptop', 'laptops')} (${listTeams(shortLaptops)}). There are ` +
        `${count(facts.laptops, 'laptop', 'laptops')} across ${count(facts.team_count, 'team', 'teams')}, ` +
        `enough to go round — move a laptop owner onto ` +
        `${plural(shortLaptops.length, 'that team', 'each of those teams')}.`,
    });
  }

  // ---- H3 builder present --------------------------------------------------
  const noBuilder = nonEmpty.filter((c) => !c.has_builder).map((c) => c.index);
  if (facts.team_count > 0 && facts.builders < facts.team_count) {
    violations.push({
      code: 'H3',
      scope: 'pool',
      team_indexes: [],
      message:
        `H3: ${count(noBuilder.length, 'team has', 'teams have')} no member rating themselves ` +
        `${params.builder_threshold}+ on Building. ` +
        (facts.builders === 0
          ? `No one in the pool rates themselves ${params.builder_threshold}+ on Building. ` +
            `Recruit a facilitator, or sit with the teams yourself on the day.`
          : `Only ${count(facts.builders, 'such participant', 'such participants')} across ` +
            `${count(facts.team_count, 'team', 'teams')}. Consider pairing these teams or recruiting a ` +
            `facilitator.`),
    });
  } else if (noBuilder.length > 0) {
    violations.push({
      code: 'H3',
      scope: 'team',
      team_indexes: noBuilder,
      message:
        `H3: ${count(noBuilder.length, 'team has', 'teams have')} no member rating themselves ` +
        `${params.builder_threshold}+ on Building (${listTeams(noBuilder)}). There are ` +
        `${count(facts.builders, 'such participant', 'such participants')} across ` +
        `${count(facts.team_count, 'team', 'teams')} — move one across.`,
    });
  }

  // ---- H4 not all novices --------------------------------------------------
  const allNovice = nonEmpty.filter((c) => c.all_novice).map((c) => c.index);
  if (facts.team_count > 0 && facts.non_novices < facts.team_count) {
    violations.push({
      code: 'H4',
      scope: 'pool',
      team_indexes: [],
      message:
        `H4: ${count(allNovice.length, 'team is', 'teams are')} made up entirely of people rating ` +
        `${params.novice_threshold} or below on all four axes. ` +
        (facts.non_novices === 0
          ? `No participant rates above ${params.novice_threshold} on any axis. Recruit facilitators, or plan ` +
            `to run a guided session rather than open build time.`
          : `Only ${count(facts.non_novices, 'participant rates', 'participants rate')} above ` +
            `${params.novice_threshold} on any axis, across ${count(facts.team_count, 'team', 'teams')}. ` +
            `Consider merging these teams or sitting a facilitator with them.`),
    });
  } else if (allNovice.length > 0) {
    violations.push({
      code: 'H4',
      scope: 'team',
      team_indexes: allNovice,
      message:
        `H4: ${count(allNovice.length, 'team is', 'teams are')} made up entirely of people rating ` +
        `${params.novice_threshold} or below on all four axes (${listTeams(allNovice)}). There are ` +
        `${count(facts.non_novices, 'participant rating', 'participants rating')} above ` +
        `${params.novice_threshold} across ${count(facts.team_count, 'team', 'teams')} — move one across.`,
    });
  }

  return violations;
}

/**
 * Evaluate an arbitrary arrangement — including one an organizer has been dragging
 * people around in, where a team may be empty or oversized and a person may be on no
 * team at all. Never throws.
 *
 * `themeOf` is optional because the review board holds an arrangement, not a clustering.
 * Pass the run's theme assignment (participant id -> theme label) when you have it and
 * the theme cohesion component becomes comparable with the score stored on the run;
 * omit it and cohesion reads 0 rather than a flattering 1.
 */
export function evaluateArrangement(
  participants: SolverParticipant[],
  teams: ArrangementTeam[],
  params: SolverParams,
  themeOf?: ReadonlyMap<string, string> | Record<string, string> | null,
): Evaluation {
  const byId = new Map<string, SolverParticipant>();
  for (const p of participants ?? []) {
    if (p && typeof p.id === 'string') byId.set(p.id, p);
  }
  const safeTeams = (teams ?? []).filter((t): t is ArrangementTeam => !!t && Array.isArray(t.member_ids));

  const lookup: ThemeLookup = toLookup(themeOf);

  const seen = new Map<string, number>();
  const memberLists: SolverParticipant[][] = [];
  for (const t of safeTeams) {
    const members: SolverParticipant[] = [];
    for (const id of t.member_ids) {
      const p = byId.get(id);
      if (!p) continue; // a stale id from a participant who has since been removed
      seen.set(id, (seen.get(id) ?? 0) + 1);
      members.push(p);
    }
    memberLists.push(members);
  }

  const checks: TeamCheck[] = memberLists.map((members, i) => {
    const declared = safeTeams[i]?.index;
    return checkTeam(typeof declared === 'number' ? declared : i, members, params);
  });

  let duplicated = 0;
  for (const count of seen.values()) if (count > 1) duplicated++;
  const unassigned = byId.size - seen.size;

  const facts = poolFacts([...byId.values()], checks.length, params);
  const violations = buildViolations(checks, facts, params, { unassigned, duplicated });

  const per_team: Record<number, string[]> = {};
  for (const c of checks) {
    const chips = teamChips(c, params);
    if (chips.length > 0) per_team[c.index] = chips;
  }

  const score: ScoreBreakdown =
    memberLists.length === 0
      ? zeroScore()
      : aggregateScore(
          memberLists.map((m) => computeTeamStat(m, lookup)),
          safeWeights(params),
        );

  return { score, violations, per_team };
}

function toLookup(
  themeOf: ReadonlyMap<string, string> | Record<string, string> | null | undefined,
): ThemeLookup {
  if (!themeOf) return null;
  if (themeOf instanceof Map) return themeOf;
  return new Map(Object.entries(themeOf));
}

function safeWeights(params: SolverParams): SoftScoreWeights {
  const w = params.weights;
  return {
    theme_cohesion: Number.isFinite(w?.theme_cohesion) ? w.theme_cohesion : 0,
    skill_diversity: Number.isFinite(w?.skill_diversity) ? w.skill_diversity : 0,
    across_team_balance: Number.isFinite(w?.across_team_balance) ? w.across_team_balance : 0,
    category_match: Number.isFinite(w?.category_match) ? w.category_match : 0,
    department_mixing: Number.isFinite(w?.department_mixing) ? w.department_mixing : 0,
  };
}
