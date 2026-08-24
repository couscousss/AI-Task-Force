import type { EmailKind, EmailLogRow } from '../types';
import { newId, nowIso } from '../lib/ids';
import { toLocalParts } from '../lib/dates';

export async function countSent(db: D1Database, participantId: string, kind: EmailKind): Promise<number> {
  const row = await db
    .prepare(`SELECT COUNT(*) AS n FROM email_log WHERE participant_id = ? AND kind = ? AND status NOT LIKE 'failed%'`)
    .bind(participantId, kind)
    .first<{ n: number }>();
  return row?.n ?? 0;
}

/** Counts per participant for one kind, so the reminder job needs a single query. */
export async function countsByParticipant(
  db: D1Database,
  kind: EmailKind,
): Promise<Map<string, { total: number; lastSentAt: string | null }>> {
  const res = await db
    .prepare(
      `SELECT participant_id, COUNT(*) AS n, MAX(sent_at) AS last_sent
       FROM email_log WHERE kind = ? AND status NOT LIKE 'failed%' GROUP BY participant_id`,
    )
    .bind(kind)
    .all<{ participant_id: string; n: number; last_sent: string | null }>();
  const map = new Map<string, { total: number; lastSentAt: string | null }>();
  for (const r of res.results ?? []) {
    if (!r.participant_id) continue;
    map.set(r.participant_id, { total: r.n, lastSentAt: r.last_sent });
  }
  return map;
}

export function sentOnLocalDay(lastSentAt: string | null, now: Date, offsetHours: number): boolean {
  if (!lastSentAt) return false;
  const last = new Date(lastSentAt);
  if (Number.isNaN(last.getTime())) return false;
  return toLocalParts(last, offsetHours).dateKey === toLocalParts(now, offsetHours).dateKey;
}

/**
 * Reserve a log row *before* calling the provider. If the Worker dies mid-send the row
 * stays as 'sending', which counts against the cap — we would rather under-send than
 * mail 60 colleagues twice.
 */
export async function reserve(
  db: D1Database,
  participantId: string | null,
  kind: EmailKind,
): Promise<string> {
  const id = newId();
  await db
    .prepare(`INSERT INTO email_log (id, participant_id, kind, sent_at, status) VALUES (?, ?, ?, ?, 'sending')`)
    .bind(id, participantId, kind, nowIso())
    .run();
  return id;
}

export async function markSent(db: D1Database, logId: string, providerId: string | null): Promise<void> {
  await db
    .prepare(`UPDATE email_log SET status = 'sent', provider_id = ?, sent_at = ? WHERE id = ?`)
    .bind(providerId, nowIso(), logId)
    .run();
}

export async function markFailed(db: D1Database, logId: string, reason: string): Promise<void> {
  await db
    .prepare(`UPDATE email_log SET status = ?, sent_at = sent_at WHERE id = ?`)
    .bind(`failed: ${reason}`.slice(0, 300), logId)
    .run();
}

export async function recent(db: D1Database, limit = 100): Promise<EmailLogRow[]> {
  const res = await db
    .prepare(`SELECT * FROM email_log ORDER BY sent_at DESC LIMIT ?`)
    .bind(limit)
    .all<EmailLogRow>();
  return res.results ?? [];
}
