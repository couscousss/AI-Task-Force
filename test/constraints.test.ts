import { describe, expect, it } from 'vitest';
import { DEFAULT_SOLVER_PARAMS } from '../src/config';
import type { SolverParams } from '../src/config';
import { checkTeam, evaluateArrangement, teamChips, teamHardCost } from '../src/grouping/constraints';
import { solve } from '../src/grouping';
import type { ArrangementTeam, SolverParticipant } from '../src/grouping/types';
import type { SkillVector } from '../src/types';
import { makeFixture } from './fixtures';

const P = DEFAULT_SOLVER_PARAMS;

function person(
  id: string,
  skills: [number, number, number, number],
  has_laptop = true,
  department: string | null = 'Ops',
): SolverParticipant {
  const [understanding, tools, prompting, building] = skills;
  const vector: SkillVector = { understanding, tools, prompting, building };
  return { id, name: id, department, category: 'automate', skills: vector, has_laptop };
}

const BUILDER = (id: string, laptop = true) => person(id, [3, 3, 3, 4], laptop);
const NOVICE = (id: string, laptop = true) => person(id, [1, 2, 1, 2], laptop);
const MIDDLING = (id: string, laptop = true) => person(id, [3, 2, 3, 2], laptop);

describe('checkTeam', () => {
  it('counts laptops, spots the builder, and flags size', () => {
    const c = checkTeam(0, [BUILDER('a'), NOVICE('b', false), NOVICE('c', false)], P);
    expect(c.size).toBe(3);
    expect(c.laptops).toBe(1);
    expect(c.has_builder).toBe(true);
    expect(c.all_novice).toBe(false);
    expect(c.undersized).toBe(false);
    expect(c.oversized).toBe(false);
  });

  it('only calls a team all-novice when every member is under the threshold on all four axes', () => {
    expect(checkTeam(0, [NOVICE('a'), NOVICE('b'), NOVICE('c')], P).all_novice).toBe(true);
    expect(checkTeam(0, [NOVICE('a'), NOVICE('b'), MIDDLING('c')], P).all_novice).toBe(false);
    // An empty team is an H1 problem, not an H4 one.
    expect(checkTeam(0, [], P).all_novice).toBe(false);
  });
});

describe('teamHardCost', () => {
  it('is zero for a team that satisfies all four constraints', () => {
    const team = [BUILDER('a'), MIDDLING('b'), NOVICE('c', false)];
    expect(teamHardCost(checkTeam(0, team, P), P)).toBe(0);
  });

  it('rises with each breach and respects the enforce_* toggles', () => {
    const broken = [NOVICE('a', false), NOVICE('b', false)];
    expect(teamHardCost(checkTeam(0, broken, P), P)).toBeGreaterThan(0);
    const relaxed: SolverParams = {
      ...P,
      min_team_size: 2,
      constraints: { enforce_laptops: false, enforce_builder: false, enforce_not_all_novice: false },
    };
    expect(teamHardCost(checkTeam(0, broken, relaxed), relaxed)).toBe(0);
  });
});

describe('teamChips', () => {
  it('names the shortfall concretely and stays short enough for an inline chip', () => {
    const chips = teamChips(checkTeam(0, [NOVICE('a', true), NOVICE('b', false)], P), P);
    expect(chips).toContain('Only 2 members — teams need 3');
    expect(chips).toContain('Only 1 laptop — needs 2');
    expect(chips).toContain('No one rating 3+ on Building');
    expect(chips).toContain('Everyone here rates 2 or below on all four axes');
    for (const chip of chips) expect(chip.length).toBeLessThan(90);
  });

  it('gives an empty team its own next action', () => {
    expect(teamChips(checkTeam(0, [], P), P)).toEqual(['No members yet — drag someone in']);
  });

  it('is silent for a healthy team', () => {
    expect(teamChips(checkTeam(0, [BUILDER('a'), MIDDLING('b'), NOVICE('c')], P), P)).toEqual([]);
  });
});

describe('evaluateArrangement', () => {
  const pool = [
    BUILDER('a'),
    MIDDLING('b'),
    NOVICE('c'),
    BUILDER('d'),
    MIDDLING('e'),
    NOVICE('f'),
  ];
  const twoGoodTeams: ArrangementTeam[] = [
    { index: 0, theme_label: 'One', member_ids: ['a', 'b', 'c'] },
    { index: 1, theme_label: 'Two', member_ids: ['d', 'e', 'f'] },
  ];

  it('reports nothing for a healthy arrangement', () => {
    const ev = evaluateArrangement(pool, twoGoodTeams, P);
    expect(ev.violations).toEqual([]);
    expect(ev.per_team).toEqual({});
  });

  it('reports an unassigned person and says what to do about it', () => {
    const teams: ArrangementTeam[] = [
      { index: 0, theme_label: 'One', member_ids: ['a', 'b', 'c'] },
      { index: 1, theme_label: 'Two', member_ids: ['d', 'e'] },
    ];
    const ev = evaluateArrangement(pool, teams, P);
    const unassigned = ev.violations.find((v) => v.message.includes('not on any team'));
    expect(unassigned).toBeDefined();
    expect(unassigned?.message).toBe(
      'H1: 1 person is not on any team. Drag them onto a team before publishing.',
    );
  });

  it('reports a person who ended up on two teams', () => {
    const teams: ArrangementTeam[] = [
      { index: 0, theme_label: 'One', member_ids: ['a', 'b', 'c'] },
      { index: 1, theme_label: 'Two', member_ids: ['d', 'e', 'f', 'a'] },
    ];
    const ev = evaluateArrangement(pool, teams, P);
    expect(ev.violations.some((v) => v.message.includes('on more than one team'))).toBe(true);
  });

  it('handles an empty team, an oversized team and a stale id without throwing', () => {
    const teams: ArrangementTeam[] = [
      { index: 0, theme_label: 'One', member_ids: [] },
      { index: 1, theme_label: 'Two', member_ids: ['a', 'b', 'c', 'd', 'e', 'f', 'ghost'] },
    ];
    let ev: ReturnType<typeof evaluateArrangement> | null = null;
    expect(() => {
      ev = evaluateArrangement(pool, teams, P);
    }).not.toThrow();
    expect(ev!.per_team[0]).toEqual(['No members yet — drag someone in']);
    expect(ev!.per_team[1]).toContain('6 members — the maximum is 5');
  });

  it('survives nonsense input', () => {
    expect(() => evaluateArrangement([], [], P)).not.toThrow();
    expect(evaluateArrangement([], [], P).violations).toEqual([]);
    expect(() =>
      evaluateArrangement(pool, [{ index: 0, theme_label: 'x', member_ids: ['nobody'] }], P),
    ).not.toThrow();
  });

  it('reports violations even when every enforce_* toggle is off', () => {
    const relaxed: SolverParams = {
      ...P,
      constraints: { enforce_laptops: false, enforce_builder: false, enforce_not_all_novice: false },
    };
    const noLaptops = [NOVICE('a', false), NOVICE('b', false), NOVICE('c', false)];
    const teams: ArrangementTeam[] = [{ index: 0, theme_label: 'One', member_ids: ['a', 'b', 'c'] }];
    const codes = evaluateArrangement(noLaptops, teams, relaxed).violations.map((v) => v.code);
    expect(codes).toContain('H2');
    expect(codes).toContain('H3');
    expect(codes).toContain('H4');
  });

  it('separates pool-level impossibility from a fixable arrangement', () => {
    // Plenty of builders in the pool, but this arrangement stacks them onto one team.
    const stacked = [BUILDER('a'), BUILDER('b'), BUILDER('c'), NOVICE('d'), NOVICE('e'), NOVICE('f')];
    const teams: ArrangementTeam[] = [
      { index: 0, theme_label: 'One', member_ids: ['a', 'b', 'c'] },
      { index: 1, theme_label: 'Two', member_ids: ['d', 'e', 'f'] },
    ];
    const h3 = evaluateArrangement(stacked, teams, P).violations.find((v) => v.code === 'H3');
    expect(h3?.scope).toBe('team');
    expect(h3?.team_indexes).toEqual([1]);
    expect(h3?.message).toContain('move one across');

    // The same shape, but now the pool genuinely has only one builder.
    const scarce = [BUILDER('a'), NOVICE('b'), NOVICE('c'), NOVICE('d'), NOVICE('e'), NOVICE('f')];
    const poolH3 = evaluateArrangement(scarce, teams, P).violations.find((v) => v.code === 'H3');
    expect(poolH3?.scope).toBe('pool');
    expect(poolH3?.team_indexes).toEqual([]);
  });

  it('uses the run theme assignment for cohesion when it is supplied', () => {
    const themeOf = { a: 'One', b: 'One', c: 'One', d: 'Two', e: 'Two', f: 'Two' };
    expect(evaluateArrangement(pool, twoGoodTeams, P, themeOf).score.theme_cohesion).toBe(1);
    expect(evaluateArrangement(pool, twoGoodTeams, P).score.theme_cohesion).toBe(0);
    const scrambled: ArrangementTeam[] = [
      { index: 0, theme_label: 'One', member_ids: ['a', 'b', 'd'] },
      { index: 1, theme_label: 'Two', member_ids: ['c', 'e', 'f'] },
    ];
    expect(evaluateArrangement(pool, scrambled, P, themeOf).score.theme_cohesion).toBeCloseTo(2 / 3, 10);
  });

  it('agrees with the solver about a freshly solved arrangement', () => {
    const { participants, themes } = makeFixture({ count: 36, seed: 21, laptopRate: 0.9, spread: 'wide' });
    const result = solve({ participants, themes, params: P, seed: 21 });
    const ev = evaluateArrangement(
      participants,
      result.teams.map((t) => ({ index: t.index, theme_label: t.theme_label, member_ids: t.member_ids })),
      P,
    );
    expect(ev.violations.map((v) => v.code)).toEqual(result.violations.map((v) => v.code));
    expect(ev.per_team).toEqual({});
  });
});

describe('violation messages', () => {
  it('state the shortfall in real numbers and end with an action (H3, spec §6.3 register)', () => {
    const { participants, themes } = makeFixture({ count: 32, seed: 5, laptopRate: 0.95, builderRate: 2 / 32 });
    const result = solve({ participants, themes, params: P, seed: 5 });
    const h3 = result.violations.find((v) => v.code === 'H3');
    expect(h3).toBeDefined();
    expect(h3?.message).toMatch(
      /^H3: \d+ teams? (has|have) no member rating themselves 3\+ on Building\. Only 2 such participants across \d+ teams\. Consider pairing these teams or recruiting a facilitator\.$/,
    );
  });

  it('never leaves an organizer with a message that has no number in it', () => {
    const { participants, themes } = makeFixture({ count: 26, seed: 13, laptopRate: 0.1, allSkillsAt: 1 });
    const result = solve({ participants, themes, params: P, seed: 13 });
    expect(result.violations.length).toBeGreaterThan(0);
    for (const v of result.violations) {
      expect(v.message).toMatch(/\d/);
      expect(v.message.trim().endsWith('.')).toBe(true);
      expect(v.message.startsWith(`${v.code}: `)).toBe(true);
    }
  });
});
