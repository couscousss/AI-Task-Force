/**
 * The grouping run (§6.1, §6.6). The route writes a `pending` row, returns the id, and
 * hands this to `ctx.waitUntil()`; the admin page polls the run row, so every step
 * updates `progress` with something an organizer can read.
 *
 * Nothing is written to `teams` until the whole pipeline has succeeded — a failed run
 * leaves a `failed` row with a message and no half-built teams.
 */

import { DEFAULT_SOLVER_PARAMS, loadConfig } from '../config';
import { listAttendingSubmitted, toSolverParticipant } from '../db/participants';
import {
  failRun,
  getRun,
  parseParams,
  parseThemes,
  saveClusterStage,
  saveRunResult,
  setRunProgress,
} from '../db/runs';
import type { Env } from '../env';
import { evaluateArrangement } from '../grouping';
import type { SolverParams, SolverParticipant, Theme } from '../grouping/types';
import { createLlmClient } from '../llm/client';
import { clusterProblemStatements, type ClusterCandidate } from '../llm/cluster';
import { firstNameOf, narrateTeams, type NarrateTeam } from '../llm/narrate';
import type { ParticipantRow } from '../types';

export async function executeRun(env: Env, runId: string): Promise<void> {
  const db = env.DB;
  try {
    const run = await getRun(db, runId);
    if (!run) return;
    // Runs are immutable history: only the row the route just created is ours to advance.
    if (run.status !== 'pending') return;

    const config = loadConfig(env);
    const params = parseParams(run, DEFAULT_SOLVER_PARAMS);
    const rows = await listAttendingSubmitted(db);
    const n = rows.length;

    if (n === 0) {
      await failRun(
        db,
        runId,
        'Nobody has both confirmed they are attending and completed the form, so there is nobody to group. Send the invites or add walk-ins on the Participants page, then start a new run.',
      );
      return;
    }
    if (n < params.min_team_size) {
      await failRun(
        db,
        runId,
        `Only ${n === 1 ? '1 person has' : `${n} people have`} confirmed and completed the form, and a team needs at least ${params.min_team_size}. Add walk-ins on the Participants page or lower the minimum team size, then start a new run.`,
      );
      return;
    }

    const llm = createLlmClient(env, config);
    const warnings: string[] = [];

    // 1. Cluster. Free text only — no names, emails or skill scores leave this projection.
    await setRunProgress(db, runId, 'clustering', `Clustering ${n} problem statement${n === 1 ? '' : 's'}`);
    const candidates: ClusterCandidate[] = rows.map((r) => ({
      id: r.id,
      problem_statement: r.problem_statement,
      category: r.category,
    }));
    const clustered = await clusterProblemStatements(llm, candidates);
    warnings.push(...clustered.warnings);

    // 2. Hand the balancing step to the browser and stop here.
    //
    // The solver needs 12-60ms of CPU depending on the pool, and a Worker on the free
    // plan is cut off at 10ms per request. It is a pure module with no database or
    // network access inside it, so it runs identically in the organizer's browser from
    // the same seeded input — same seed, same teams. The Worker keeps the parts that are
    // I/O rather than computation: clustering, naming, and writing the result.
    await saveClusterStage(db, runId, clustered.themes, warnings);
  } catch (err) {
    const detail = err instanceof Error ? err.message : String(err);
    await failRun(
      db,
      runId,
      `The run stopped before it finished: ${detail}. No teams were saved. Start a new run, and export the participants to CSV if you need to group by hand.`,
    ).catch(() => {
      // The run row is unreachable; there is nothing further this Worker can do about it.
    });
  }
}

/** What the browser needs in order to run the solver itself. */
export interface SolveInput {
  participants: SolverParticipant[];
  themes: Theme[];
  params: SolverParams;
  seed: number;
}

export async function getSolveInput(env: Env, runId: string): Promise<SolveInput | null> {
  const db = env.DB;
  const run = await getRun(db, runId);
  if (!run || run.status !== 'awaiting_solve') return null;
  const rows = await listAttendingSubmitted(db);
  return {
    participants: rows.map(toSolverParticipant),
    themes: parseThemes(run).themes,
    params: parseParams(run, DEFAULT_SOLVER_PARAMS),
    seed: run.seed,
  };
}

export interface SolvedTeamInput {
  index: number;
  theme_label: string;
  theme_summary: string;
  member_ids: string[];
}

/**
 * Take the arrangement the browser produced, then name and persist it.
 *
 * The membership is checked here rather than trusted, and the score and violations are
 * recomputed on the server — that only costs about 0.15ms, and it means the numbers an
 * organizer reads always come from this code rather than from whatever the page sent.
 */
export async function finishRun(
  env: Env,
  runId: string,
  teams: SolvedTeamInput[],
  themeOf: Record<string, string>,
): Promise<{ ok: true } | { ok: false; error: string }> {
  const db = env.DB;
  const run = await getRun(db, runId);
  if (!run) return { ok: false, error: 'That run no longer exists.' };
  if (run.status === 'done') return { ok: true };
  if (run.status !== 'awaiting_solve') {
    return { ok: false, error: `That run is ${run.status}, so it is not waiting for teams.` };
  }

  const config = loadConfig(env);
  const params = parseParams(run, DEFAULT_SOLVER_PARAMS);
  const rows = await listAttendingSubmitted(db);
  const known = new Set(rows.map((r) => r.id));

  const seen = new Set<string>();
  for (const t of teams) {
    for (const id of t.member_ids) {
      if (!known.has(id)) return { ok: false, error: 'The teams referred to somebody who is not in this run.' };
      if (seen.has(id)) return { ok: false, error: 'The teams put the same person on two teams.' };
      seen.add(id);
    }
  }
  if (teams.length === 0) {
    return {
      ok: false,
      error: `No team could be formed with team sizes set to ${params.min_team_size}-${params.max_team_size}. Widen the bounds and start a new run.`,
    };
  }

  const participants: SolverParticipant[] = rows.map(toSolverParticipant);
  const evaluation = evaluateArrangement(
    participants,
    teams.map((t) => ({ index: t.index, theme_label: t.theme_label, member_ids: t.member_ids })),
    params,
    themeOf,
  );

  const parsed = parseThemes(run);
  const warnings = [...parsed.warnings];
  if (seen.size < rows.length) {
    warnings.push(
      `${rows.length - seen.size} of ${rows.length} people were left off every team. Check the Unassigned column on the review board.`,
    );
  }

  await setRunProgress(db, runId, 'naming', `Naming ${teams.length} teams`);
  const llm = createLlmClient(env, config);
  const byId = new Map<string, ParticipantRow>(rows.map((r) => [r.id, r]));
  const narrated = await narrateTeams(
    llm,
    teams.map((t) => ({
      index: t.index,
      theme_label: t.theme_label,
      theme_summary: t.theme_summary,
      members: t.member_ids.map((id) => {
        const row = byId.get(id);
        return {
          display_name: firstNameOf(row?.name),
          problem_statement: row?.problem_statement ?? null,
        };
      }),
    })),
  );
  warnings.push(...narrated.warnings);

  await saveRunResult(
    db,
    runId,
    teams,
    narrated.narratives,
    parsed.themes,
    evaluation.score,
    evaluation.violations,
    warnings,
    themeOf,
  );
  return { ok: true };
}
