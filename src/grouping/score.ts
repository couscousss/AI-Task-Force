import { SKILL_AXES } from '../config';
import type { SoftScoreWeights } from '../config';
import type { ScoreBreakdown, SolverParticipant } from './types';

/**
 * Soft score (spec §6.4).
 *
 * Every skill statistic in this file is computed PER AXIS first and only then averaged
 * across the four axes. A per-person scalar total is never formed — that is rule §3.1,
 * and collapsing the vector here would silently make "strong prompter, weak builder"
 * interchangeable with its opposite, which is exactly the pairing we are trying to make.
 *
 * Normalisation, so the five components are comparable before weighting:
 *  - theme_cohesion, category_match, department_mixing are already shares in [0, 1].
 *  - skill_diversity is a within-team population standard deviation on a 1..5 scale.
 *    The largest possible such stdev is 2 (half the team at 1, half at 5), so we divide
 *    by 2 to land in [0, 1].
 *  - across_team_balance is a NEGATIVE variance: team means live in 1..5 so their
 *    variance is at most 4. Divided by 4 and negated it lands in [-1, 0], and a
 *    perfectly balanced set of teams scores 0.
 */

const AXIS_COUNT = SKILL_AXES.length;
const MAX_AXIS_STD = 2;
const MAX_AXIS_MEAN_VARIANCE = 4;

export interface TeamStat {
  size: number;
  /** Share of members drawn from the team's dominant theme, 0..1. */
  theme_share: number;
  /** Share of members in the team's dominant category, 0..1. */
  category_share: number;
  /** Distinct departments divided by team size, 0..1. */
  department_share: number;
  /** Population standard deviation within the team, one entry per axis, in SKILL_AXES order. */
  axis_std: number[];
  /** Mean within the team, one entry per axis, in SKILL_AXES order. */
  axis_mean: number[];
}

export function emptyTeamStat(): TeamStat {
  return {
    size: 0,
    theme_share: 0,
    category_share: 0,
    department_share: 0,
    axis_std: new Array<number>(AXIS_COUNT).fill(0),
    axis_mean: new Array<number>(AXIS_COUNT).fill(0),
  };
}

export function zeroScore(): ScoreBreakdown {
  return {
    theme_cohesion: 0,
    skill_diversity: 0,
    across_team_balance: 0,
    category_match: 0,
    department_mixing: 0,
    weighted_total: 0,
  };
}

/** Largest count sharing a key, divided by the number of members. Empty keys form their own bucket. */
function dominantShare(keys: readonly string[]): number {
  if (keys.length === 0) return 0;
  const counts = new Map<string, number>();
  let best = 0;
  for (const k of keys) {
    const n = (counts.get(k) ?? 0) + 1;
    counts.set(k, n);
    if (n > best) best = n;
  }
  return best / keys.length;
}

function distinctShare(keys: readonly string[]): number {
  if (keys.length === 0) return 0;
  const seen = new Set(keys);
  return seen.size / keys.length;
}

export type ThemeLookup = ReadonlyMap<string, string> | null;

/**
 * All statistics for a single team. Kept separate from the aggregation step so local
 * search can recompute only the two teams a swap touched.
 */
export function computeTeamStat(members: readonly SolverParticipant[], themeOf: ThemeLookup): TeamStat {
  const size = members.length;
  if (size === 0) return emptyTeamStat();

  const themeKeys: string[] = [];
  const categoryKeys: string[] = [];
  const departmentKeys: string[] = [];
  for (const m of members) {
    themeKeys.push(themeOf?.get(m.id) ?? '');
    categoryKeys.push(m.category ?? '');
    departmentKeys.push((m.department ?? '').trim().toLowerCase());
  }

  const axis_mean: number[] = [];
  const axis_std: number[] = [];
  // Per axis, never a per-person total.
  for (let a = 0; a < AXIS_COUNT; a++) {
    const axis = SKILL_AXES[a]!;
    let sum = 0;
    for (const m of members) sum += clampSkill(m.skills[axis]);
    const mean = sum / size;
    let sq = 0;
    for (const m of members) {
      const d = clampSkill(m.skills[axis]) - mean;
      sq += d * d;
    }
    axis_mean.push(mean);
    axis_std.push(Math.sqrt(sq / size));
  }

  return {
    size,
    // themeOf is null when the caller has no theme assignment to hand (a hand-edited
    // arrangement on the review board). Cohesion is then not measurable, so it reads 0
    // rather than a flattering 1.
    theme_share: themeOf ? dominantShare(themeKeys) : 0,
    category_share: dominantShare(categoryKeys),
    department_share: distinctShare(departmentKeys),
    axis_std,
    axis_mean,
  };
}

function clampSkill(v: number | undefined): number {
  if (typeof v !== 'number' || !Number.isFinite(v)) return 1;
  if (v < 1) return 1;
  if (v > 5) return 5;
  return v;
}

function mean(values: readonly number[]): number {
  if (values.length === 0) return 0;
  let s = 0;
  for (const v of values) s += v;
  return s / values.length;
}

/** Roll the per-team statistics up into the five weighted components. Empty teams are skipped. */
export function aggregateScore(stats: readonly TeamStat[], weights: SoftScoreWeights): ScoreBreakdown {
  const filled = stats.filter((s) => s.size > 0);
  if (filled.length === 0) return zeroScore();

  const theme_cohesion = mean(filled.map((s) => s.theme_share));
  const category_match = mean(filled.map((s) => s.category_share));
  const department_mixing = mean(filled.map((s) => s.department_share));

  // Within-team spread: stdev per axis, then the mean of the four per-axis stdevs.
  const skill_diversity = mean(filled.map((s) => mean(s.axis_std) / MAX_AXIS_STD));

  // Across-team balance: the variance of team means is taken per axis, then the four
  // per-axis variances are averaged. Never the variance of a per-team scalar total.
  const perAxisVariance: number[] = [];
  for (let a = 0; a < AXIS_COUNT; a++) {
    const means = filled.map((s) => s.axis_mean[a] ?? 0);
    const mu = mean(means);
    let sq = 0;
    for (const m of means) sq += (m - mu) * (m - mu);
    perAxisVariance.push(sq / means.length);
  }
  const across_team_balance = -(mean(perAxisVariance) / MAX_AXIS_MEAN_VARIANCE);

  const weighted_total =
    weights.theme_cohesion * theme_cohesion +
    weights.skill_diversity * skill_diversity +
    weights.across_team_balance * across_team_balance +
    weights.category_match * category_match +
    weights.department_mixing * department_mixing;

  return {
    theme_cohesion,
    skill_diversity,
    across_team_balance,
    category_match,
    department_mixing,
    weighted_total,
  };
}

/** Convenience for callers that hold whole teams rather than incremental statistics. */
export function scoreArrangement(
  teams: readonly (readonly SolverParticipant[])[],
  weights: SoftScoreWeights,
  themeOf: ThemeLookup,
): ScoreBreakdown {
  return aggregateScore(
    teams.map((t) => computeTeamStat(t, themeOf)),
    weights,
  );
}
