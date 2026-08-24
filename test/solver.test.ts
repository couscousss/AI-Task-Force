import { describe, expect, it } from 'vitest';
import { DEFAULT_SOLVER_PARAMS } from '../src/config';
import type { SolverParams } from '../src/config';
import { computeTeamCount, computeTeamSizes, solve } from '../src/grouping';
import { buildBuckets, jaccard, tokenize } from '../src/grouping/themes';
import type { SolverInput, SolverParticipant, Theme } from '../src/grouping/types';
import {
  assertEveryoneAssignedOnce,
  assertSizesWithin,
  countBuilders,
  makeFixture,
  makeParticipants,
} from './fixtures';

const P = DEFAULT_SOLVER_PARAMS;

function run(
  fixture: { participants: SolverParticipant[]; themes: Theme[] },
  seed: number,
  params: SolverParams = P,
): ReturnType<typeof solve> {
  const input: SolverInput = { participants: fixture.participants, themes: fixture.themes, params, seed };
  return solve(input);
}

describe('computeTeamCount', () => {
  it('lands on the target size where it can', () => {
    expect(computeTeamCount(40, P)).toBe(10);
    expect(computeTeamCount(80, P)).toBe(20);
  });

  it('clamps so that every team can stay inside [min, max]', () => {
    for (let n = 3; n <= 200; n++) {
      const k = computeTeamCount(n, P);
      expect(k * P.min_team_size).toBeLessThanOrEqual(n);
      expect(k * P.max_team_size).toBeGreaterThanOrEqual(n);
    }
  });

  it('handles a pool too small for one legal team', () => {
    expect(computeTeamCount(0, P)).toBe(0);
    expect(computeTeamCount(1, P)).toBe(1);
    expect(computeTeamCount(2, P)).toBe(1);
  });
});

describe('computeTeamSizes', () => {
  it('sums to n and spreads the remainder one per team', () => {
    expect(computeTeamSizes(43, 11)).toEqual([4, 4, 4, 4, 4, 4, 4, 4, 4, 4, 3]);
    expect(computeTeamSizes(43, 11).reduce((a, b) => a + b, 0)).toBe(43);
    expect(computeTeamSizes(12, 3)).toEqual([4, 4, 4]);
    expect(computeTeamSizes(0, 3)).toEqual([0, 0, 0]);
    expect(computeTeamSizes(5, 0)).toEqual([]);
  });
});

describe('solve — a healthy pool', () => {
  it('satisfies every hard constraint with 40 people, plenty of laptops and a wide spread', () => {
    const fixture = makeFixture({ count: 40, seed: 42, laptopRate: 0.9, spread: 'wide' });
    const result = run(fixture, 42);

    expect(result.violations).toEqual([]);
    expect(result.teams).toHaveLength(10);
    assertEveryoneAssignedOnce(fixture.participants, result.teams);
    assertSizesWithin(result.teams, P);

    for (const team of result.teams) {
      const members = team.member_ids.map((id) => fixture.participants.find((p) => p.id === id)!);
      expect(members.filter((m) => m.has_laptop).length).toBeGreaterThanOrEqual(P.min_laptops_per_team);
      expect(members.some((m) => m.skills.building >= P.builder_threshold)).toBe(true);
      expect(members.some((m) => Object.values(m.skills).some((v) => v > P.novice_threshold))).toBe(true);
    }
    expect(result.stats.attending_count).toBe(40);
    expect(result.stats.team_count).toBe(10);
  });

  it('stays clean across a spread of pools, not just one lucky seed', () => {
    for (let seed = 1; seed <= 8; seed++) {
      const fixture = makeFixture({ count: 40, seed, laptopRate: 0.9, spread: 'wide' });
      const result = run(fixture, seed);
      expect(result.violations, `seed ${seed}`).toEqual([]);
      assertEveryoneAssignedOnce(fixture.participants, result.teams);
      assertSizesWithin(result.teams, P);
    }
  });
});

describe('solve — pools that cannot satisfy a constraint', () => {
  it('reports H2 with a truthful laptop count instead of quietly dropping it', () => {
    const fixture = makeFixture({ count: 40, seed: 3, laptopRate: 0.3 });
    const laptops = fixture.participants.filter((p) => p.has_laptop).length;
    const result = run(fixture, 3);

    const h2 = result.violations.find((v) => v.code === 'H2');
    expect(h2, 'H2 must be reported, not swallowed').toBeDefined();
    expect(h2?.scope).toBe('pool');
    expect(h2?.message).toContain(`Only ${laptops} laptops`);
    expect(h2?.message).toContain(`across ${result.stats.team_count} teams`);
    expect(h2?.message).toContain(`${result.stats.team_count * P.min_laptops_per_team} are needed`);
    expect(h2?.message).toContain(`Ask ${result.stats.team_count * P.min_laptops_per_team - laptops} more`);

    // Scarce laptops are spread, not stacked: no team hoards more than it needs while
    // another has none at all.
    const perTeam = result.teams.map(
      (t) => t.member_ids.filter((id) => fixture.participants.find((p) => p.id === id)!.has_laptop).length,
    );
    expect(Math.max(...perTeam)).toBeLessThanOrEqual(P.min_laptops_per_team);
    assertEveryoneAssignedOnce(fixture.participants, result.teams);
  });

  it('spreads the only two builders across different teams and counts them honestly', () => {
    const fixture = makeFixture({ count: 32, seed: 5, laptopRate: 0.95, builderRate: 2 / 32 });
    const builders = fixture.participants.filter((p) => p.skills.building >= P.builder_threshold);
    expect(builders).toHaveLength(2);

    const result = run(fixture, 5);
    expect(result.teams).toHaveLength(8);

    const teamOf = (id: string) => result.teams.find((t) => t.member_ids.includes(id))!.index;
    expect(teamOf(builders[0]!.id)).not.toBe(teamOf(builders[1]!.id));

    const h3 = result.violations.find((v) => v.code === 'H3');
    expect(h3?.scope).toBe('pool');
    expect(h3?.message).toContain('Only 2 such participants across 8 teams');
    expect(h3?.message).toContain('6 teams have no member rating themselves 3+ on Building');
    expect(countBuilders(fixture.participants, P.builder_threshold)).toBe(2);
    assertEveryoneAssignedOnce(fixture.participants, result.teams);
  });

  it('reports H4 without crashing when everyone rates themselves 1 on all four axes', () => {
    const fixture = makeFixture({ count: 24, seed: 11, allSkillsAt: 1, laptopRate: 0.8 });
    const result = run(fixture, 11);

    const h4 = result.violations.find((v) => v.code === 'H4');
    expect(h4).toBeDefined();
    expect(h4?.scope).toBe('pool');
    expect(h4?.message).toContain(`${result.stats.team_count} teams are made up entirely of people`);
    expect(result.violations.some((v) => v.code === 'H3')).toBe(true);
    assertEveryoneAssignedOnce(fixture.participants, result.teams);
    assertSizesWithin(result.teams, P);
    expect(Number.isFinite(result.score.weighted_total)).toBe(true);
  });
});

describe('solve — sizing', () => {
  it('keeps 43 people at a target of 4 inside the size bounds, everyone placed once', () => {
    const fixture = makeFixture({ count: 43, seed: 9, laptopRate: 0.85, spread: 'wide' });
    const result = run(fixture, 9);
    assertEveryoneAssignedOnce(fixture.participants, result.teams);
    assertSizesWithin(result.teams, P);
    expect(result.teams.reduce((a, t) => a + t.member_ids.length, 0)).toBe(43);
    expect(result.violations.filter((v) => v.code === 'H1')).toEqual([]);
  });

  it('handles awkward totals from 3 to 60 without a single size breach', () => {
    for (let n = 3; n <= 60; n++) {
      const fixture = makeFixture({ count: n, seed: 100 + n, spread: 'wide' });
      const result = run(fixture, n);
      assertEveryoneAssignedOnce(fixture.participants, result.teams);
      assertSizesWithin(result.teams, P);
    }
  });
});

describe('solve — determinism', () => {
  it('is byte-identical for the same seed and input', () => {
    const fixture = makeFixture({ count: 61, seed: 8, spread: 'wide' });
    const a = run(fixture, 4242);
    const b = run(fixture, 4242);
    expect(a.teams).toEqual(b.teams);
    expect(a.score).toEqual(b.score);
    expect(a.violations).toEqual(b.violations);
    expect(JSON.stringify(a.teams)).toBe(JSON.stringify(b.teams));
    expect(JSON.stringify(a.score)).toBe(JSON.stringify(b.score));
  });

  it('does not depend on the order participants arrive in', () => {
    const fixture = makeFixture({ count: 44, seed: 17, spread: 'wide' });
    const reversed = { participants: [...fixture.participants].reverse(), themes: fixture.themes };
    expect(run(reversed, 555).teams).toEqual(run(fixture, 555).teams);
  });

  it('still produces a valid arrangement under a different seed', () => {
    const fixture = makeFixture({ count: 48, seed: 23, laptopRate: 0.9, spread: 'wide' });
    for (const seed of [1, 2, 3, 99, 123456]) {
      const result = run(fixture, seed);
      assertEveryoneAssignedOnce(fixture.participants, result.teams);
      assertSizesWithin(result.teams, P);
      expect(result.violations, `seed ${seed}`).toEqual([]);
    }
  });
});

describe('solve — edge cases', () => {
  it('returns an empty result for zero participants', () => {
    const result = solve({ participants: [], themes: [], params: P, seed: 1 });
    expect(result.teams).toEqual([]);
    expect(result.violations).toEqual([]);
    expect(result.stats.team_count).toBe(0);
    expect(result.stats.attending_count).toBe(0);
    expect(result.score.weighted_total).toBe(0);
  });

  it('makes one group when there are fewer people than the minimum team size, and says so', () => {
    const fixture = makeFixture({ count: 2, seed: 2 });
    const result = run(fixture, 2);
    expect(result.teams).toHaveLength(1);
    expect(result.teams[0]?.member_ids).toHaveLength(2);
    const h1 = result.violations.find((v) => v.code === 'H1' && v.scope === 'pool');
    expect(h1?.message).toContain('fewer than the minimum team size of 3');
  });

  it('ignores theme ids that do not exist and still places everyone', () => {
    const participants = makeParticipants({ count: 20, seed: 4, spread: 'wide' });
    const themes: Theme[] = [
      { label: 'Real', summary: 'Half the room', participant_ids: participants.slice(0, 10).map((p) => p.id) },
      { label: 'Ghosts', summary: 'Invented ids', participant_ids: ['nobody-1', 'nobody-2'] },
    ];
    const result = solve({ participants, themes, params: P, seed: 4 });
    assertEveryoneAssignedOnce(participants, result.teams);
    expect(result.teams.flatMap((t) => t.member_ids)).not.toContain('nobody-1');
  });

  it('puts participants no theme mentions into a Mixed bucket', () => {
    const participants = makeParticipants({ count: 21, seed: 6, spread: 'wide' });
    const themes: Theme[] = [
      {
        label: 'Invoice handling',
        summary: 'Supplier invoices keyed by hand',
        participant_ids: participants.slice(0, 12).map((p) => p.id),
      },
    ];
    const result = solve({ participants, themes, params: P, seed: 6 });
    assertEveryoneAssignedOnce(participants, result.teams);
    expect(result.teams.some((t) => t.theme_label === 'Mixed')).toBe(true);
  });

  it('copes with no themes at all', () => {
    const participants = makeParticipants({ count: 25, seed: 8, spread: 'wide' });
    const result = solve({ participants, themes: [], params: P, seed: 8 });
    assertEveryoneAssignedOnce(participants, result.teams);
    assertSizesWithin(result.teams, P);
  });

  it('copes with a room where every participant is identical', () => {
    const participants = makeParticipants({ count: 24, seed: 1, allSkillsAt: 3, laptopRate: 1, noDepartments: true });
    const result = solve({ participants, themes: [], params: P, seed: 1 });
    assertEveryoneAssignedOnce(participants, result.teams);
    assertSizesWithin(result.teams, P);
    expect(result.violations).toEqual([]);
    expect(result.score.skill_diversity).toBe(0);
    expect(result.score.across_team_balance).toBe(0);
  });
});

describe('solve — toggles and stats', () => {
  it('still reports violations when enforcement is switched off', () => {
    const relaxed: SolverParams = {
      ...P,
      constraints: { enforce_laptops: false, enforce_builder: false, enforce_not_all_novice: false },
    };
    const fixture = makeFixture({ count: 30, seed: 31, laptopRate: 0.2 });
    const result = run(fixture, 31, relaxed);
    expect(result.violations.some((v) => v.code === 'H2')).toBe(true);
    assertEveryoneAssignedOnce(fixture.participants, result.teams);
  });

  it('fills the stats in honestly', () => {
    const fixture = makeFixture({ count: 40, seed: 12, spread: 'wide' });
    const result = run(fixture, 12);
    expect(result.stats.team_count).toBe(result.teams.length);
    expect(result.stats.attending_count).toBe(40);
    expect(result.stats.local_search_iterations).toBeGreaterThan(0);
    expect(result.stats.local_search_iterations).toBeLessThanOrEqual(P.max_local_search_iterations);
    expect(result.stats.local_search_improvements).toBeGreaterThanOrEqual(0);
    expect(result.stats.repair_swaps).toBeGreaterThanOrEqual(0);
    expect(result.stats.duration_ms).toBeGreaterThanOrEqual(0);
  });

  it('stops early once local search has run out of ideas', () => {
    const patient: SolverParams = { ...P, max_local_search_iterations: 100000, local_search_patience: 50 };
    const fixture = makeFixture({ count: 24, seed: 3, allSkillsAt: 3, laptopRate: 1 });
    const result = run(fixture, 3, patient);
    expect(result.stats.local_search_iterations).toBeLessThan(100000);
  });

  it('never lowers the soft score below what the draft produced', () => {
    const fixture = makeFixture({ count: 52, seed: 19, spread: 'wide' });
    const noSearch: SolverParams = { ...P, max_local_search_iterations: 0 };
    const before = run(fixture, 19, noSearch).score.weighted_total;
    const after = run(fixture, 19).score.weighted_total;
    expect(after).toBeGreaterThanOrEqual(before);
  });
});

describe('solve — scale', () => {
  it('handles 150 participants well inside the CPU budget', () => {
    const fixture = makeFixture({ count: 150, seed: 77, laptopRate: 0.75 });
    const startedAt = Date.now();
    const result = run(fixture, 77);
    const elapsed = Date.now() - startedAt;
    console.log(
      `solve(150 participants) -> ${result.teams.length} teams in ${elapsed}ms ` +
        `(reported ${result.stats.duration_ms}ms, ${result.stats.local_search_iterations} iterations, ` +
        `${result.stats.local_search_improvements} improvements, ${result.stats.repair_swaps} repair swaps)`,
    );
    expect(elapsed).toBeLessThan(3000);
    assertEveryoneAssignedOnce(fixture.participants, result.teams);
    assertSizesWithin(result.teams, P);
  });
});

describe('solve — invariants across many seeds', () => {
  it('always assigns everyone exactly once and never exceeds max_team_size', () => {
    for (let i = 0; i < 30; i++) {
      const count = 12 + ((i * 13) % 90);
      const fixture = makeFixture({
        count,
        seed: i + 1,
        laptopRate: 0.2 + (i % 8) * 0.1,
        spread: i % 2 === 0 ? 'low' : 'wide',
      });
      const result = run(fixture, i * 977 + 1);
      const label = `n=${count} seed=${i * 977 + 1}`;

      const ids = result.teams.flatMap((t) => t.member_ids);
      expect(ids.length, label).toBe(count);
      expect(new Set(ids).size, label).toBe(count);
      for (const t of result.teams) {
        expect(t.member_ids.length, `${label} team ${t.index + 1}`).toBeLessThanOrEqual(P.max_team_size);
      }
      expect(result.teams.map((t) => t.index)).toEqual(result.teams.map((_, k) => k));
      expect(Number.isFinite(result.score.weighted_total), label).toBe(true);
    }
  });
});

describe('theme buckets', () => {
  it('tokenizes past stopwords and scores overlap with Jaccard', () => {
    expect([...tokenize('The monthly Reporting pack, for our team!')].sort()).toEqual([
      'monthly',
      'pack',
      'reporting',
    ]);
    expect(jaccard(tokenize('invoice processing'), tokenize('invoice processing'))).toBe(1);
    expect(jaccard(tokenize('invoice processing'), tokenize('rota scheduling'))).toBe(0);
    expect(jaccard(tokenize(''), tokenize('anything'))).toBe(0);
  });

  it('merges a too-small theme into the one it shares wording with, not the biggest one', () => {
    const participants = makeParticipants({ count: 24, seed: 2, spread: 'wide' });
    const ids = participants.map((p) => p.id);
    const themes: Theme[] = [
      {
        label: 'Rota scheduling',
        summary: 'Building weekly rotas around leave and site coverage',
        participant_ids: ids.slice(0, 14),
      },
      {
        label: 'Invoice processing',
        summary: 'Supplier invoices keyed by hand into finance systems',
        participant_ids: ids.slice(14, 22),
      },
      {
        // Two members, below min_team_size, so it has to be merged somewhere.
        label: 'Invoice queries',
        summary: 'Chasing supplier invoices that finance has queried',
        participant_ids: ids.slice(22, 24),
      },
    ];
    const buckets = buildBuckets(participants, themes, computeTeamCount(24, P), P);
    expect(buckets.map((b) => b.label)).toEqual(['Rota scheduling', 'Invoice processing']);
    const invoices = buckets.find((b) => b.label === 'Invoice processing')!;
    expect(invoices.member_ids).toHaveLength(10);
    expect(invoices.member_ids).toContain(ids[22]);
  });

  it('never leaves more themes than teams, and hands every bucket at least one team', () => {
    const participants = makeParticipants({ count: 12, seed: 3, spread: 'wide' });
    const themes: Theme[] = participants.map((p, i) => ({
      label: `Theme ${i}`,
      summary: `Distinct wording number ${i}`,
      participant_ids: [p.id],
    }));
    const teamCount = computeTeamCount(12, P);
    const buckets = buildBuckets(participants, themes, teamCount, P);
    expect(buckets.length).toBeLessThanOrEqual(teamCount);
    expect(buckets.every((b) => b.slots >= 1)).toBe(true);
    expect(buckets.reduce((a, b) => a + b.slots, 0)).toBe(teamCount);
    expect(buckets.flatMap((b) => b.member_ids).sort()).toEqual(participants.map((p) => p.id).sort());
  });

  it('splits a theme bigger than max_team_size across several teams', () => {
    const participants = makeParticipants({ count: 30, seed: 4, spread: 'wide' });
    const ids = participants.map((p) => p.id);
    const themes: Theme[] = [
      { label: 'Big', summary: 'Most of the room', participant_ids: ids.slice(0, 22) },
      { label: 'Small', summary: 'A separate concern entirely', participant_ids: ids.slice(22) },
    ];
    const buckets = buildBuckets(participants, themes, computeTeamCount(30, P), P);
    const big = buckets.find((b) => b.label === 'Big')!;
    expect(big.slots).toBeGreaterThanOrEqual(Math.ceil(22 / P.max_team_size));
    expect(big.team_indexes).toHaveLength(big.slots);
  });
});
