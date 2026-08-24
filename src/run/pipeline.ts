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
import { failRun, getRun, parseParams, saveRunResult, setRunProgress } from '../db/runs';
import type { Env } from '../env';
import { solve } from '../grouping';
import type { SolverParticipant, Theme } from '../grouping/types';
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

    // 2. Solve. Deterministic, seeded, and the only thing that decides who is with whom.
    await setRunProgress(db, runId, 'solving', 'Balancing teams');
    const participants: SolverParticipant[] = rows.map(toSolverParticipant);
    const themes: Theme[] = clustered.themes;
    const result = solve({ participants, themes, params, seed: run.seed });

    if (result.teams.length === 0) {
      await failRun(
        db,
        runId,
        `No team could be formed from ${n} people with team sizes set to ${params.min_team_size}-${params.max_team_size}. Widen the team size bounds and start a new run.`,
      );
      return;
    }

    // 3. Name. The teams above are already final; this call only writes words.
    await setRunProgress(db, runId, 'naming', `Naming ${result.teams.length} teams`);
    const byId = new Map<string, ParticipantRow>(rows.map((r) => [r.id, r]));
    const narrateInput: NarrateTeam[] = result.teams.map((t) => ({
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
    }));
    const narrated = await narrateTeams(llm, narrateInput);
    warnings.push(...narrated.warnings);

    // 4. Persist. One batch, so the run either has all its teams or none of them.
    await saveRunResult(
      db,
      runId,
      result.teams,
      narrated.narratives,
      clustered.themes,
      result.score,
      result.violations,
      warnings,
    );
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
