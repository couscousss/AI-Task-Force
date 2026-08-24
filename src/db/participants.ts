import type { ParticipantRow } from '../types';
import type { SolverParticipant } from '../grouping/types';
import { newId, newToken, nowIso } from '../lib/ids';
import { normalizeEmail } from '../lib/validation';
import { ATTENDING } from '../config';

const COLS = `id, token, email, name, department, attending, problem_statement, category,
  skill_understanding, skill_tools, skill_prompting, skill_building,
  has_personal_laptop, hopes, submitted_at, updated_at`;

export async function getByToken(db: D1Database, token: string): Promise<ParticipantRow | null> {
  return db.prepare(`SELECT ${COLS} FROM participants WHERE token = ?`).bind(token).first<ParticipantRow>();
}

export async function getById(db: D1Database, id: string): Promise<ParticipantRow | null> {
  return db.prepare(`SELECT ${COLS} FROM participants WHERE id = ?`).bind(id).first<ParticipantRow>();
}

export async function getByEmail(db: D1Database, email: string): Promise<ParticipantRow | null> {
  return db
    .prepare(`SELECT ${COLS} FROM participants WHERE email = ?`)
    .bind(normalizeEmail(email))
    .first<ParticipantRow>();
}

export async function listAll(db: D1Database): Promise<ParticipantRow[]> {
  const res = await db
    .prepare(`SELECT ${COLS} FROM participants ORDER BY (name IS NULL), name COLLATE NOCASE, email`)
    .all<ParticipantRow>();
  return res.results ?? [];
}

/** Everyone who said yes AND completed the form. These are the only rows the solver sees. */
export async function listAttendingSubmitted(db: D1Database): Promise<ParticipantRow[]> {
  const res = await db
    .prepare(
      `SELECT ${COLS} FROM participants
       WHERE attending = 1 AND submitted_at IS NOT NULL
       ORDER BY id`,
    )
    .all<ParticipantRow>();
  return res.results ?? [];
}

export async function listByIds(db: D1Database, ids: string[]): Promise<ParticipantRow[]> {
  if (ids.length === 0) return [];
  const out: ParticipantRow[] = [];
  // D1 caps bound parameters per statement; chunk defensively.
  for (let i = 0; i < ids.length; i += 80) {
    const chunk = ids.slice(i, i + 80);
    const placeholders = chunk.map(() => '?').join(',');
    const res = await db
      .prepare(`SELECT ${COLS} FROM participants WHERE id IN (${placeholders})`)
      .bind(...chunk)
      .all<ParticipantRow>();
    out.push(...(res.results ?? []));
  }
  return out;
}

export interface InviteInput {
  name: string | null;
  email: string;
}

export interface InviteResult {
  added: number;
  existed: number;
  skipped: { line: number; value: string; reason: string }[];
}

/** Insert an invite row if the email is new. Returns the row either way. */
export async function ensureInvite(
  db: D1Database,
  input: InviteInput,
): Promise<{ row: ParticipantRow; created: boolean }> {
  const email = normalizeEmail(input.email);
  const existing = await getByEmail(db, email);
  if (existing) {
    // Backfill a name only if we do not already have one; never overwrite what a
    // participant typed themselves.
    if (!existing.name && input.name) {
      await db
        .prepare(`UPDATE participants SET name = ?, updated_at = ? WHERE id = ?`)
        .bind(input.name, nowIso(), existing.id)
        .run();
      existing.name = input.name;
    }
    return { row: existing, created: false };
  }
  const row: ParticipantRow = {
    id: newId(),
    token: newToken(),
    email,
    name: input.name,
    department: null,
    attending: null,
    problem_statement: null,
    category: null,
    skill_understanding: null,
    skill_tools: null,
    skill_prompting: null,
    skill_building: null,
    has_personal_laptop: null,
    hopes: null,
    submitted_at: null,
    updated_at: nowIso(),
  };
  await db
    .prepare(
      `INSERT INTO participants (id, token, email, name, updated_at) VALUES (?, ?, ?, ?, ?)`,
    )
    .bind(row.id, row.token, row.email, row.name, row.updated_at)
    .run();
  return { row, created: true };
}

export interface FormSubmission {
  name: string;
  email: string;
  attending: number;
  department: string | null;
  problem_statement: string | null;
  category: string | null;
  skills: { understanding: number; tools: number; prompting: number; building: number } | null;
  has_personal_laptop: number | null;
  hopes: string | null;
}

/** Save a participant's own submission against their token row. */
export async function saveSubmission(
  db: D1Database,
  current: ParticipantRow,
  s: FormSubmission,
): Promise<ParticipantRow> {
  const now = nowIso();
  const submittedAt = current.submitted_at ?? now;
  await db
    .prepare(
      `UPDATE participants SET
         name = ?, email = ?, attending = ?, department = ?, problem_statement = ?,
         category = ?, skill_understanding = ?, skill_tools = ?, skill_prompting = ?,
         skill_building = ?, has_personal_laptop = ?, hopes = ?,
         submitted_at = ?, updated_at = ?
       WHERE id = ?`,
    )
    .bind(
      s.name,
      normalizeEmail(s.email),
      s.attending,
      s.department,
      s.problem_statement,
      s.category,
      s.skills?.understanding ?? null,
      s.skills?.tools ?? null,
      s.skills?.prompting ?? null,
      s.skills?.building ?? null,
      s.has_personal_laptop,
      s.hopes,
      submittedAt,
      now,
      current.id,
    )
    .run();
  const updated = await getById(db, current.id);
  if (!updated) throw new Error('participant vanished during save');
  return updated;
}

/** Organizer-side edit. Only touches the fields provided. */
export async function adminUpdate(
  db: D1Database,
  id: string,
  patch: Partial<Omit<ParticipantRow, 'id' | 'token'>>,
): Promise<void> {
  type Patchable = keyof Omit<ParticipantRow, 'id' | 'token' | 'updated_at'>;
  const allowed: Patchable[] = [
    'email', 'name', 'department', 'attending', 'problem_statement', 'category',
    'skill_understanding', 'skill_tools', 'skill_prompting', 'skill_building',
    'has_personal_laptop', 'hopes', 'submitted_at',
  ];
  const sets: string[] = [];
  const vals: unknown[] = [];
  for (const k of allowed) {
    if (k in patch) {
      sets.push(`${k} = ?`);
      vals.push(patch[k] ?? null);
    }
  }
  if (sets.length === 0) return;
  sets.push('updated_at = ?');
  vals.push(nowIso(), id);
  await db.prepare(`UPDATE participants SET ${sets.join(', ')} WHERE id = ?`).bind(...vals).run();
}

export async function regenerateToken(db: D1Database, id: string): Promise<string> {
  const token = newToken();
  await db.prepare(`UPDATE participants SET token = ?, updated_at = ? WHERE id = ?`)
    .bind(token, nowIso(), id).run();
  return token;
}

export async function deleteParticipant(db: D1Database, id: string): Promise<void> {
  await db.prepare(`DELETE FROM team_members WHERE participant_id = ?`).bind(id).run();
  await db.prepare(`DELETE FROM participants WHERE id = ?`).bind(id).run();
}

export interface DashboardStats {
  invited: number;
  responded: number;
  attending: number;
  declined: number;
  unsure: number;
  noResponse: number;
  laptops: number;
  laptopsUnknown: number;
  withProblem: number;
  /** axis -> [count of 1s, 2s, 3s, 4s, 5s] over attending respondents. */
  skillHistogram: Record<'understanding' | 'tools' | 'prompting' | 'building', number[]>;
  categoryCounts: { category: string; count: number }[];
  departmentCounts: { department: string; count: number }[];
}

export async function dashboardStats(db: D1Database): Promise<DashboardStats> {
  const rows = await listAll(db);
  const stats: DashboardStats = {
    invited: rows.length,
    responded: 0,
    attending: 0,
    declined: 0,
    unsure: 0,
    noResponse: 0,
    laptops: 0,
    laptopsUnknown: 0,
    withProblem: 0,
    skillHistogram: {
      understanding: [0, 0, 0, 0, 0],
      tools: [0, 0, 0, 0, 0],
      prompting: [0, 0, 0, 0, 0],
      building: [0, 0, 0, 0, 0],
    },
    categoryCounts: [],
    departmentCounts: [],
  };
  const cats = new Map<string, number>();
  const depts = new Map<string, number>();

  for (const r of rows) {
    if (r.submitted_at) stats.responded++;
    if (r.attending === ATTENDING.yes) stats.attending++;
    else if (r.attending === ATTENDING.no) stats.declined++;
    else if (r.attending === ATTENDING.unsure) stats.unsure++;
    else stats.noResponse++;

    if (r.attending !== ATTENDING.yes) continue;

    if (r.has_personal_laptop === 1) stats.laptops++;
    else if (r.has_personal_laptop === null) stats.laptopsUnknown++;
    if (r.problem_statement && r.problem_statement.trim() !== '') stats.withProblem++;

    const axes = [
      ['understanding', r.skill_understanding],
      ['tools', r.skill_tools],
      ['prompting', r.skill_prompting],
      ['building', r.skill_building],
    ] as const;
    for (const [axis, v] of axes) {
      if (v !== null && v >= 1 && v <= 5) stats.skillHistogram[axis][v - 1]!++;
    }
    if (r.category) cats.set(r.category, (cats.get(r.category) ?? 0) + 1);
    const dept = (r.department ?? '').trim();
    if (dept) depts.set(dept, (depts.get(dept) ?? 0) + 1);
  }
  stats.categoryCounts = [...cats.entries()]
    .map(([category, count]) => ({ category, count }))
    .sort((a, b) => b.count - a.count || a.category.localeCompare(b.category));
  stats.departmentCounts = [...depts.entries()]
    .map(([department, count]) => ({ department, count }))
    .sort((a, b) => b.count - a.count || a.department.localeCompare(b.department));
  return stats;
}

/**
 * Project a stored row onto the solver's view. Missing skill answers default to 1 —
 * a person we know nothing about is treated as a beginner rather than dropped, and
 * only rows with `submitted_at` reach here anyway.
 */
export function toSolverParticipant(r: ParticipantRow): SolverParticipant {
  return {
    id: r.id,
    name: r.name,
    department: (r.department ?? '').trim() || null,
    category: r.category,
    skills: {
      understanding: clampSkill(r.skill_understanding),
      tools: clampSkill(r.skill_tools),
      prompting: clampSkill(r.skill_prompting),
      building: clampSkill(r.skill_building),
    },
    has_laptop: r.has_personal_laptop === 1,
  };
}

function clampSkill(v: number | null): number {
  if (v === null || !Number.isFinite(v)) return 1;
  return Math.min(5, Math.max(1, Math.round(v)));
}
