import { expect } from 'vitest';
import { SKILL_AXES } from '../src/config';
import type { SolverParams } from '../src/config';
import { createRng } from '../src/grouping/prng';
import type { SolvedTeam, SolverParticipant, Theme } from '../src/grouping/types';
import type { SkillVector } from '../src/types';

/**
 * Seeded fixture generator. Everything here is a pure function of `seed`, so a failing
 * test can be reproduced exactly from the seed printed in its name.
 */

export interface ThemeTemplate {
  label: string;
  summary: string;
  category: string;
}

/** Stand-ins for the templated problem statements the LLM would have clustered. */
export const THEME_TEMPLATES: ThemeTemplate[] = [
  {
    label: 'Invoice and purchase order handling',
    summary: 'Manual keying of supplier invoices and purchase orders between finance systems.',
    category: 'automate',
  },
  {
    label: 'Finding answers in policy documents',
    summary: 'Staff cannot locate the current policy or contract clause without asking a colleague.',
    category: 'search',
  },
  {
    label: 'Monthly reporting packs',
    summary: 'Assembling the monthly operations report by hand from four different exports.',
    category: 'analysis',
  },
  {
    label: 'Answering resident enquiries',
    summary: 'Repetitive front-line enquiries that could be answered by a guided self-service tool.',
    category: 'product',
  },
  {
    label: 'Drafting recurring correspondence',
    summary: 'Writing similar letters, briefings and case notes from scratch every week.',
    category: 'content',
  },
  {
    label: 'Cleaning up messy spreadsheets',
    summary: 'Reconciling inconsistent spreadsheet exports before any analysis can start.',
    category: 'analysis',
  },
  {
    label: 'Onboarding new starters',
    summary: 'New joiners repeat the same questions because the induction material is scattered.',
    category: 'search',
  },
  {
    label: 'Scheduling and rota juggling',
    summary: 'Building weekly rotas around leave, skills and site coverage by hand.',
    category: 'automate',
  },
];

export const DEPARTMENTS = [
  'Finance',
  'Operations',
  'Customer Services',
  'People',
  'Digital',
  'Housing',
  'Legal',
];

export interface FixtureOptions {
  count: number;
  seed?: number;
  /** Share of participants who can bring a laptop. Default 0.7, matching the spec. */
  laptopRate?: number;
  /** If set, exactly round(count * builderRate) people rate 3+ on Building; everyone else 1-2. */
  builderRate?: number;
  /** If set, every axis of every participant is pinned to this value. */
  allSkillsAt?: number;
  /** Widen the skew: 'low' (default, realistic) or 'wide' (a genuinely mixed room). */
  spread?: 'low' | 'wide';
  themeCount?: number;
  /** Leave department null for everyone, to exercise the missing-data path. */
  noDepartments?: boolean;
}

export interface Fixture {
  participants: SolverParticipant[];
  themes: Theme[];
}

/** Skills skewed low, the way a real self-assessment comes back. */
const LOW_WEIGHTS = [0.3, 0.3, 0.2, 0.13, 0.07];
const WIDE_WEIGHTS = [0.18, 0.22, 0.24, 0.22, 0.14];

function pickSkill(r: number, weights: readonly number[]): number {
  let acc = 0;
  for (let i = 0; i < weights.length; i++) {
    acc += weights[i] ?? 0;
    if (r < acc) return i + 1;
  }
  return weights.length;
}

export function makeParticipants(opts: FixtureOptions): SolverParticipant[] {
  const rng = createRng(opts.seed ?? 1);
  const count = Math.max(0, Math.floor(opts.count));
  const laptopRate = opts.laptopRate ?? 0.7;
  const weights = opts.spread === 'wide' ? WIDE_WEIGHTS : LOW_WEIGHTS;
  const builderQuota =
    opts.builderRate === undefined ? null : Math.round(count * Math.min(1, Math.max(0, opts.builderRate)));

  const out: SolverParticipant[] = [];
  for (let i = 0; i < count; i++) {
    const skills = {} as SkillVector;
    for (const axis of SKILL_AXES) {
      skills[axis] = opts.allSkillsAt !== undefined ? opts.allSkillsAt : pickSkill(rng.next(), weights);
    }
    if (builderQuota !== null) {
      // Deterministic: the first `builderQuota` people are the builders.
      skills.building = i < builderQuota ? 3 + (i % 3 === 0 ? 1 : 0) : 1 + (i % 2);
    }
    out.push({
      // Zero-padded so lexicographic id order matches creation order — the solver's
      // tie-breaks are on id, and a fixture should not accidentally shuffle them.
      id: `p${String(i).padStart(4, '0')}`,
      name: `Participant ${i + 1}`,
      department: opts.noDepartments ? null : (DEPARTMENTS[i % DEPARTMENTS.length] ?? null),
      category: null,
      skills,
      has_laptop: rng.next() < laptopRate,
    });
  }
  return out;
}

/**
 * Cluster the fixture participants into templated themes, mimicking a well-behaved
 * LLM response: every id appears exactly once and no invented ids.
 */
export function makeThemes(participants: readonly SolverParticipant[], themeCount: number, seed = 7): Theme[] {
  const n = Math.max(1, Math.min(themeCount, THEME_TEMPLATES.length));
  const rng = createRng(seed);
  const groups: string[][] = Array.from({ length: n }, () => []);
  for (const p of participants) {
    const g = rng.int(n);
    groups[g]!.push(p.id);
  }
  return groups
    .map((ids, i) => {
      const tpl = THEME_TEMPLATES[i]!;
      return { label: tpl.label, summary: tpl.summary, participant_ids: ids };
    })
    .filter((t) => t.participant_ids.length > 0);
}

export function makeFixture(opts: FixtureOptions): Fixture {
  const participants = makeParticipants(opts);
  const themeCount = opts.themeCount ?? Math.min(THEME_TEMPLATES.length, Math.max(1, Math.ceil(opts.count / 8)));
  const themes = makeThemes(participants, themeCount, (opts.seed ?? 1) + 1000);
  // Give everyone the category of the theme they landed in, the way the form would.
  const categoryOf = new Map<string, string>();
  themes.forEach((t) => {
    const tpl = THEME_TEMPLATES.find((x) => x.label === t.label);
    for (const id of t.participant_ids) categoryOf.set(id, tpl?.category ?? 'unsure');
  });
  for (const p of participants) p.category = categoryOf.get(p.id) ?? 'unsure';
  return { participants, themes };
}

// --- reusable assertions ---------------------------------------------------

/** The invariant that must hold in every single solver test. */
export function assertEveryoneAssignedOnce(
  participants: readonly SolverParticipant[],
  teams: readonly SolvedTeam[],
): void {
  const seen = new Map<string, number>();
  for (const t of teams) {
    for (const id of t.member_ids) seen.set(id, (seen.get(id) ?? 0) + 1);
  }
  const duplicated = [...seen.entries()].filter(([, c]) => c > 1).map(([id]) => id);
  expect(duplicated, 'participants appearing on more than one team').toEqual([]);
  const missing = participants.map((p) => p.id).filter((id) => !seen.has(id));
  expect(missing, 'participants missing from every team').toEqual([]);
  const invented = [...seen.keys()].filter((id) => !participants.some((p) => p.id === id));
  expect(invented, 'team members who are not in the participant list').toEqual([]);
}

export function assertSizesWithin(teams: readonly SolvedTeam[], params: SolverParams): void {
  for (const t of teams) {
    expect(t.member_ids.length, `team ${t.index + 1} size`).toBeGreaterThanOrEqual(params.min_team_size);
    expect(t.member_ids.length, `team ${t.index + 1} size`).toBeLessThanOrEqual(params.max_team_size);
  }
}

export function countBuilders(participants: readonly SolverParticipant[], threshold: number): number {
  return participants.filter((p) => p.skills.building >= threshold).length;
}
