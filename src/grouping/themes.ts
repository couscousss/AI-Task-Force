import type { SolverParams, SolverParticipant, Theme } from './types';

/**
 * Turning the clustering output into team slots (spec §6.5 steps 1-2).
 *
 * Themes arrive from an LLM, so nothing here trusts them: unknown participant ids are
 * ignored, a participant claimed by two themes belongs to the first, and anyone no
 * theme mentions lands in a "Mixed" bucket rather than falling out of the event.
 */

export const MIXED_LABEL = 'Mixed';
const MIXED_SUMMARY = 'Problem statements that did not settle into a shared theme.';

export interface ThemeBucket {
  label: string;
  summary: string;
  /** Participant ids, sorted ascending so the bucket is order-independent. */
  member_ids: string[];
  /** Number of teams this theme was allocated. */
  slots: number;
  /** Global team indexes owned by this theme, contiguous and ascending. */
  team_indexes: number[];
}

const STOPWORDS = new Set([
  'the', 'and', 'for', 'with', 'that', 'this', 'from', 'into', 'our', 'their', 'are', 'was',
  'have', 'has', 'not', 'but', 'you', 'your', 'they', 'them', 'its', 'it', 'a', 'an', 'of',
  'to', 'in', 'on', 'by', 'or', 'as', 'at', 'is', 'be', 'we', 'us', 'work', 'using', 'use',
  'want', 'would', 'like', 'more', 'about', 'across', 'people', 'team', 'teams', 'theme',
]);

/** Lowercased word tokens, stopwords and single characters dropped. */
export function tokenize(text: string): Set<string> {
  const out = new Set<string>();
  for (const raw of text.toLowerCase().split(/[^a-z0-9]+/)) {
    if (raw.length < 2) continue;
    if (STOPWORDS.has(raw)) continue;
    out.add(raw);
  }
  return out;
}

/** Jaccard overlap of two token sets. 0 when either side has nothing to compare. */
export function jaccard(a: ReadonlySet<string>, b: ReadonlySet<string>): number {
  if (a.size === 0 || b.size === 0) return 0;
  let shared = 0;
  for (const t of a) if (b.has(t)) shared++;
  const union = a.size + b.size - shared;
  return union === 0 ? 0 : shared / union;
}

function bucketTokens(b: ThemeBucket): Set<string> {
  return tokenize(`${b.label} ${b.summary}`);
}

/**
 * [DECIDE] resolved: "nearest theme" is deterministic token overlap — Jaccard over the
 * lowercased word tokens of label + summary, tie-broken by the larger theme and then by
 * label ascending. No embeddings, no second LLM call: it has to give the same answer
 * from a stored seed months later, and a wrong-but-stable merge is easy for an organizer
 * to fix on the review board. See DECISIONS.md.
 */
export function bestMergeTarget(source: ThemeBucket, all: readonly ThemeBucket[]): ThemeBucket | null {
  const sourceTokens = bucketTokens(source);
  let best: ThemeBucket | null = null;
  let bestSim = -1;
  for (const candidate of all) {
    if (candidate === source) continue;
    const sim = jaccard(sourceTokens, bucketTokens(candidate));
    if (best === null || sim > bestSim) {
      best = candidate;
      bestSim = sim;
      continue;
    }
    if (sim === bestSim) {
      const bigger = candidate.member_ids.length - best.member_ids.length;
      if (bigger > 0 || (bigger === 0 && candidate.label < best.label)) best = candidate;
    }
  }
  return best;
}

/**
 * Group participants into themed buckets and allocate the `teamCount` team slots
 * between them. Slots start from a largest-remainder proportional split and are then
 * rebalanced so no theme is left with teams that would blow past `max_team_size` while
 * another theme sits on a spare slot.
 */
export function buildBuckets(
  participants: readonly SolverParticipant[],
  themes: readonly Theme[],
  teamCount: number,
  params: SolverParams,
): ThemeBucket[] {
  const known = new Set(participants.map((p) => p.id));
  const claimed = new Set<string>();
  const buckets: ThemeBucket[] = [];

  for (const theme of themes ?? []) {
    if (!theme || !Array.isArray(theme.participant_ids)) continue;
    const ids: string[] = [];
    for (const id of theme.participant_ids) {
      if (typeof id !== 'string' || !known.has(id) || claimed.has(id)) continue;
      claimed.add(id);
      ids.push(id);
    }
    if (ids.length === 0) continue;
    const label = (theme.label ?? '').trim();
    buckets.push({
      label: label === '' ? `Theme ${buckets.length + 1}` : label,
      summary: (theme.summary ?? '').trim(),
      member_ids: ids.sort(),
      slots: 0,
      team_indexes: [],
    });
  }

  const leftovers = participants
    .map((p) => p.id)
    .filter((id) => !claimed.has(id))
    .sort();
  if (leftovers.length > 0) {
    buckets.push({
      label: MIXED_LABEL,
      summary: MIXED_SUMMARY,
      member_ids: leftovers,
      slots: 0,
      team_indexes: [],
    });
  }

  if (buckets.length === 0 || teamCount <= 0) return [];

  mergeSmallThemes(buckets, teamCount, params);
  allocateSlots(buckets, teamCount);

  let next = 0;
  for (const b of buckets) {
    b.team_indexes = [];
    for (let i = 0; i < b.slots; i++) b.team_indexes.push(next++);
  }
  return buckets;
}

/**
 * Merge themes that are too small to be a team of their own, and keep merging while
 * there are more themes than teams — otherwise some theme could never get a slot.
 */
function mergeSmallThemes(buckets: ThemeBucket[], teamCount: number, params: SolverParams): void {
  const guard = buckets.length + 4;
  for (let pass = 0; pass < guard; pass++) {
    if (buckets.length <= 1) return;
    const smallest = buckets
      .slice()
      .sort((a, b) => a.member_ids.length - b.member_ids.length || (a.label < b.label ? -1 : a.label > b.label ? 1 : 0))[0]!;
    const tooMany = buckets.length > teamCount;
    if (!tooMany && smallest.member_ids.length >= params.min_team_size) return;

    const target = bestMergeTarget(smallest, buckets);
    if (!target) return;
    target.member_ids = target.member_ids.concat(smallest.member_ids).sort();
    buckets.splice(buckets.indexOf(smallest), 1);
  }
}

function allocateSlots(buckets: ThemeBucket[], teamCount: number): void {
  const sizes = buckets.map((b) => b.member_ids.length);
  const total = sizes.reduce((a, b) => a + b, 0);

  // Every surviving theme gets at least one team; the rest is a largest-remainder split.
  const extra = Math.max(0, teamCount - buckets.length);
  const exact = sizes.map((s) => (total === 0 ? 0 : (extra * s) / total));
  const bonus = exact.map((e) => Math.floor(e));
  let handed = bonus.reduce((a, b) => a + b, 0);
  const order = buckets
    .map((b, i) => ({ i, rem: (exact[i] ?? 0) - (bonus[i] ?? 0), size: sizes[i] ?? 0, label: b.label }))
    .sort(
      (a, b) =>
        b.rem - a.rem || b.size - a.size || (a.label < b.label ? -1 : a.label > b.label ? 1 : 0),
    );
  for (let k = 0; handed < extra && order.length > 0; k++, handed++) {
    const target = order[k % order.length]!;
    bonus[target.i] = (bonus[target.i] ?? 0) + 1;
  }
  buckets.forEach((b, i) => {
    b.slots = 1 + (bonus[i] ?? 0);
  });

  // Rebalance: move a slot from the theme with the most room to the theme with the least,
  // while that strictly lowers the largest average team size. Converges, and it is what
  // splits an oversized theme across several teams.
  const guard = teamCount * 4 + 8;
  for (let pass = 0; pass < guard; pass++) {
    const hi = pickExtreme(buckets, true, () => true);
    const lo = pickExtreme(buckets, false, (b) => b.slots > 1);
    if (!hi || !lo || hi === lo) return;
    const hiAvg = hi.member_ids.length / hi.slots;
    const loAfter = lo.member_ids.length / (lo.slots - 1);
    // Stop as soon as handing the slot over would make the donor the new worst team.
    if (loAfter >= hiAvg) return;
    lo.slots -= 1;
    hi.slots += 1;
  }
}

function pickExtreme(
  buckets: readonly ThemeBucket[],
  wantMax: boolean,
  eligible: (b: ThemeBucket) => boolean,
): ThemeBucket | null {
  let best: ThemeBucket | null = null;
  let bestAvg = 0;
  for (const b of buckets) {
    if (!eligible(b)) continue;
    const avg = b.member_ids.length / b.slots;
    if (best === null) {
      best = b;
      bestAvg = avg;
      continue;
    }
    const better = wantMax ? avg > bestAvg : avg < bestAvg;
    if (better) {
      best = b;
      bestAvg = avg;
    } else if (avg === bestAvg) {
      const sizeDiff = wantMax
        ? b.member_ids.length - best.member_ids.length
        : best.member_ids.length - b.member_ids.length;
      if (sizeDiff > 0 || (sizeDiff === 0 && b.label < best.label)) best = b;
    }
  }
  return best;
}
