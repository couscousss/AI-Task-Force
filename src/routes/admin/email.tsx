import { Hono } from 'hono';
import type { Context } from 'hono';
import type { FC } from 'hono/jsx';
import type { AppBindings } from '../../env';
import type { EmailLogRow, ParticipantRow } from '../../types';
import type { EventConfig } from '../../config';
import { AdminPage, Callout, Card, EmptyState, Stat } from '../../ui/layout';
import { loadConfig } from '../../config';
import { listAll } from '../../db/participants';
import { countsByParticipant, recent, sentOnLocalDay } from '../../db/email-log';
import { getPublishedRun, getTeams } from '../../db/runs';
import { MAX_PER_BATCH, deliverBatch, selectReminderRecipients, type EmailJob } from '../../email/cron';
import { inviteEmail, reminderEmail, teamAnnouncementEmail } from '../../email/templates';
import { formatLocalDateTime, isPast } from '../../lib/dates';
import { isValidEmail, squish } from '../../lib/validation';
import { originLooksSane } from '../../lib/auth';

export const emailAdminRoutes = new Hono<AppBindings>();

/* ------------------------------------------------------------------ small helpers */

type Tone = 'good' | 'warn' | 'bad';

function field(form: Record<string, unknown>, name: string): string {
  const v = form[name];
  return typeof v === 'string' ? v.trim() : '';
}

function displayName(row: ParticipantRow): string {
  return squish(row.name) || row.email;
}

function backToEmail(msg: string, tone: Tone): string {
  return `/admin/email?tone=${tone}&msg=${encodeURIComponent(msg.slice(0, 400))}`;
}

/** Only ever bounce back to a path inside this admin app; never to whatever was posted. */
function safeNext(raw: string): string | null {
  if (!raw.startsWith('/admin/')) return null;
  if (raw.startsWith('//')) return null;
  return raw;
}

function withParam(path: string, key: string, value: string): string {
  return `${path}${path.includes('?') ? '&' : '?'}${key}=${encodeURIComponent(value)}`;
}

/** Long batches outlive the request; the redirect reports the plan, the log reports the truth. */
function background(c: Context<AppBindings>, work: Promise<unknown>): void {
  const guarded = work.catch((err) => {
    console.error('[email] batch failed outside the request', err);
  });
  try {
    c.executionCtx.waitUntil(guarded);
  } catch {
    // No execution context (some test harnesses). The promise is already running.
  }
}

function plural(n: number, one: string, many: string): string {
  return `${n} ${n === 1 ? one : many}`;
}

/* ------------------------------------------------------------------ recipient selection */

interface InviteSelection {
  targets: ParticipantRow[];
  alreadyInvited: number;
  alreadyFilledIn: number;
  unusableEmail: number;
}

function selectInviteRecipients(
  rows: ParticipantRow[],
  inviteCounts: Map<string, { total: number; lastSentAt: string | null }>,
): InviteSelection {
  const sel: InviteSelection = { targets: [], alreadyInvited: 0, alreadyFilledIn: 0, unusableEmail: 0 };
  for (const row of rows) {
    if ((inviteCounts.get(row.id)?.total ?? 0) > 0) {
      sel.alreadyInvited++;
    } else if (!isValidEmail(row.email)) {
      sel.unusableEmail++;
    } else if (row.submitted_at) {
      sel.alreadyFilledIn++;
    } else {
      sel.targets.push(row);
    }
  }
  return sel;
}

interface AnnouncementJob {
  row: ParticipantRow;
  teamName: string;
  memberNames: string[];
  projectBrief: string;
}

interface AnnouncementSelection {
  targets: AnnouncementJob[];
  teamCount: number;
  alreadyTold: number;
  unusableEmail: number;
}

async function selectAnnouncementRecipients(
  db: D1Database,
  runId: string,
  rows: ParticipantRow[],
): Promise<AnnouncementSelection> {
  const [teams, counts] = await Promise.all([
    getTeams(db, runId),
    countsByParticipant(db, 'team_announcement'),
  ]);
  const byId = new Map(rows.map((r) => [r.id, r]));
  const sel: AnnouncementSelection = {
    targets: [],
    teamCount: teams.length,
    alreadyTold: 0,
    unusableEmail: 0,
  };
  for (const t of teams) {
    const members = t.member_ids.map((id) => byId.get(id)).filter((r): r is ParticipantRow => !!r);
    const memberNames = members.map(displayName);
    const teamName = squish(t.team.name) || t.team.theme_label || 'Your team';
    const projectBrief = squish(t.team.project_brief);
    for (const row of members) {
      if ((counts.get(row.id)?.total ?? 0) > 0) {
        sel.alreadyTold++;
      } else if (!isValidEmail(row.email)) {
        sel.unusableEmail++;
      } else {
        sel.targets.push({ row, teamName, memberNames, projectBrief });
      }
    }
  }
  return sel;
}

/* ------------------------------------------------------------------ the screen */

emailAdminRoutes.get('/', async (c) => {
  const cfg = loadConfig(c.env);
  const adminEmail = c.get('adminEmail');
  const url = new URL(c.req.url);
  const now = new Date();

  const rows = await listAll(c.env.DB);
  const [inviteCounts, reminderCounts, log, publishedRun] = await Promise.all([
    countsByParticipant(c.env.DB, 'invite'),
    countsByParticipant(c.env.DB, 'reminder'),
    recent(c.env.DB, 100),
    getPublishedRun(c.env.DB),
  ]);

  const invites = selectInviteRecipients(rows, inviteCounts);
  const remindable = selectReminderRecipients(rows, reminderCounts, now, cfg);
  const announcements = publishedRun
    ? await selectAnnouncementRecipients(c.env.DB, publishedRun.id, rows)
    : null;

  const deadlinePassed = isPast(cfg.formDeadline, now);
  const configured = !!c.env.RESEND_API_KEY?.trim();
  const originLooksLocal = /localhost|127\.0\.0\.1/.test(cfg.publicOrigin);

  const msg = url.searchParams.get('msg');
  const tone = (url.searchParams.get('tone') ?? 'good') as Tone;
  const confirm = url.searchParams.get('confirm');

  const namesById = new Map(rows.map((r) => [r.id, r] as const));

  return c.html(
    <AdminPage
      title="Email"
      active="email"
      email={adminEmail}
      heading="Email"
      lede="Invites, reminders and the team announcement. Every send is written to the log first, so nobody gets the same message twice."
    >
      {msg ? (
        <Callout
          tone={tone === 'bad' ? 'bad' : tone === 'warn' ? 'warn' : 'good'}
          title={tone === 'bad' ? 'Nothing sent' : tone === 'warn' ? 'Nothing to send' : 'On its way'}
        >
          {msg}
        </Callout>
      ) : null}

      {!configured ? (
        <Callout tone="warn" title="Email is not configured">
          No <span class="mono">RESEND_API_KEY</span> is set, so every send will be refused before it
          reaches anyone. Run <span class="mono">wrangler secret put RESEND_API_KEY</span> and redeploy.
          Everything else on this page still works — you can copy personal links from{' '}
          <a href="/admin/participants">Participants</a> in the meantime.
        </Callout>
      ) : null}

      {originLooksLocal ? (
        <Callout tone="warn" title="Links would point at your laptop">
          <span class="mono">{cfg.publicOrigin}</span> is a local address, so the link in every email
          would be dead for the person receiving it. Set{' '}
          <span class="mono">PUBLIC_ORIGIN</span> in <span class="mono">wrangler.jsonc</span> to the real
          domain before sending anything.
        </Callout>
      ) : null}

      {confirm ? (
        <ConfirmPanel
          which={confirm}
          cfg={cfg}
          invites={invites}
          remindable={remindable.length}
          announcements={announcements}
          deadlinePassed={deadlinePassed}
        />
      ) : null}

      <div class="grid grid-4">
        <Stat value={rows.length} label="On the invite list" />
        <Stat
          value={invites.targets.length}
          label="Waiting for their first invite"
          hint={invites.alreadyInvited > 0 ? `${invites.alreadyInvited} already have one` : undefined}
        />
        <Stat
          value={remindable.length}
          label="Due a reminder now"
          hint={`At most ${plural(cfg.maxReminders, 'reminder', 'reminders')} each, never twice in a day`}
        />
        <Stat
          value={announcements ? announcements.targets.length : 0}
          label="Waiting for their team"
          hint={announcements ? `${announcements.teamCount} teams published` : 'No run published yet'}
        />
      </div>

      <Card
        title="Invites"
        sub="The first email: what the day is, their personal link, and the deadline."
      >
        {rows.length === 0 ? (
          <EmptyState
            title="Upload your invite list first"
            body="There is nobody to email yet. Upload a CSV of names and emails and everyone gets their own link."
            action={
              <a class="btn" href="/admin/invites">
                Upload invite list
              </a>
            }
          />
        ) : (
          <>
            <p>
              {invites.targets.length > 0
                ? `${plural(invites.targets.length, 'person has', 'people have')} never had a personal link.`
                : 'Everyone on the list has had their personal link.'}{' '}
              {invites.alreadyInvited > 0
                ? `${plural(invites.alreadyInvited, 'person was', 'people were')} invited already and will not be emailed again.`
                : ''}
            </p>
            <div class="btn-row">
              <a
                class="btn"
                href="/admin/email?confirm=invites"
                aria-disabled={invites.targets.length === 0 ? 'true' : undefined}
              >
                Send invites
              </a>
              <a class="btn btn-secondary" href="/admin/participants">
                Send one person their link
              </a>
            </div>
          </>
        )}
      </Card>

      <Card
        title="Reminders"
        sub={`Sent automatically on weekdays at ${String(cfg.reminderLocalHour).padStart(2, '0')}:00 local time.`}
      >
        <p>
          Reminders go to people who have not filled the form in, at most{' '}
          {plural(cfg.maxReminders, 'time', 'times')} each, and never twice on the same day. The form
          closes {formatLocalDateTime(cfg.formDeadline, cfg.localUtcOffsetHours)}
          {deadlinePassed ? ' — that has passed, so no more reminders will go out.' : '.'}
        </p>
        <p>
          {remindable.length > 0
            ? `${plural(remindable.length, 'person is', 'people are')} due one right now.`
            : 'Nobody is due one right now.'}
        </p>
        <div class="btn-row">
          <a
            class="btn"
            href="/admin/email?confirm=reminders"
            aria-disabled={remindable.length === 0 || deadlinePassed ? 'true' : undefined}
          >
            Send reminders now
          </a>
        </div>
      </Card>

      <Card title="Team announcement" sub="Their team name, who is on it, and the project brief.">
        {!publishedRun ? (
          <EmptyState
            title="Publish a run first"
            body="The announcement is built from the published teams, and no run is published yet."
            action={
              <a class="btn" href="/admin/runs">
                Go to grouping runs
              </a>
            }
          />
        ) : (
          <>
            <p>
              {announcements && announcements.targets.length > 0
                ? `${plural(announcements.targets.length, 'person has', 'people have')} not been told their team yet, across ${plural(announcements.teamCount, 'team', 'teams')}.`
                : 'Everyone on a published team has been told.'}{' '}
              {announcements && announcements.alreadyTold > 0
                ? `${plural(announcements.alreadyTold, 'person was', 'people were')} told already and will not be emailed again.`
                : ''}
            </p>
            <div class="btn-row">
              <a
                class="btn"
                href="/admin/email?confirm=announcement"
                aria-disabled={!announcements || announcements.targets.length === 0 ? 'true' : undefined}
              >
                Send team announcement
              </a>
              <a class="btn btn-secondary" href="/teams">
                See the published teams
              </a>
            </div>
          </>
        )}
      </Card>

      <Card title="Email log" sub="The last 100 sends, newest first. This is what stops anyone being emailed twice.">
        {log.length === 0 ? (
          <EmptyState
            title="Nothing has been sent yet"
            body="Once you send the invites, every message shows up here with who it went to and whether it landed."
            action={
              rows.length > 0 ? (
                <a class="btn" href="/admin/email?confirm=invites">
                  Send invites
                </a>
              ) : (
                <a class="btn" href="/admin/invites">
                  Upload invite list
                </a>
              )
            }
          />
        ) : (
          <div class="table-scroll">
            <table>
              <thead>
                <tr>
                  <th scope="col">When</th>
                  <th scope="col">Who</th>
                  <th scope="col">Message</th>
                  <th scope="col">Result</th>
                </tr>
              </thead>
              <tbody>
                {log.map((entry) => (
                  <LogRow entry={entry} person={entry.participant_id ? namesById.get(entry.participant_id) : undefined} cfg={cfg} />
                ))}
              </tbody>
            </table>
          </div>
        )}
        <p class="small muted" style="margin-top:0.9rem">
          A row stuck on “Sending” means the worker was cut off mid-send. That person will not be
          emailed that message again — send them their link individually from{' '}
          <a href="/admin/participants">Participants</a> if it never arrived.
        </p>
      </Card>
    </AdminPage>,
  );
});

const KIND_LABEL: Record<string, string> = {
  invite: 'Invite',
  reminder: 'Reminder',
  team_announcement: 'Team announcement',
};

const LogRow: FC<{ entry: EmailLogRow; person: ParticipantRow | undefined; cfg: EventConfig }> = ({
  entry,
  person,
  cfg,
}) => {
  const status = entry.status ?? '';
  const failed = status.startsWith('failed');
  return (
    <tr>
      <td class="nowrap">{formatLocalDateTime(entry.sent_at, cfg.localUtcOffsetHours)}</td>
      <td>
        {person ? (
          <>
            <a href={`/admin/participants/${person.id}`}>{displayName(person)}</a>
            <div class="small muted">{person.email}</div>
          </>
        ) : (
          <span class="muted">Deleted participant</span>
        )}
      </td>
      <td>{KIND_LABEL[entry.kind] ?? entry.kind}</td>
      <td>
        {status === 'sent' ? (
          <span class="tag tag-yes">Sent</span>
        ) : status === 'sending' ? (
          <span class="tag tag-maybe">Sending</span>
        ) : failed ? (
          <>
            <span class="tag tag-no">Failed</span>
            <div class="small muted">{status.replace(/^failed:\s*/, '')}</div>
          </>
        ) : (
          <span class="tag tag-none">{status || 'Unknown'}</span>
        )}
      </td>
    </tr>
  );
};

/* ------------------------------------------------------------------ confirmation step */

const ConfirmPanel: FC<{
  which: string;
  cfg: EventConfig;
  invites: InviteSelection;
  remindable: number;
  announcements: AnnouncementSelection | null;
  deadlinePassed: boolean;
}> = ({ which, cfg, invites, remindable, announcements, deadlinePassed }) => {
  if (which === 'invites') {
    if (invites.targets.length === 0) {
      return (
        <Callout tone="warn" title="Nobody to invite">
          Everyone on the list has already had their personal link. To send one again to a single
          person, use <a href="/admin/participants">Participants</a>.
        </Callout>
      );
    }
    return (
      <ConfirmForm
        action="/admin/email/send-invite"
        title={`Send invites to ${plural(invites.targets.length, 'person', 'people')}?`}
        submitLabel={`Send ${plural(Math.min(invites.targets.length, MAX_PER_BATCH), 'invite', 'invites')}`}
        hidden={{ scope: 'all' }}
      >
        Everyone gets their own link and the deadline of{' '}
        {formatLocalDateTime(cfg.formDeadline, cfg.localUtcOffsetHours)}.{' '}
        {invites.alreadyInvited > 0
          ? `${plural(invites.alreadyInvited, 'person', 'people')} already invited will be skipped. `
          : ''}
        {invites.alreadyFilledIn > 0
          ? `${plural(invites.alreadyFilledIn, 'person', 'people')} who already filled the form in will be skipped. `
          : ''}
        {invites.unusableEmail > 0
          ? `${plural(invites.unusableEmail, 'address', 'addresses')} cannot be emailed and will be skipped — fix them on Participants. `
          : ''}
        {invites.targets.length > MAX_PER_BATCH
          ? `Only ${MAX_PER_BATCH} go out per click; run it again for the remaining ${invites.targets.length - MAX_PER_BATCH}.`
          : ''}
      </ConfirmForm>
    );
  }

  if (which === 'reminders') {
    if (deadlinePassed) {
      return (
        <Callout tone="bad" title="The form has closed">
          The deadline was {formatLocalDateTime(cfg.formDeadline, cfg.localUtcOffsetHours)}. Change{' '}
          <span class="mono">FORM_DEADLINE</span> if you are extending it, then send reminders again.
        </Callout>
      );
    }
    if (remindable === 0) {
      return (
        <Callout tone="warn" title="Nobody is due a reminder">
          Everyone still outstanding has either had {plural(cfg.maxReminders, 'reminder', 'reminders')}{' '}
          already or was emailed today. Try again tomorrow.
        </Callout>
      );
    }
    return (
      <ConfirmForm
        action="/admin/email/send-reminders"
        title={`Send reminders to ${plural(remindable, 'person', 'people')}?`}
        submitLabel={`Send ${plural(Math.min(remindable, MAX_PER_BATCH), 'reminder', 'reminders')}`}
      >
        These are people with no submitted form who have had fewer than{' '}
        {plural(cfg.maxReminders, 'reminder', 'reminders')} and were not emailed today. The same caps
        apply as to the automatic 09:00 sweep — only the time of day is being overridden.
      </ConfirmForm>
    );
  }

  if (which === 'announcement') {
    if (!announcements || announcements.targets.length === 0) {
      return (
        <Callout tone="warn" title="Nobody to tell">
          Everyone on a published team has already been sent their team. Republishing a different run
          does not re-send it.
        </Callout>
      );
    }
    return (
      <ConfirmForm
        action="/admin/email/send-announcement"
        title={`Tell ${plural(announcements.targets.length, 'person', 'people')} their team?`}
        submitLabel={`Send ${plural(Math.min(announcements.targets.length, MAX_PER_BATCH), 'announcement', 'announcements')}`}
      >
        Each person gets their team name, who else is on it, and the project brief from the published
        run.{' '}
        {announcements.alreadyTold > 0
          ? `${plural(announcements.alreadyTold, 'person', 'people')} already told will be skipped. `
          : ''}
        {announcements.unusableEmail > 0
          ? `${plural(announcements.unusableEmail, 'address', 'addresses')} cannot be emailed and will be skipped. `
          : ''}
        Edit a team name or brief on the review screen before sending — this email is the version they
        keep.
      </ConfirmForm>
    );
  }

  return null;
};

const ConfirmForm: FC<{
  action: string;
  title: string;
  submitLabel: string;
  hidden?: Record<string, string>;
  children?: unknown;
}> = ({ action, title, submitLabel, hidden, children }) => (
  <div class="callout callout-warn" role="alert">
    <span class="callout-glyph" aria-hidden="true">
      !
    </span>
    <div class="callout-body">
      <strong class="callout-title">Check this</strong>
      <h2 style="margin:0.15rem 0 0.4rem;font-size:1.1rem">{title}</h2>
      <p>{children}</p>
      <form method="post" action={action}>
        {Object.entries(hidden ?? {}).map(([k, v]) => (
          <input type="hidden" name={k} value={v} />
        ))}
        <div class="btn-row">
          <button class="btn" type="submit">
            {submitLabel}
          </button>
          <a class="btn btn-secondary" href="/admin/email">
            Cancel
          </a>
        </div>
      </form>
    </div>
  </div>
);

/* ------------------------------------------------------------------ POST /send-invite */

emailAdminRoutes.post('/send-invite', async (c) => {
  if (!originLooksSane(c)) {
    return c.text('That request did not come from this site. Reload /admin/email and try again.', 403);
  }
  const cfg = loadConfig(c.env);
  const form = await c.req.parseBody();
  const scope = field(form, 'scope');
  const next = safeNext(field(form, 'next'));
  const now = new Date();

  const rows = await listAll(c.env.DB);
  const inviteCounts = await countsByParticipant(c.env.DB, 'invite');

  /* ---- everyone who has never had one ---- */
  if (scope === 'all') {
    const sel = selectInviteRecipients(rows, inviteCounts);
    if (sel.targets.length === 0) {
      return c.redirect(
        backToEmail(
          `Nobody was emailed. All ${plural(rows.length, 'person', 'people')} on the list already have their personal link.`,
          'warn',
        ),
        303,
      );
    }
    const batch = sel.targets.slice(0, MAX_PER_BATCH);
    const jobs: EmailJob[] = batch.map((row) => ({
      participantId: row.id,
      to: row.email,
      kind: 'invite',
      message: inviteEmail({ name: row.name, email: row.email, token: row.token }, cfg),
    }));
    background(c, deliverBatch(c.env, jobs));

    const parts = [`Sending ${plural(batch.length, 'invite', 'invites')} now.`];
    if (sel.alreadyInvited > 0) parts.push(`Skipped ${sel.alreadyInvited} who already had one.`);
    if (sel.alreadyFilledIn > 0) parts.push(`Skipped ${sel.alreadyFilledIn} who already filled the form in.`);
    if (sel.unusableEmail > 0) parts.push(`Skipped ${sel.unusableEmail} with an unusable email address.`);
    if (sel.targets.length > batch.length) {
      parts.push(`${sel.targets.length - batch.length} still to go — click Send invites again.`);
    }
    parts.push('The log below fills in as they go out.');
    return c.redirect(backToEmail(parts.join(' '), 'good'), 303);
  }

  /* ---- one named person ---- */
  const id = field(form, 'participant_id') || field(form, 'id');
  const row = rows.find((r) => r.id === id);
  if (!row) {
    return c.redirect(
      backToEmail('No participant with that id, so nothing was sent. They may have been deleted — reload Participants and try again.', 'bad'),
      303,
    );
  }
  if (!isValidEmail(row.email)) {
    return c.redirect(
      backToEmail(`${displayName(row)} has an email address we cannot send to (“${row.email}”). Correct it on their participant page, then send again.`, 'bad'),
      303,
    );
  }

  const lastInvite = inviteCounts.get(row.id)?.lastSentAt ?? null;
  if (sentOnLocalDay(lastInvite, now, cfg.localUtcOffsetHours)) {
    const when = formatLocalDateTime(lastInvite ?? '', cfg.localUtcOffsetHours);
    return c.redirect(
      backToEmail(
        `Skipped ${displayName(row)} — their link already went out today at ${when}. The same message is never sent twice in one day. If it never arrived, check the log below and try again tomorrow.`,
        'warn',
      ),
      303,
    );
  }

  const outcome = await deliverBatch(c.env, [
    {
      participantId: row.id,
      to: row.email,
      kind: 'invite',
      message: inviteEmail({ name: row.name, email: row.email, token: row.token }, cfg),
    },
  ]);

  if (outcome.sent === 1) {
    if (next) return c.redirect(withParam(next, 'sent', '1'), 303);
    return c.redirect(backToEmail(`Sent ${displayName(row)} their personal link.`, 'good'), 303);
  }
  return c.redirect(
    backToEmail(
      `${displayName(row)} was not emailed. ${outcome.firstError ?? 'The provider gave no reason.'}`,
      'bad',
    ),
    303,
  );
});

/* ------------------------------------------------------------------ POST /send-reminders */

emailAdminRoutes.post('/send-reminders', async (c) => {
  if (!originLooksSane(c)) {
    return c.text('That request did not come from this site. Reload /admin/email and try again.', 403);
  }
  const cfg = loadConfig(c.env);
  const now = new Date();

  if (isPast(cfg.formDeadline, now)) {
    return c.redirect(
      backToEmail(
        `No reminders were sent. The form closed ${formatLocalDateTime(cfg.formDeadline, cfg.localUtcOffsetHours)}, so a reminder would point people at a form they cannot fill in. Change FORM_DEADLINE if you are extending it.`,
        'bad',
      ),
      303,
    );
  }

  const [rows, counts] = await Promise.all([
    listAll(c.env.DB),
    countsByParticipant(c.env.DB, 'reminder'),
  ]);
  // Identical rule to the cron; only the 09:00 weekday gate is being overridden.
  const eligible = selectReminderRecipients(rows, counts, now, cfg);
  if (eligible.length === 0) {
    return c.redirect(
      backToEmail(
        `Nobody was emailed. Everyone still outstanding has either had ${plural(cfg.maxReminders, 'reminder', 'reminders')} already or was emailed today.`,
        'warn',
      ),
      303,
    );
  }

  const batch = eligible.slice(0, MAX_PER_BATCH);
  background(
    c,
    deliverBatch(
      c.env,
      batch.map((row) => ({
        participantId: row.id,
        to: row.email,
        kind: 'reminder' as const,
        message: reminderEmail({ name: row.name, email: row.email, token: row.token }, cfg),
      })),
    ),
  );

  const parts = [`Sending ${plural(batch.length, 'reminder', 'reminders')} now.`];
  if (eligible.length > batch.length) {
    parts.push(`${eligible.length - batch.length} still to go — click Send reminders now again.`);
  }
  parts.push('Nobody here will be emailed again today.');
  return c.redirect(backToEmail(parts.join(' '), 'good'), 303);
});

/* ------------------------------------------------------------------ POST /send-announcement */

emailAdminRoutes.post('/send-announcement', async (c) => {
  if (!originLooksSane(c)) {
    return c.text('That request did not come from this site. Reload /admin/email and try again.', 403);
  }
  const cfg = loadConfig(c.env);
  const published = await getPublishedRun(c.env.DB);
  if (!published) {
    return c.redirect(
      backToEmail(
        'No announcement was sent because no run is published. Publish the run you want people to hear about on the review screen, then send it.',
        'bad',
      ),
      303,
    );
  }

  const rows = await listAll(c.env.DB);
  const sel = await selectAnnouncementRecipients(c.env.DB, published.id, rows);
  if (sel.teamCount === 0) {
    return c.redirect(
      backToEmail('The published run has no teams on it, so there was nothing to announce. Start a new grouping run.', 'bad'),
      303,
    );
  }
  if (sel.targets.length === 0) {
    return c.redirect(
      backToEmail('Nobody was emailed. Everyone on a published team has already been told which team they are on.', 'warn'),
      303,
    );
  }

  const batch = sel.targets.slice(0, MAX_PER_BATCH);
  background(
    c,
    deliverBatch(
      c.env,
      batch.map((job) => ({
        participantId: job.row.id,
        to: job.row.email,
        kind: 'team_announcement' as const,
        message: teamAnnouncementEmail(
          { name: job.row.name, email: job.row.email, token: job.row.token },
          { teamName: job.teamName, memberNames: job.memberNames, projectBrief: job.projectBrief },
          cfg,
        ),
      })),
    ),
  );

  const parts = [`Sending ${plural(batch.length, 'team announcement', 'team announcements')} now.`];
  if (sel.alreadyTold > 0) parts.push(`Skipped ${sel.alreadyTold} who had already been told.`);
  if (sel.unusableEmail > 0) parts.push(`Skipped ${sel.unusableEmail} with an unusable email address.`);
  if (sel.targets.length > batch.length) {
    parts.push(`${sel.targets.length - batch.length} still to go — click Send team announcement again.`);
  }
  parts.push('The log below fills in as they go out.');
  return c.redirect(backToEmail(parts.join(' '), 'good'), 303);
});
