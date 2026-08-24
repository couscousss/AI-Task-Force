import { describe, expect, it } from 'vitest';
import { DEFAULT_SOLVER_PARAMS } from '../src/config';
import { aggregateScore, computeTeamStat, scoreArrangement, zeroScore } from '../src/grouping/score';
import type { SolverParticipant } from '../src/grouping/types';
import type { SkillVector } from '../src/types';

const W = DEFAULT_SOLVER_PARAMS.weights;

function person(
  id: string,
  skills: [number, number, number, number],
  extra: Partial<Pick<SolverParticipant, 'department' | 'category' | 'has_laptop'>> = {},
): SolverParticipant {
  const [understanding, tools, prompting, building] = skills;
  const vector: SkillVector = { understanding, tools, prompting, building };
  return {
    id,
    name: id,
    department: extra.department ?? 'Ops',
    category: extra.category ?? 'automate',
    skills: vector,
    has_laptop: extra.has_laptop ?? true,
  };
}

describe('computeTeamStat', () => {
  it('computes mean and standard deviation per axis, not on a per-person total', () => {
    const stat = computeTeamStat([person('a', [1, 2, 3, 4]), person('b', [3, 4, 5, 2])], null);
    expect(stat.size).toBe(2);
    expect(stat.axis_mean).toEqual([2, 3, 4, 3]);
    expect(stat.axis_std).toEqual([1, 1, 1, 1]);
  });

  it('gives an empty team a zeroed statistic rather than NaN', () => {
    const stat = computeTeamStat([], null);
    expect(stat.size).toBe(0);
    expect(stat.axis_mean).toEqual([0, 0, 0, 0]);
    expect(stat.axis_std).toEqual([0, 0, 0, 0]);
    expect(Number.isNaN(stat.theme_share)).toBe(false);
  });

  it('reports the dominant category share and the distinct-department share', () => {
    const stat = computeTeamStat(
      [
        person('a', [3, 3, 3, 3], { category: 'automate', department: 'Finance' }),
        person('b', [3, 3, 3, 3], { category: 'automate', department: 'Finance' }),
        person('c', [3, 3, 3, 3], { category: 'search', department: 'Digital' }),
        person('d', [3, 3, 3, 3], { category: 'search', department: 'Legal' }),
      ],
      null,
    );
    expect(stat.category_share).toBe(0.5);
    expect(stat.department_share).toBe(0.75);
  });

  it('treats a missing department as one shared "unknown" bucket', () => {
    const stat = computeTeamStat(
      [person('a', [1, 1, 1, 1], { department: null }), person('b', [1, 1, 1, 1], { department: null })],
      null,
    );
    expect(stat.department_share).toBe(0.5);
  });

  it('uses the theme lookup when given one and reads 0 when not', () => {
    const members = [person('a', [1, 1, 1, 1]), person('b', [1, 1, 1, 1]), person('c', [1, 1, 1, 1])];
    const lookup = new Map([
      ['a', 'T1'],
      ['b', 'T1'],
      ['c', 'T2'],
    ]);
    expect(computeTeamStat(members, lookup).theme_share).toBeCloseTo(2 / 3, 10);
    expect(computeTeamStat(members, null).theme_share).toBe(0);
  });
});

describe('aggregateScore', () => {
  it('normalises within-team spread against the maximum possible on a 1..5 scale', () => {
    const split = [person('a', [1, 1, 1, 1]), person('b', [5, 5, 5, 5])];
    const s = aggregateScore([computeTeamStat(split, null)], W);
    expect(s.skill_diversity).toBeCloseTo(1, 10);
  });

  it('scores an identical team as zero diversity', () => {
    const same = [person('a', [3, 3, 3, 3]), person('b', [3, 3, 3, 3]), person('c', [3, 3, 3, 3])];
    expect(aggregateScore([computeTeamStat(same, null)], W).skill_diversity).toBe(0);
  });

  it('distinguishes teams that a summed skill score would call identical', () => {
    // Both teams total 8 points per person, so a scalar model sees zero spread in each.
    // Per axis, team A is genuinely mixed and team B is not.
    const teamA = [person('a', [5, 1, 1, 1]), person('b', [1, 5, 1, 1])];
    const teamB = [person('c', [2, 2, 2, 2]), person('d', [2, 2, 2, 2])];
    const a = aggregateScore([computeTeamStat(teamA, null)], W).skill_diversity;
    const b = aggregateScore([computeTeamStat(teamB, null)], W).skill_diversity;
    expect(a).toBeCloseTo(0.5, 10);
    expect(b).toBe(0);
    expect(a).toBeGreaterThan(b);
  });

  it('across_team_balance is a negative variance in [-1, 0], and 0 when teams match', () => {
    const balanced = scoreArrangement(
      [
        [person('a', [3, 3, 3, 3]), person('b', [1, 1, 1, 1])],
        [person('c', [3, 3, 3, 3]), person('d', [1, 1, 1, 1])],
      ],
      W,
      null,
    );
    expect(balanced.across_team_balance).toBe(0);

    const stacked = scoreArrangement(
      [
        [person('a', [5, 5, 5, 5]), person('b', [5, 5, 5, 5])],
        [person('c', [1, 1, 1, 1]), person('d', [1, 1, 1, 1])],
      ],
      W,
      null,
    );
    expect(stacked.across_team_balance).toBeCloseTo(-1, 10);
    expect(stacked.across_team_balance).toBeLessThan(balanced.across_team_balance);
  });

  it('weighted_total is exactly the weighted sum of the five components', () => {
    const s = scoreArrangement(
      [
        [person('a', [1, 2, 3, 4], { department: 'Finance' }), person('b', [4, 3, 2, 1], { department: 'Digital' })],
        [person('c', [2, 2, 3, 3], { department: 'Legal' }), person('d', [3, 3, 2, 2], { department: 'People' })],
      ],
      W,
      null,
    );
    const expected =
      W.theme_cohesion * s.theme_cohesion +
      W.skill_diversity * s.skill_diversity +
      W.across_team_balance * s.across_team_balance +
      W.category_match * s.category_match +
      W.department_mixing * s.department_mixing;
    expect(s.weighted_total).toBeCloseTo(expected, 12);
  });

  it('skips empty teams instead of dragging every mean towards zero', () => {
    const members = [person('a', [4, 4, 4, 4]), person('b', [2, 2, 2, 2])];
    const withEmpty = aggregateScore([computeTeamStat(members, null), computeTeamStat([], null)], W);
    const without = aggregateScore([computeTeamStat(members, null)], W);
    expect(withEmpty).toEqual(without);
  });

  it('returns a zero score when there is nothing to score', () => {
    expect(aggregateScore([], W)).toEqual(zeroScore());
  });

  it('clamps out-of-range skill values rather than producing a wild score', () => {
    const stat = computeTeamStat([person('a', [0, 9, 3, 3])], null);
    expect(stat.axis_mean[0]).toBe(1);
    expect(stat.axis_mean[1]).toBe(5);
  });
});
