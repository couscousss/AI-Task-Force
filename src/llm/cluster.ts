/**
 * Clustering call (§6.2). The model reads problem statements and nothing else: no names,
 * no emails, no skill scores, no laptop answers. The payload is built by the explicit
 * projection in `toPayload()` so a wider object can never be handed to it by accident.
 *
 * Every failure path — missing key, network, 429, timeout, malformed output after two
 * retries — ends in `clusterByCategory()` with a warning. The event does not depend on
 * this call succeeding.
 */

import type Anthropic from '@anthropic-ai/sdk';
import * as z from 'zod/v4';
import { CATEGORIES, categoryLabel } from '../config';
import type { Theme } from '../grouping/types';
import type { LlmClient } from './client';

/** The only fields that leave the database for the clustering call. */
export interface ClusterCandidate {
  id: string;
  problem_statement: string | null;
  category: string | null;
}

export interface ClusterOutcome {
  themes: Theme[];
  warnings: string[];
  source: 'llm' | 'category';
}

/** Long statements are truncated for the call only; D1 keeps the full text. */
const MAX_STATEMENT_CHARS = 600;
const MAX_ATTEMPTS = 3;
/** Keep fed-back error strings bounded so a retry prompt cannot balloon. */
const MAX_IDS_IN_ERROR = 12;

const ClusterSchema = z.object({
  themes: z.array(
    z.object({
      label: z.string(),
      summary: z.string(),
      participant_ids: z.array(z.string()),
    }),
  ),
});

type ClusterResponse = z.infer<typeof ClusterSchema>;

const SYSTEM = [
  'You group short descriptions of work problems into themes for a one-day internal event',
  'where small teams build something with AI.',
  '',
  'A good theme is a shared problem four or five people could plausibly work on together:',
  'specific enough to start building, broad enough to hold several statements.',
  'Label each theme in four words or fewer. Summarise it in one sentence that names the',
  'shared problem, not the technology.',
  '',
  'You are not assigning people to teams and you are not judging anyone. You only decide',
  'which problem statements belong together.',
  '',
  'Rules, all of which are checked before your answer is used:',
  '- Every id given to you appears in exactly one theme.',
  '- No id that was not given to you appears anywhere.',
  '- Every theme has at least one id.',
].join('\n');

export function theoreticalThemeBounds(n: number): { min: number; max: number } {
  const min = Math.max(1, Math.ceil(n / 12));
  const max = Math.max(min, Math.ceil(n / 3));
  return { min, max };
}

/**
 * Everything §6.2 requires, as quotable sentences: they are shown to an organizer and
 * fed straight back to the model on the retry.
 */
export function validateThemes(response: ClusterResponse, inputIds: string[]): string[] {
  const errors: string[] = [];
  const themes = response.themes ?? [];
  const n = inputIds.length;
  const { min, max } = theoreticalThemeBounds(n);

  if (themes.length < min || themes.length > max) {
    errors.push(
      `You returned ${themes.length} themes. For ${n} problem statements the answer must have between ${min} and ${max} themes.`,
    );
  }

  const known = new Set(inputIds);
  const seen = new Set<string>();
  const duplicated = new Set<string>();
  const invented = new Set<string>();

  themes.forEach((theme, i) => {
    if (theme.label.trim() === '') errors.push(`Theme ${i + 1} has an empty label. Every theme needs a short label.`);
    if (theme.summary.trim() === '') errors.push(`Theme ${i + 1} ("${theme.label}") has an empty summary.`);
    if (theme.participant_ids.length === 0) {
      errors.push(`Theme ${i + 1} ("${theme.label}") has no participant ids. Every theme must contain at least one id.`);
    }
    for (const id of theme.participant_ids) {
      if (!known.has(id)) invented.add(id);
      else if (seen.has(id)) duplicated.add(id);
      else seen.add(id);
    }
  });

  const missing = inputIds.filter((id) => !seen.has(id));
  if (missing.length > 0) {
    errors.push(`These ids were left out and must each appear in exactly one theme: ${list(missing)}.`);
  }
  if (duplicated.size > 0) {
    errors.push(`These ids appeared in more than one theme and must appear in exactly one: ${list([...duplicated])}.`);
  }
  if (invented.size > 0) {
    errors.push(`These ids were not in the input and must not appear at all: ${list([...invented])}.`);
  }
  return errors;
}

function list(ids: string[]): string {
  const shown = ids.slice(0, MAX_IDS_IN_ERROR);
  const rest = ids.length - shown.length;
  return rest > 0 ? `${shown.join(', ')} and ${rest} more` : shown.join(', ');
}

/** Explicit projection: this is the entire payload the model receives. */
function toPayload(candidates: ClusterCandidate[]): { id: string; problem_statement: string; category: string }[] {
  return candidates.map((c) => ({
    id: c.id,
    problem_statement: statementFor(c),
    category: categoryLabel(c.category),
  }));
}

function statementFor(c: ClusterCandidate): string {
  const text = (c.problem_statement ?? '').trim();
  if (text === '') return `(no problem statement given; they chose "${categoryLabel(c.category)}")`;
  if (text.length <= MAX_STATEMENT_CHARS) return text;
  return `${text.slice(0, MAX_STATEMENT_CHARS).trimEnd()}…`;
}

function firstUserMessage(candidates: ClusterCandidate[]): string {
  const { min, max } = theoreticalThemeBounds(candidates.length);
  return [
    `Here are ${candidates.length} problem statements. Group them into between ${min} and ${max} themes.`,
    'Put every id in exactly one theme.',
    '',
    JSON.stringify(toPayload(candidates)),
  ].join('\n');
}

/**
 * Deterministic fallback: group by the category each person picked. Pure, so the pipeline
 * can call it directly when there is no API key and the tests can exercise it alone.
 */
export function clusterByCategory(candidates: ClusterCandidate[]): Theme[] {
  const buckets = new Map<string, string[]>();
  for (const c of candidates) {
    const key = c.category ?? '';
    const bucket = buckets.get(key);
    if (bucket) bucket.push(c.id);
    else buckets.set(key, [c.id]);
  }
  const order = new Map(CATEGORIES.map((c, i) => [c.value, i]));
  return [...buckets.entries()]
    .sort((a, b) => {
      const ra = order.get(a[0]) ?? CATEGORIES.length;
      const rb = order.get(b[0]) ?? CATEGORIES.length;
      return ra - rb || a[0].localeCompare(b[0]);
    })
    .map(([key, ids]) => ({
      label: categoryLabel(key === '' ? null : key),
      summary: `Everyone who said they want to work on: ${categoryLabel(key === '' ? null : key).toLowerCase()}.`,
      participant_ids: [...ids].sort(),
    }));
}

export async function clusterProblemStatements(
  llm: LlmClient | null,
  candidates: ClusterCandidate[],
): Promise<ClusterOutcome> {
  if (candidates.length === 0) return { themes: [], warnings: [], source: 'category' };

  if (!llm) {
    return {
      themes: clusterByCategory(candidates),
      source: 'category',
      warnings: [
        'No ANTHROPIC_API_KEY is set, so themes came from the category each person picked rather than from their problem statements. Set the key with `wrangler secret put ANTHROPIC_API_KEY` and start a new run to cluster properly.',
      ],
    };
  }

  const inputIds = candidates.map((c) => c.id);
  const messages: Anthropic.MessageParam[] = [
    { role: 'user', content: firstUserMessage(candidates) },
  ];
  let lastProblem = 'the model did not return a usable answer';

  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
    const result = await llm.parse({ schema: ClusterSchema, system: SYSTEM, messages });
    if (!result.ok) {
      // Transport-level failures (429, timeout, bad key) will not be fixed by rephrasing.
      lastProblem = result.error;
      break;
    }
    const errors = validateThemes(result.value, inputIds);
    if (errors.length === 0) {
      return { themes: normalize(result.value, inputIds), warnings: [], source: 'llm' };
    }
    lastProblem = errors.join(' ');
    if (attempt === MAX_ATTEMPTS) break;
    messages.push(
      { role: 'assistant', content: JSON.stringify(result.value) },
      {
        role: 'user',
        content: [
          'That answer was rejected by the checks:',
          ...errors.map((e) => `- ${e}`),
          '',
          'Return the corrected grouping for the same ids.',
        ].join('\n'),
      },
    );
  }

  return {
    themes: clusterByCategory(candidates),
    source: 'category',
    warnings: [
      `Themes came from the category each person picked, not from their problem statements: ${lastProblem} Teams are still balanced and valid — start a new run if you want to try the clustering again.`,
    ],
  };
}

/** Validated output, made order-independent so the same run re-runs identically. */
function normalize(response: ClusterResponse, inputIds: string[]): Theme[] {
  const rank = new Map(inputIds.map((id, i) => [id, i]));
  return response.themes.map((t) => ({
    label: t.label.trim(),
    summary: t.summary.trim(),
    participant_ids: [...t.participant_ids].sort((a, b) => (rank.get(a) ?? 0) - (rank.get(b) ?? 0)),
  }));
}
