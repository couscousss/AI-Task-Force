import type { GroupingRunRow, RunStatus, TeamRow } from '../types';
import type { ScoreBreakdown, SolvedTeam, Theme, Violation } from '../grouping/types';
import type { SolverParams } from '../config';
import { newId, nowIso } from '../lib/ids';

export async function createRun(
  db: D1Database,
  params: SolverParams,
  seed: number,
): Promise<GroupingRunRow> {
  const row: GroupingRunRow = {
    id: newId(),
    status: 'pending',
    seed,
    params_json: JSON.stringify(params),
    themes_json: null,
    score_json: null,
    violations_json: null,
    error: null,
    progress: 'Queued',
    is_published: 0,
    created_at: nowIso(),
    completed_at: null,
  };
  await db
    .prepare(
      `INSERT INTO grouping_runs (id, status, seed, params_json, progress, is_published, created_at)
       VALUES (?, ?, ?, ?, ?, 0, ?)`,
    )
    .bind(row.id, row.status, row.seed, row.params_json, row.progress, row.created_at)
    .run();
  return row;
}

export async function setRunProgress(
  db: D1Database,
  id: string,
  status: RunStatus,
  progress: string,
): Promise<void> {
  await db
    .prepare(`UPDATE grouping_runs SET status = ?, progress = ? WHERE id = ?`)
    .bind(status, progress, id)
    .run();
}

export async function failRun(db: D1Database, id: string, error: string): Promise<void> {
  await db
    .prepare(
      `UPDATE grouping_runs SET status = 'failed', error = ?, progress = 'Failed', completed_at = ? WHERE id = ?`,
    )
    .bind(error.slice(0, 4000), nowIso(), id)
    .run();
}

/**
 * Park the clustering output and hand the balancing step to the organizer's browser.
 * Written before the solve so a reload, or a second tab, picks up exactly the same
 * input — the seed is already on the run, so the result is identical either way.
 */
export async function saveClusterStage(
  db: D1Database,
  runId: string,
  themes: Theme[],
  warnings: string[],
): Promise<void> {
  await db
    .prepare(
      `UPDATE grouping_runs SET status = 'awaiting_solve', progress = ?, themes_json = ? WHERE id = ?`,
    )
    .bind('Balancing teams in your browser', JSON.stringify({ themes, warnings }), runId)
    .run();
}

export async function getRun(db: D1Database, id: string): Promise<GroupingRunRow | null> {
  return db.prepare(`SELECT * FROM grouping_runs WHERE id = ?`).bind(id).first<GroupingRunRow>();
}

export async function listRuns(db: D1Database, limit = 50): Promise<GroupingRunRow[]> {
  const res = await db
    .prepare(`SELECT * FROM grouping_runs ORDER BY created_at DESC LIMIT ?`)
    .bind(limit)
    .all<GroupingRunRow>();
  return res.results ?? [];
}

export async function getPublishedRun(db: D1Database): Promise<GroupingRunRow | null> {
  return db.prepare(`SELECT * FROM grouping_runs WHERE is_published = 1`).first<GroupingRunRow>();
}

export interface TeamNarrative {
  name: string;
  project_brief: string;
  rationale: string;
}

/**
 * Write the solved teams. Runs are immutable history, so this only ever runs once per
 * run id, at the end of the pipeline.
 */
export async function saveRunResult(
  db: D1Database,
  runId: string,
  teams: SolvedTeam[],
  narratives: Record<number, TeamNarrative>,
  themes: Theme[],
  score: ScoreBreakdown,
  violations: Violation[],
  warnings: string[],
  themeOf: Record<string, string> = {},
): Promise<void> {
  const statements: D1PreparedStatement[] = [];
  for (const t of teams) {
    const teamId = newId();
    const n = narratives[t.index];
    statements.push(
      db
        .prepare(
          `INSERT INTO teams (id, run_id, name, theme_label, project_brief, rationale, sort_order)
           VALUES (?, ?, ?, ?, ?, ?, ?)`,
        )
        .bind(
          teamId,
          runId,
          n?.name ?? `Team ${t.index + 1}`,
          t.theme_label,
          n?.project_brief ?? t.theme_summary,
          n?.rationale ?? '',
          t.index,
        ),
    );
    for (const pid of t.member_ids) {
      statements.push(
        db
          .prepare(`INSERT INTO team_members (team_id, participant_id, is_manual_override) VALUES (?, ?, 0)`)
          .bind(teamId, pid),
      );
    }
  }
  statements.push(
    db
      .prepare(
        `UPDATE grouping_runs SET status = 'done', progress = ?, themes_json = ?, score_json = ?,
           violations_json = ?, completed_at = ? WHERE id = ?`,
      )
      .bind(
        `Done — ${teams.length} teams`,
        JSON.stringify({ themes, warnings, theme_of: themeOf }),
        JSON.stringify(score),
        JSON.stringify(violations),
        nowIso(),
        runId,
      ),
  );
  await db.batch(statements);
}

export interface TeamWithMembers {
  team: TeamRow;
  member_ids: string[];
  manual_overrides: Set<string>;
}

export async function getTeams(db: D1Database, runId: string): Promise<TeamWithMembers[]> {
  const teamsRes = await db
    .prepare(`SELECT * FROM teams WHERE run_id = ? ORDER BY sort_order, id`)
    .bind(runId)
    .all<TeamRow>();
  const teams = teamsRes.results ?? [];
  if (teams.length === 0) return [];
  const membersRes = await db
    .prepare(
      `SELECT tm.team_id, tm.participant_id, tm.is_manual_override
       FROM team_members tm JOIN teams t ON t.id = tm.team_id
       WHERE t.run_id = ?`,
    )
    .bind(runId)
    .all<{ team_id: string; participant_id: string; is_manual_override: number }>();

  const byTeam = new Map<string, { ids: string[]; manual: Set<string> }>();
  for (const t of teams) byTeam.set(t.id, { ids: [], manual: new Set() });
  for (const m of membersRes.results ?? []) {
    const bucket = byTeam.get(m.team_id);
    if (!bucket) continue;
    bucket.ids.push(m.participant_id);
    if (m.is_manual_override === 1) bucket.manual.add(m.participant_id);
  }
  return teams.map((team) => {
    const b = byTeam.get(team.id)!;
    return { team, member_ids: b.ids, manual_overrides: b.manual };
  });
}

export interface PublishedTeam {
  team: TeamRow;
  member_ids: string[];
}

/** The team a participant sits on in the published run, or null when there is none. */
export async function getPublishedTeamOf(
  db: D1Database,
  participantId: string,
): Promise<PublishedTeam | null> {
  const team = await db
    .prepare(
      `SELECT t.* FROM teams t
       JOIN team_members tm ON tm.team_id = t.id
       JOIN grouping_runs r ON r.id = t.run_id
       WHERE r.is_published = 1 AND tm.participant_id = ?
       LIMIT 1`,
    )
    .bind(participantId)
    .first<TeamRow>();
  if (!team) return null;
  const members = await db
    .prepare(`SELECT participant_id FROM team_members WHERE team_id = ?`)
    .bind(team.id)
    .all<{ participant_id: string }>();
  return { team, member_ids: (members.results ?? []).map((m) => m.participant_id) };
}

export async function updateTeamMeta(
  db: D1Database,
  teamId: string,
  patch: { name?: string; project_brief?: string; rationale?: string },
): Promise<void> {
  const sets: string[] = [];
  const vals: unknown[] = [];
  if (patch.name !== undefined) { sets.push('name = ?'); vals.push(patch.name); }
  if (patch.project_brief !== undefined) { sets.push('project_brief = ?'); vals.push(patch.project_brief); }
  if (patch.rationale !== undefined) { sets.push('rationale = ?'); vals.push(patch.rationale); }
  if (sets.length === 0) return;
  vals.push(teamId);
  await db.prepare(`UPDATE teams SET ${sets.join(', ')} WHERE id = ?`).bind(...vals).run();
}

/**
 * Apply a hand-edited arrangement. Everything that moved is flagged
 * `is_manual_override = 1` so the review screen can show what a human changed.
 */
export async function replaceMembership(
  db: D1Database,
  runId: string,
  assignment: Record<string, string[]>,
): Promise<void> {
  const existing = await getTeams(db, runId);
  const validTeamIds = new Set(existing.map((t) => t.team.id));
  const previous = new Map<string, string>();
  for (const t of existing) for (const pid of t.member_ids) previous.set(pid, t.team.id);

  const statements: D1PreparedStatement[] = [
    db.prepare(
      `DELETE FROM team_members WHERE team_id IN (SELECT id FROM teams WHERE run_id = ?)`,
    ).bind(runId),
  ];
  for (const [teamId, memberIds] of Object.entries(assignment)) {
    if (!validTeamIds.has(teamId)) continue;
    for (const pid of memberIds) {
      const moved = previous.get(pid) !== teamId ? 1 : 0;
      const wasManual = existing.find((t) => t.team.id === teamId)?.manual_overrides.has(pid) ? 1 : 0;
      statements.push(
        db
          .prepare(`INSERT INTO team_members (team_id, participant_id, is_manual_override) VALUES (?, ?, ?)`)
          .bind(teamId, pid, moved || wasManual),
      );
    }
  }
  await db.batch(statements);
}

/** Exactly one run may be published. Enforced here and by a partial unique index. */
export async function publishRun(db: D1Database, runId: string): Promise<void> {
  await db.batch([
    db.prepare(`UPDATE grouping_runs SET is_published = 0 WHERE is_published = 1`),
    db.prepare(`UPDATE grouping_runs SET is_published = 1 WHERE id = ?`).bind(runId),
  ]);
}

export async function unpublishAll(db: D1Database): Promise<void> {
  await db.prepare(`UPDATE grouping_runs SET is_published = 0 WHERE is_published = 1`).run();
}

export async function deleteRun(db: D1Database, runId: string): Promise<void> {
  await db.batch([
    db.prepare(`DELETE FROM team_members WHERE team_id IN (SELECT id FROM teams WHERE run_id = ?)`).bind(runId),
    db.prepare(`DELETE FROM teams WHERE run_id = ?`).bind(runId),
    db.prepare(`DELETE FROM grouping_runs WHERE id = ?`).bind(runId),
  ]);
}

export function parseParams(row: GroupingRunRow, fallback: SolverParams): SolverParams {
  try {
    return { ...fallback, ...(JSON.parse(row.params_json) as SolverParams) };
  } catch {
    return fallback;
  }
}

export function parseViolations(row: GroupingRunRow): Violation[] {
  if (!row.violations_json) return [];
  try {
    return JSON.parse(row.violations_json) as Violation[];
  } catch {
    return [];
  }
}

export function parseScore(row: GroupingRunRow): ScoreBreakdown | null {
  if (!row.score_json) return null;
  try {
    return JSON.parse(row.score_json) as ScoreBreakdown;
  } catch {
    return null;
  }
}

export function parseThemes(row: GroupingRunRow): {
  themes: Theme[];
  warnings: string[];
  /** participant id -> the theme key the solver scored against (post-merge bucket). */
  themeOf: Record<string, string>;
} {
  if (!row.themes_json) return { themes: [], warnings: [], themeOf: {} };
  try {
    const parsed = JSON.parse(row.themes_json) as {
      themes?: Theme[];
      warnings?: string[];
      theme_of?: Record<string, string>;
    };
    return {
      themes: parsed.themes ?? [],
      warnings: parsed.warnings ?? [],
      themeOf: parsed.theme_of ?? {},
    };
  } catch {
    return { themes: [], warnings: [], themeOf: {} };
  }
}
