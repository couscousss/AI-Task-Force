/**
 * The reminder sweep, plus the sequential delivery loop every kind of send goes through.
 *
 * The governing rule for everything in here: a bug that mails 60 colleagues four times is
 * worse than a bug that mails nobody. So the log row is reserved *before* the provider is
 * called, a failure never consumes a reminder slot, and nothing is ever sent twice on the
 * same local day.
 */

import type { Env } from '../env';
import type { EmailKind, ParticipantRow } from '../types';
import type { EventConfig } from '../config';
import type { RenderedEmail } from './templates';
import { ATTENDING, loadConfig } from '../config';
import { countsByParticipant, markFailed, markSent, reserve, sentOnLocalDay } from '../db/email-log';
import { listAll } from '../db/participants';
import { isPast, isWeekday, toLocalParts } from '../lib/dates';
import { isValidEmail } from '../lib/validation';
import { reminderEmail } from './templates';
import { sendEmail } from './send';

/** Pause between messages so one slow or rejected address cannot take a sweep down. */
const PAUSE_BETWEEN_SENDS_MS = 250;

/**
 * Ceiling on one invocation. Reserve-before-send makes a truncated batch safe: the
 * people who were missed stay eligible, and running it again picks them up.
 */
export const MAX_PER_BATCH = 100;

/** The local calendar day a send belongs to — the day the once-per-day rule is written in. */
export function localDayKey(cfg: EventConfig, now: Date): string {
  return toLocalParts(now, cfg.localUtcOffsetHours).dateKey;
}

/** Stop after this many failures in a row rather than burning the whole batch on a dead provider. */
const CONSECUTIVE_FAILURE_LIMIT = 5;

export interface EmailJob {
  participantId: string | null;
  to: string;
  kind: EmailKind;
  message: RenderedEmail;
}

export interface BatchOutcome {
  /** Reserved by a concurrent send between the eligibility read and the insert. */
  skipped: number;
  sent: number;
  failed: number;
  /** Set when the loop gave up early; the remaining jobs were never attempted. */
  abandoned: number;
  firstError: string | null;
}

/**
 * Reserve, send, mark. Sequential on purpose — 150 people at a quarter-second apart is
 * well inside a sweep, and a provider rate limit is a far worse failure than slowness.
 */
export async function deliverBatch(
  env: Env,
  jobs: EmailJob[],
  dayKey: string,
): Promise<BatchOutcome> {
  const outcome: BatchOutcome = { sent: 0, failed: 0, abandoned: 0, skipped: 0, firstError: null };
  if (jobs.length === 0) return outcome;

  if (!env.RESEND_API_KEY?.trim()) {
    // Bail before writing any log rows: an unconfigured provider would otherwise leave
    // one 'failed' row per person and make the log unreadable.
    outcome.abandoned = jobs.length;
    outcome.firstError =
      'Email is not configured, so nothing was sent. Set the API key with `wrangler secret put RESEND_API_KEY`.';
    console.error('[email] batch skipped entirely: RESEND_API_KEY is not set');
    return outcome;
  }

  let consecutiveFailures = 0;
  for (let i = 0; i < jobs.length; i++) {
    const job = jobs[i]!;
    const logId = await reserve(env.DB, job.participantId, job.kind, dayKey);
    if (logId === null) {
      // Someone else reserved this person for this kind today between our eligibility
      // read and now — a concurrent cron, or a second click. Skipping is the whole point.
      outcome.skipped++;
      console.warn(`[email] ${job.kind} to ${job.to} skipped: already reserved today`);
      continue;
    }
    const result = await sendEmail(env, {
      to: job.to,
      subject: job.message.subject,
      text: job.message.text,
      html: job.message.html,
    });

    if (result.ok) {
      await markSent(env.DB, logId, result.providerId);
      outcome.sent++;
      consecutiveFailures = 0;
    } else {
      const reason = result.error ?? 'the provider gave no reason';
      await markFailed(env.DB, logId, reason);
      outcome.failed++;
      outcome.firstError ??= reason;
      consecutiveFailures++;
      console.error(`[email] ${job.kind} to ${job.to} failed: ${reason}`);
      if (consecutiveFailures >= CONSECUTIVE_FAILURE_LIMIT) {
        outcome.abandoned = jobs.length - i - 1;
        console.error(
          `[email] stopped after ${consecutiveFailures} failures in a row; ${outcome.abandoned} not attempted`,
        );
        break;
      }
    }

    if (i < jobs.length - 1) await pause(PAUSE_BETWEEN_SENDS_MS);
  }
  return outcome;
}

/* ------------------------------------------------------------------ who gets a reminder */

export interface ReminderCounts {
  get(id: string): { total: number; lastSentAt: string | null } | undefined;
}

/**
 * Pure given its inputs, so the rule can be read in one place and reused by the admin
 * "Send reminders now" button. The only thing the cron adds is the time-of-day gate.
 */
export function selectReminderRecipients(
  rows: ParticipantRow[],
  reminderCounts: ReminderCounts,
  now: Date,
  cfg: EventConfig,
): ParticipantRow[] {
  return rows.filter((row) => {
    if (row.submitted_at) return false;
    if (row.attending === ATTENDING.no) return false;
    if (!isValidEmail(row.email)) return false;
    const prior = reminderCounts.get(row.id);
    if ((prior?.total ?? 0) >= cfg.maxReminders) return false;
    if (sentOnLocalDay(prior?.lastSentAt ?? null, now, cfg.localUtcOffsetHours)) return false;
    return true;
  });
}

export interface ReminderRun extends BatchOutcome {
  /** Everyone who qualified, before the per-batch ceiling was applied. */
  eligible: number;
}

/** Load the pool, pick the recipients, send them. Shared by the cron and the admin button. */
export async function sendReminders(env: Env, cfg: EventConfig, now: Date): Promise<ReminderRun> {
  const [rows, counts] = await Promise.all([
    listAll(env.DB),
    countsByParticipant(env.DB, 'reminder'),
  ]);
  const eligible = selectReminderRecipients(rows, counts, now, cfg);
  const batch = eligible.slice(0, MAX_PER_BATCH);
  const outcome = await deliverBatch(
    env,
    batch.map((row) => ({
      participantId: row.id,
      to: row.email,
      kind: 'reminder' as const,
      message: reminderEmail({ name: row.name, email: row.email, token: row.token }, cfg),
    })),
    localDayKey(cfg, now),
  );
  return { ...outcome, eligible: eligible.length };
}

/* ------------------------------------------------------------------ the cron itself */

/**
 * Called hourly. This function, not the cron expression, decides whether it is really
 * 09:00 on a weekday where the event is happening — which keeps the timezone a config
 * value and makes a double-fire harmless.
 */
export async function runReminderSweep(env: Env, now: Date): Promise<void> {
  const cfg = loadConfig(env);
  const local = toLocalParts(now, cfg.localUtcOffsetHours);

  if (local.hour !== cfg.reminderLocalHour || !isWeekday(local)) return;
  if (isPast(cfg.formDeadline, now)) {
    console.log(`[reminders] ${local.dateKey}: deadline ${cfg.formDeadline} has passed, nothing sent`);
    return;
  }

  const run = await sendReminders(env, cfg, now);
  console.log(
    `[reminders] ${local.dateKey}: ${run.eligible} eligible, ${run.sent} sent, ${run.failed} failed, ` +
      `${run.abandoned} not attempted${run.firstError ? ` — first error: ${run.firstError}` : ''}`,
  );
}

function pause(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
