/**
 * Naming call. Runs after the solver, so the teams are already correct and final: this
 * step only writes words. It never reorders or reassigns anyone — it is handed team
 * indexes and must hand the same indexes back.
 *
 * Members are anonymised to first names before they leave the database. Any failure
 * falls back to `Team N` / the theme summary / no rationale, with a warning on the run.
 */

import type Anthropic from '@anthropic-ai/sdk';
import * as z from 'zod/v4';
import type { TeamNarrative } from '../db/runs';
import type { LlmClient } from './client';

export interface NarrateMember {
  /** First name, or "a participant" when we do not have one. Never an email. */
  display_name: string;
  problem_statement: string | null;
}

export interface NarrateTeam {
  /** The solver's team index. Carried through untouched. */
  index: number;
  theme_label: string;
  theme_summary: string;
  members: NarrateMember[];
}

export interface NarrateOutcome {
  narratives: Record<number, TeamNarrative>;
  warnings: string[];
}

const MAX_STATEMENT_CHARS = 400;
const MAX_NAME_CHARS = 60;
const MAX_ATTEMPTS = 2;

const NarrateSchema = z.object({
  teams: z.array(
    z.object({
      index: z.number(),
      name: z.string(),
      project_brief: z.string(),
      rationale: z.string(),
    }),
  ),
});

type NarrateResponse = z.infer<typeof NarrateSchema>;

const SYSTEM = [
  'You write the words that go on a team card for a one-day internal AI build event.',
  '',
  'For each team you are given a theme and the problems its members described. Return:',
  '- name: a short, plain, memorable team name. Four words at most. No puns about robots,',
  '  no all-caps, no emoji.',
  '- project_brief: one paragraph the team can read at 9am and start from. Name the shared',
  '  problem, suggest a concrete first thing to build, and keep it to what a group of four',
  '  can finish in a day.',
  '- rationale: one or two sentences on why these people are together, grounded in what',
  '  they wrote.',
  '',
  'The teams are already decided. Do not suggest moving anyone, do not comment on who',
  'should be on which team, and return every team index you were given exactly once.',
  'Write about the work, never about how capable anyone is.',
].join('\n');

/** "Priya Raman" -> "Priya". Anything that looks like an address is dropped entirely. */
export function firstNameOf(name: string | null | undefined): string {
  const trimmed = (name ?? '').trim();
  if (trimmed === '' || trimmed.includes('@')) return 'a participant';
  const first = trimmed.split(/\s+/)[0] ?? '';
  return first === '' ? 'a participant' : first;
}

export function defaultNarrative(team: NarrateTeam): TeamNarrative {
  return {
    name: `Team ${team.index + 1}`,
    project_brief: team.theme_summary,
    rationale: '',
  };
}

function payload(teams: NarrateTeam[]): unknown {
  return teams.map((t) => ({
    index: t.index,
    theme: t.theme_label,
    theme_summary: t.theme_summary,
    members: t.members.map((m) => ({
      first_name: m.display_name,
      problem: truncate(m.problem_statement),
    })),
  }));
}

function truncate(text: string | null): string {
  const t = (text ?? '').trim();
  if (t === '') return '(no problem statement given)';
  return t.length <= MAX_STATEMENT_CHARS ? t : `${t.slice(0, MAX_STATEMENT_CHARS).trimEnd()}…`;
}

/** Returns the entries that are usable, plus a quotable error per entry that is not. */
function accept(
  response: NarrateResponse,
  teams: NarrateTeam[],
): { good: Map<number, TeamNarrative>; errors: string[] } {
  const wanted = new Map(teams.map((t) => [t.index, t]));
  const good = new Map<number, TeamNarrative>();
  const errors: string[] = [];

  for (const entry of response.teams ?? []) {
    if (!wanted.has(entry.index)) {
      errors.push(`Team index ${entry.index} was not in the input. Only return the indexes you were given.`);
      continue;
    }
    if (good.has(entry.index)) {
      errors.push(`Team index ${entry.index} appeared twice. Return each index exactly once.`);
      continue;
    }
    const name = entry.name.trim();
    const brief = entry.project_brief.trim();
    if (name === '' || name.length > MAX_NAME_CHARS) {
      errors.push(`Team ${entry.index}: the name must be present and at most ${MAX_NAME_CHARS} characters.`);
      continue;
    }
    if (brief === '') {
      errors.push(`Team ${entry.index}: the project brief was empty.`);
      continue;
    }
    good.set(entry.index, { name, project_brief: brief, rationale: entry.rationale.trim() });
  }

  return { good, errors };
}

export async function narrateTeams(llm: LlmClient | null, teams: NarrateTeam[]): Promise<NarrateOutcome> {
  const narratives: Record<number, TeamNarrative> = {};
  for (const t of teams) narratives[t.index] = defaultNarrative(t);
  if (teams.length === 0) return { narratives, warnings: [] };

  if (!llm) {
    return {
      narratives,
      warnings: [
        'Teams are numbered rather than named because no ANTHROPIC_API_KEY is set. You can type a name, brief and rationale for each team on the review screen.',
      ],
    };
  }

  const messages: Anthropic.MessageParam[] = [
    {
      role: 'user',
      content: [
        `Write a name, project brief and rationale for each of these ${teams.length} teams.`,
        'Return every index exactly once.',
        '',
        JSON.stringify(payload(teams)),
      ].join('\n'),
    },
  ];
  let lastProblem = 'the model did not return a usable answer';
  const named = new Set<number>();

  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
    const result = await llm.parse({ schema: NarrateSchema, system: SYSTEM, messages });
    if (!result.ok) {
      lastProblem = result.error;
      break;
    }
    const { good, errors } = accept(result.value, teams);
    for (const [index, narrative] of good) {
      narratives[index] = narrative;
      named.add(index);
    }
    // A partial answer still counts: anything named on an earlier attempt is kept.
    for (const t of teams) {
      if (!named.has(t.index)) errors.push(`Team ${t.index} is missing from the answer.`);
    }
    if (named.size === teams.length) return { narratives, warnings: [] };

    lastProblem = errors.join(' ');
    if (attempt === MAX_ATTEMPTS) break;
    const stillMissing = teams.filter((t) => !named.has(t.index));
    messages.push(
      { role: 'assistant', content: JSON.stringify(result.value) },
      {
        role: 'user',
        content: [
          'That answer was rejected by the checks:',
          ...errors.map((e) => `- ${e}`),
          '',
          `Return only these team indexes, corrected: ${stillMissing.map((t) => t.index).join(', ')}.`,
        ].join('\n'),
      },
    );
  }

  const unnamed = teams.length - named.size;
  return {
    narratives,
    warnings: [
      `${unnamed === teams.length ? 'No teams were' : `${unnamed} of ${teams.length} teams were not`} named by the model: ${lastProblem} The teams themselves are unaffected — you can type a name, brief and rationale on the review screen.`,
    ],
  };
}
