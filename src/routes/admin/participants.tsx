import { Hono } from 'hono';
import type { FC } from 'hono/jsx';
import type { AppBindings } from '../../env';
import type { ParticipantRow } from '../../types';
import { AdminPage, Callout, Card, EmptyState } from '../../ui/layout';
import {
  adminUpdate,
  deleteParticipant,
  ensureInvite,
  getByEmail,
  getById,
  listAll,
} from '../../db/participants';
import {
  ATTENDING,
  CATEGORIES,
  SKILL_AXES,
  SKILL_AXIS_LABELS,
  SKILL_SCALE,
  categoryLabel,
  loadConfig,
  type EventConfig,
  type SkillAxis,
} from '../../config';
import { toCsv } from '../../lib/csv';
import { isValidEmail, normalizeEmail, squish } from '../../lib/validation';
import { originLooksSane } from '../../lib/auth';
import { formatLocalDateTime, toLocalParts } from '../../lib/dates';
import { nowIso } from '../../lib/ids';

export const participantAdminRoutes = new Hono<AppBindings>();

/* ------------------------------------------------------------------ shared bits */

function personalLink(cfg: EventConfig, row: ParticipantRow): string {
  return `${cfg.publicOrigin}/r/${row.token}`;
}

function displayName(row: ParticipantRow): string {
  return squish(row.name) || row.email;
}

const ATTENDING_OPTIONS: { value: string; label: string }[] = [
  { value: '', label: 'No response yet' },
  { value: String(ATTENDING.yes), label: 'Attending' },
  { value: String(ATTENDING.no), label: 'Declined' },
  { value: String(ATTENDING.unsure), label: 'Not sure yet' },
];

const AXIS_LETTER: Record<SkillAxis, string> = {
  understanding: 'U',
  tools: 'T',
  prompting: 'P',
  building: 'B',
};

function skillOf(row: ParticipantRow, axis: SkillAxis): number | null {
  switch (axis) {
    case 'understanding':
      return row.skill_understanding;
    case 'tools':
      return row.skill_tools;
    case 'prompting':
      return row.skill_prompting;
    case 'building':
      return row.skill_building;
  }
}

const AttendingTag: FC<{ value: number | null }> = ({ value }) => {
  if (value === ATTENDING.yes) return <span class="tag tag-yes">Attending</span>;
  if (value === ATTENDING.no) return <span class="tag tag-no">Declined</span>;
  if (value === ATTENDING.unsure) return <span class="tag tag-maybe">Not sure</span>;
  return <span class="tag tag-none">No response</span>;
};

const LaptopTag: FC<{ value: number | null }> = ({ value }) => {
  if (value === 1) return <span class="tag tag-yes">Laptop</span>;
  if (value === 0) return <span class="tag tag-no">No laptop</span>;
  return <span class="tag tag-none">Not answered</span>;
};

/** Four separate pips, never a total. The number is the text, not just the colour. */
const SkillPips: FC<{ row: ParticipantRow }> = ({ row }) => (
  <span class="chip-meta">
    {SKILL_AXES.map((axis) => {
      const v = skillOf(row, axis);
      return (
        <span
          class="skillpip"
          data-level={v === null ? '' : String(v)}
          title={`${SKILL_AXIS_LABELS[axis].label}: ${v === null ? 'not answered' : `${v} of 5`}`}
        >
          {AXIS_LETTER[axis]}
          {v === null ? '–' : v}
        </span>
      );
    })}
  </span>
);

/* ------------------------------------------------------------------ list + filters */

interface Filters {
  q: string;
  attending: string;
  submitted: string;
  laptop: string;
}

function readFilters(url: URL): Filters {
  return {
    q: (url.searchParams.get('q') ?? '').trim(),
    attending: url.searchParams.get('attending') ?? 'all',
    submitted: url.searchParams.get('submitted') ?? 'all',
    laptop: url.searchParams.get('laptop') ?? 'all',
  };
}

function filtersActive(f: Filters): boolean {
  return f.q !== '' || f.attending !== 'all' || f.submitted !== 'all' || f.laptop !== 'all';
}

function filterQuery(f: Filters): string {
  const p = new URLSearchParams();
  if (f.q) p.set('q', f.q);
  if (f.attending !== 'all') p.set('attending', f.attending);
  if (f.submitted !== 'all') p.set('submitted', f.submitted);
  if (f.laptop !== 'all') p.set('laptop', f.laptop);
  const s = p.toString();
  return s ? `?${s}` : '';
}

function matches(row: ParticipantRow, f: Filters): boolean {
  if (f.attending === 'yes' && row.attending !== ATTENDING.yes) return false;
  if (f.attending === 'no' && row.attending !== ATTENDING.no) return false;
  if (f.attending === 'unsure' && row.attending !== ATTENDING.unsure) return false;
  if (f.attending === 'none' && row.attending !== null) return false;

  if (f.submitted === 'yes' && !row.submitted_at) return false;
  if (f.submitted === 'no' && row.submitted_at) return false;

  if (f.laptop === 'yes' && row.has_personal_laptop !== 1) return false;
  if (f.laptop === 'no' && row.has_personal_laptop !== 0) return false;
  if (f.laptop === 'unknown' && row.has_personal_laptop !== null) return false;

  if (f.q !== '') {
    const needle = f.q.toLowerCase();
    const hay = [row.name, row.email, row.department, row.problem_statement]
      .map((v) => (v ?? '').toLowerCase())
      .join('   ');
    if (!hay.includes(needle)) return false;
  }
  return true;
}

function truncate(text: string | null, max: number): string {
  const s = squish(text);
  if (s === '') return '';
  return s.length <= max ? s : `${s.slice(0, max - 1)}…`;
}

participantAdminRoutes.get('/', async (c) => {
  const cfg = loadConfig(c.env);
  const email = c.get('adminEmail');
  const url = new URL(c.req.url);
  const f = readFilters(url);
  const all = await listAll(c.env.DB);
  const rows = all.filter((r) => matches(r, f));
  const backTo = `/admin/participants${filterQuery(f)}`;
  const deleted = url.searchParams.get('deleted');
  const sent = url.searchParams.get('sent');

  const actions = (
    <>
      <a class="btn" href="/admin/participants/export.csv">
        Export CSV
      </a>
      <a class="btn btn-secondary" href="/admin/participants/new">
        Add a walk-in
      </a>
    </>
  );

  return c.html(
    <AdminPage
      title="Participants"
      active="participants"
      email={email}
      heading="Participants"
      lede="Everyone on the invite list, whether or not they have answered."
      actions={actions}
    >
      {deleted ? (
        <Callout tone="good" title="Participant deleted">
          {deleted} is no longer on the list.
        </Callout>
      ) : null}
      {sent ? (
        <Callout tone="good" title="Link sent">
          The personal link is on its way. Check <a href="/admin/email">Email</a> for the log.
        </Callout>
      ) : null}

      {all.length === 0 ? (
        <Card>
          <EmptyState
            title="Upload your invite list to get started"
            body="Nobody is invited yet. Upload a CSV of names and emails, and everyone gets their own link."
            action={
              <a class="btn" href="/admin/invites">
                Upload invite list
              </a>
            }
          />
        </Card>
      ) : (
        <Card>
          <form class="toolbar" method="get" action="/admin/participants" role="search">
            <label class="small nowrap" for="q">
              Search
            </label>
            <input
              type="search"
              id="q"
              name="q"
              value={f.q}
              placeholder="Name, email, department, problem"
              style="min-width:14rem"
            />

            <label class="small nowrap" for="attending">
              Attending
            </label>
            <select id="attending" name="attending">
              <option value="all" selected={f.attending === 'all'}>
                Anyone
              </option>
              <option value="yes" selected={f.attending === 'yes'}>
                Attending
              </option>
              <option value="no" selected={f.attending === 'no'}>
                Declined
              </option>
              <option value="unsure" selected={f.attending === 'unsure'}>
                Not sure
              </option>
              <option value="none" selected={f.attending === 'none'}>
                No response
              </option>
            </select>

            <label class="small nowrap" for="submitted">
              Form
            </label>
            <select id="submitted" name="submitted">
              <option value="all" selected={f.submitted === 'all'}>
                Any
              </option>
              <option value="yes" selected={f.submitted === 'yes'}>
                Submitted
              </option>
              <option value="no" selected={f.submitted === 'no'}>
                Not submitted
              </option>
            </select>

            <label class="small nowrap" for="laptop">
              Laptop
            </label>
            <select id="laptop" name="laptop">
              <option value="all" selected={f.laptop === 'all'}>
                Any
              </option>
              <option value="yes" selected={f.laptop === 'yes'}>
                Yes
              </option>
              <option value="no" selected={f.laptop === 'no'}>
                No
              </option>
              <option value="unknown" selected={f.laptop === 'unknown'}>
                Not answered
              </option>
            </select>

            <button class="btn btn-secondary btn-small" type="submit">
              Apply filters
            </button>
            {filtersActive(f) ? (
              <a class="small" href="/admin/participants">
                Clear filters
              </a>
            ) : null}
          </form>

          <p class="small muted">
            Showing {rows.length} of {all.length}. Skill pips are{' '}
            {SKILL_AXES.map((a) => `${AXIS_LETTER[a]} ${SKILL_AXIS_LABELS[a].label}`).join(' · ')}
            , each rated 1–5. Export CSV always contains everyone, whatever is filtered here.
          </p>

          {rows.length === 0 ? (
            <EmptyState
              title="No one matches those filters"
              body="Widen the search or clear the filters to see the whole list again."
              action={
                <a class="btn btn-secondary" href="/admin/participants">
                  Clear filters
                </a>
              }
            />
          ) : (
            <div class="table-scroll">
              <table>
                <thead>
                  <tr>
                    <th scope="col">Name</th>
                    <th scope="col">Email</th>
                    <th scope="col">Department</th>
                    <th scope="col">Attending</th>
                    <th scope="col">Laptop</th>
                    <th scope="col">Skills</th>
                    <th scope="col">Form</th>
                    <th scope="col">Problem statement</th>
                    <th scope="col">Personal link</th>
                  </tr>
                </thead>
                <tbody>
                  {rows.map((r) => (
                    <tr>
                      <td>
                        <a href={`/admin/participants/${r.id}`}>{displayName(r)}</a>
                      </td>
                      <td class="mono">{r.email}</td>
                      <td>{squish(r.department) || <span class="muted">—</span>}</td>
                      <td>
                        <AttendingTag value={r.attending} />
                      </td>
                      <td>
                        <LaptopTag value={r.has_personal_laptop} />
                      </td>
                      <td>
                        <SkillPips row={r} />
                      </td>
                      <td>
                        {r.submitted_at ? (
                          <span class="tag tag-yes">Submitted</span>
                        ) : (
                          <span class="tag tag-none">Not yet</span>
                        )}
                      </td>
                      <td>
                        {truncate(r.problem_statement, 90) || <span class="muted">—</span>}
                      </td>
                      <td>
                        <input
                          type="text"
                          class="mono"
                          readonly={true}
                          value={personalLink(cfg, r)}
                          aria-label={`Personal link for ${displayName(r)}`}
                          style="min-width:16rem"
                        />
                        <form method="post" action="/admin/email/send-invite">
                          <input type="hidden" name="id" value={r.id} />
                          <input type="hidden" name="next" value={backTo} />
                          <button class="btn btn-secondary btn-small" type="submit">
                            Resend link
                          </button>
                        </form>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </Card>
      )}
    </AdminPage>,
  );
});

/* ------------------------------------------------------------------ CSV export */

function attendingWord(v: number | null): string {
  if (v === ATTENDING.yes) return 'Attending';
  if (v === ATTENDING.no) return 'Declined';
  if (v === ATTENDING.unsure) return 'Not sure';
  return 'No response';
}

function yesNo(v: number | null): string {
  if (v === 1) return 'Yes';
  if (v === 0) return 'No';
  return '';
}

/**
 * The escape hatch (spec §3.3): every column collected, in a file an organizer can group
 * by hand in a spreadsheet. Deliberately unaffected by the table filters — a partial
 * export at 8am on the day would silently lose people.
 */
participantAdminRoutes.get('/export.csv', async (c) => {
  const cfg = loadConfig(c.env);
  const rows = await listAll(c.env.DB);
  const headers = [
    'id',
    'email',
    'name',
    'department',
    'attending',
    'problem_statement',
    'category',
    'skill_understanding',
    'skill_tools',
    'skill_prompting',
    'skill_building',
    'has_personal_laptop',
    'hopes',
    'submitted_at',
    'updated_at',
    'personal_link',
  ];
  const data = rows.map((r) => [
    r.id,
    r.email,
    r.name ?? '',
    r.department ?? '',
    attendingWord(r.attending),
    r.problem_statement ?? '',
    categoryLabel(r.category),
    r.skill_understanding ?? '',
    r.skill_tools ?? '',
    r.skill_prompting ?? '',
    r.skill_building ?? '',
    yesNo(r.has_personal_laptop),
    r.hopes ?? '',
    r.submitted_at ?? '',
    r.updated_at ?? '',
    personalLink(cfg, r),
  ]);
  const stamp = toLocalParts(new Date(), cfg.localUtcOffsetHours).dateKey;
  return new Response(toCsv(headers, data), {
    headers: {
      'Content-Type': 'text/csv; charset=utf-8',
      'Content-Disposition': `attachment; filename="builder-day-participants-${stamp}.csv"`,
      'Cache-Control': 'no-store',
    },
  });
});

/* ------------------------------------------------------------------ edit form */

interface EditValues {
  name: string;
  email: string;
  department: string;
  attending: string;
  category: string;
  skills: Record<SkillAxis, string>;
  laptop: string;
  problem_statement: string;
  hopes: string;
  submitted: boolean;
}

function valuesFromRow(row: ParticipantRow): EditValues {
  return {
    name: row.name ?? '',
    email: row.email,
    department: row.department ?? '',
    attending: row.attending === null ? '' : String(row.attending),
    category: row.category ?? '',
    skills: {
      understanding: row.skill_understanding === null ? '' : String(row.skill_understanding),
      tools: row.skill_tools === null ? '' : String(row.skill_tools),
      prompting: row.skill_prompting === null ? '' : String(row.skill_prompting),
      building: row.skill_building === null ? '' : String(row.skill_building),
    },
    laptop: row.has_personal_laptop === null ? '' : String(row.has_personal_laptop),
    problem_statement: row.problem_statement ?? '',
    hopes: row.hopes ?? '',
    submitted: row.submitted_at !== null,
  };
}

function str(body: Record<string, unknown>, key: string): string {
  const v = body[key];
  return typeof v === 'string' ? v : '';
}

function valuesFromBody(body: Record<string, unknown>): EditValues {
  return {
    name: str(body, 'name'),
    email: str(body, 'email'),
    department: str(body, 'department'),
    attending: str(body, 'attending'),
    category: str(body, 'category'),
    skills: {
      understanding: str(body, 'skill_understanding'),
      tools: str(body, 'skill_tools'),
      prompting: str(body, 'skill_prompting'),
      building: str(body, 'skill_building'),
    },
    laptop: str(body, 'has_personal_laptop'),
    problem_statement: str(body, 'problem_statement'),
    hopes: str(body, 'hopes'),
    submitted: str(body, 'submitted') !== '',
  };
}

function levelOrNull(v: string): number | null {
  if (v === '') return null;
  const n = Number(v);
  return Number.isInteger(n) && n >= 1 && n <= 5 ? n : null;
}

const SkillSelect: FC<{ axis: SkillAxis; value: string; idPrefix: string }> = ({
  axis,
  value,
  idPrefix,
}) => {
  const id = `${idPrefix}-${axis}`;
  return (
    <div class="field">
      <label for={id}>{SKILL_AXIS_LABELS[axis].label}</label>
      <p class="hint">{SKILL_AXIS_LABELS[axis].description}</p>
      <select id={id} name={`skill_${axis}`}>
        <option value="" selected={value === ''}>
          Not answered
        </option>
        {SKILL_SCALE.map((s) => (
          <option value={String(s.value)} selected={value === String(s.value)}>
            {s.value} · {s.name}
          </option>
        ))}
      </select>
    </div>
  );
};

const CoreFields: FC<{ v: EditValues; errors: Record<string, string>; idPrefix: string }> = ({
  v,
  errors,
  idPrefix,
}) => (
  <>
    <div class={`field ${errors.name ? 'field-invalid' : ''}`}>
      <label for={`${idPrefix}-name`}>Name</label>
      <input type="text" id={`${idPrefix}-name`} name="name" value={v.name} autocomplete="off" />
      {errors.name ? <p class="error-text">{errors.name}</p> : null}
    </div>
    <div class={`field ${errors.email ? 'field-invalid' : ''}`}>
      <label for={`${idPrefix}-email`}>
        Email <span class="req">*</span>
      </label>
      <input
        type="email"
        id={`${idPrefix}-email`}
        name="email"
        value={v.email}
        autocomplete="off"
        required
      />
      {errors.email ? <p class="error-text">{errors.email}</p> : null}
    </div>
    <div class="field">
      <label for={`${idPrefix}-department`}>Department or team</label>
      <input
        type="text"
        id={`${idPrefix}-department`}
        name="department"
        value={v.department}
        autocomplete="off"
      />
    </div>
    <div class="field">
      <label for={`${idPrefix}-attending`}>Are they attending?</label>
      <select id={`${idPrefix}-attending`} name="attending">
        {ATTENDING_OPTIONS.map((o) => (
          <option value={o.value} selected={v.attending === o.value}>
            {o.label}
          </option>
        ))}
      </select>
    </div>
    <div class="field">
      <label for={`${idPrefix}-laptop`}>Can they bring a personal laptop?</label>
      <p class="hint">Every team needs two. This is a hard constraint in the solver.</p>
      <select id={`${idPrefix}-laptop`} name="has_personal_laptop">
        <option value="" selected={v.laptop === ''}>
          Not answered
        </option>
        <option value="1" selected={v.laptop === '1'}>
          Yes
        </option>
        <option value="0" selected={v.laptop === '0'}>
          No
        </option>
      </select>
    </div>
    {SKILL_AXES.map((axis) => (
      <SkillSelect axis={axis} value={v.skills[axis]} idPrefix={idPrefix} />
    ))}
  </>
);

/* ------------------------------------------------------------------ add a walk-in */

const NewPage: FC<{
  email: string;
  v: EditValues;
  errors: Record<string, string>;
}> = ({ email, v, errors }) => (
  <AdminPage
    title="Add a walk-in"
    active="participants"
    email={email}
    heading="Add a walk-in"
    lede="For someone standing in front of you who was never on the invite list. A name and an email is enough — fill in the rest if you have a moment."
    actions={
      <a class="btn btn-secondary" href="/admin/participants">
        Back to participants
      </a>
    }
  >
    {errors.form ? (
      <Callout tone="bad" title="Not added">
        {errors.form}
      </Callout>
    ) : null}
    <Card>
      <form method="post" action="/admin/participants/new">
        <CoreFields v={v} errors={errors} idPrefix="new" />
        <div class="field">
          <label for="new-problem">What do they want to work on?</label>
          <p class="hint">
            Optional here — they can write it themselves on their personal link, which you get on
            the next screen.
          </p>
          <textarea id="new-problem" name="problem_statement" rows={4}>
            {`\n${v.problem_statement}`}
          </textarea>
        </div>
        <div class="btn-row">
          <button class="btn" type="submit">
            Add participant
          </button>
          <a class="btn btn-secondary" href="/admin/participants">
            Cancel
          </a>
        </div>
      </form>
    </Card>
  </AdminPage>
);

function emptyValues(): EditValues {
  return {
    name: '',
    email: '',
    department: '',
    attending: String(ATTENDING.yes),
    category: '',
    skills: { understanding: '', tools: '', prompting: '', building: '' },
    laptop: '',
    problem_statement: '',
    hopes: '',
    submitted: false,
  };
}

participantAdminRoutes.get('/new', (c) => {
  return c.html(<NewPage email={c.get('adminEmail')} v={emptyValues()} errors={{}} />);
});

participantAdminRoutes.post('/new', async (c) => {
  if (!originLooksSane(c)) {
    return c.text('That request did not come from this site. Reload the page and try again.', 403);
  }
  const body = (await c.req.parseBody()) as Record<string, unknown>;
  const v = valuesFromBody(body);
  const errors: Record<string, string> = {};

  const email = normalizeEmail(v.email);
  if (email === '') errors.email = 'An email address is required — it is how their link is addressed.';
  else if (!isValidEmail(email)) errors.email = `"${v.email.trim()}" is not a valid email address. Check for a missing @ or a typo in the domain.`;

  if (!errors.email) {
    const existing = await getByEmail(c.env.DB, email);
    if (existing) {
      errors.form = `${email} is already on the list as ${displayName(existing)}. Open their record to edit it or resend their link.`;
    }
  }
  if (Object.keys(errors).length > 0) {
    return c.html(<NewPage email={c.get('adminEmail')} v={v} errors={errors} />, 400);
  }

  const { row } = await ensureInvite(c.env.DB, { name: squish(v.name) || null, email });
  const attending = v.attending === '' ? null : Number(v.attending);
  // A walk-in is a person standing in the room, so they count as a response the moment
  // they are added. Without submitted_at they are excluded from listAttendingSubmitted,
  // which is the only source for both the review board and the solver — they would be
  // ungroupable and undraggable, and the runbook's "drag them onto a team" would fail.
  await adminUpdate(c.env.DB, row.id, {
    name: squish(v.name) || null,
    submitted_at: attending === ATTENDING.yes ? (row.submitted_at ?? nowIso()) : row.submitted_at,
    department: squish(v.department) || null,
    attending,
    problem_statement: squish(v.problem_statement) || null,
    skill_understanding: levelOrNull(v.skills.understanding),
    skill_tools: levelOrNull(v.skills.tools),
    skill_prompting: levelOrNull(v.skills.prompting),
    skill_building: levelOrNull(v.skills.building),
    has_personal_laptop: v.laptop === '' ? null : Number(v.laptop),
  });
  return c.redirect(`/admin/participants/${row.id}?added=1`, 303);
});

/* ------------------------------------------------------------------ detail / edit */

const DetailPage: FC<{
  email: string;
  cfg: EventConfig;
  row: ParticipantRow;
  v: EditValues;
  errors: Record<string, string>;
  notice: 'added' | 'saved' | null;
}> = ({ email, cfg, row, v, errors, notice }) => {
  const link = personalLink(cfg, row);
  const name = displayName(row);
  return (
    <AdminPage
      title={`${name} — Participants`}
      active="participants"
      email={email}
      heading={name}
      lede={row.email}
      actions={
        <a class="btn btn-secondary" href="/admin/participants">
          Back to participants
        </a>
      }
    >
      {notice === 'added' ? (
        <Callout tone="good" title="Participant added">
          Hand them this link — it opens their form, already addressed to them.
        </Callout>
      ) : null}
      {notice === 'saved' ? (
        <Callout tone="good" title="Changes saved">
          {name} is up to date.
        </Callout>
      ) : null}
      {errors.form ? (
        <Callout tone="bad" title="Not saved">
          {errors.form}
        </Callout>
      ) : null}

      <Card title="Personal link" sub="Unguessable, and the only way they reach their form.">
        <div class="field">
          <label for="personal-link">Their link</label>
          <input type="text" id="personal-link" class="mono" readonly={true} value={link} />
        </div>
        <div class="btn-row">
          <form method="post" action="/admin/email/send-invite">
            <input type="hidden" name="id" value={row.id} />
            <input type="hidden" name="next" value={`/admin/participants/${row.id}`} />
            <button class="btn btn-secondary" type="submit">
              Resend link
            </button>
          </form>
          <a class="btn btn-secondary" href={link}>
            Open their form
          </a>
          {notice === 'added' ? (
            <a class="btn btn-secondary" href="/admin/participants/new">
              Add another walk-in
            </a>
          ) : null}
        </div>
        <p class="small muted">
          Submitted{' '}
          {row.submitted_at
            ? formatLocalDateTime(row.submitted_at, cfg.localUtcOffsetHours)
            : 'never'}
          . Last updated{' '}
          {row.updated_at ? formatLocalDateTime(row.updated_at, cfg.localUtcOffsetHours) : 'never'}.
        </p>
      </Card>

      <Card title="Edit their answers" sub="Anything you change here is what the solver sees.">
        <form method="post" action={`/admin/participants/${row.id}`}>
          <CoreFields v={v} errors={errors} idPrefix="edit" />
          <div class="field">
            <label for="edit-category">What they want to build</label>
            <select id="edit-category" name="category">
              <option value="" selected={v.category === ''}>
                Not specified
              </option>
              {CATEGORIES.map((cat) => (
                <option value={cat.value} selected={v.category === cat.value}>
                  {cat.label}
                </option>
              ))}
            </select>
          </div>
          <div class="field">
            <label for="edit-problem">Work challenge to explore</label>
            <textarea id="edit-problem" name="problem_statement" rows={6}>
              {`\n${v.problem_statement}`}
            </textarea>
          </div>
          <div class="field">
            <label for="edit-hopes">What they hope to walk away with</label>
            <textarea id="edit-hopes" name="hopes" rows={4}>
              {`\n${v.hopes}`}
            </textarea>
          </div>
          <div class="field">
            <label class="choice" for="edit-submitted">
              <input
                type="checkbox"
                id="edit-submitted"
                name="submitted"
                value="1"
                checked={v.submitted}
              />
              <span class="choice-label">
                Counts as submitted
                <span class="choice-desc">
                  Only people who said yes and are marked submitted go into a grouping run. Tick this
                  if you filled the form in on their behalf.
                </span>
              </span>
            </label>
          </div>
          <div class="btn-row">
            <button class="btn" type="submit">
              Save changes
            </button>
            <a class="btn btn-secondary" href="/admin/participants">
              Cancel
            </a>
          </div>
        </form>
      </Card>

      <Card title="Remove from the list" sub="For duplicates and people who were never invited.">
        <p class="small muted">
          Deleting removes them from every team as well. To record a no-show instead, set Attending
          to Declined — that keeps the record and the count.
        </p>
        <a class="btn btn-danger" href={`/admin/participants/${row.id}/delete`}>
          Delete participant
        </a>
      </Card>
    </AdminPage>
  );
};

participantAdminRoutes.get('/:id', async (c) => {
  const row = await getById(c.env.DB, c.req.param('id'));
  if (!row) return notFound(c.req.url);
  const url = new URL(c.req.url);
  const notice = url.searchParams.has('added')
    ? ('added' as const)
    : url.searchParams.has('saved')
      ? ('saved' as const)
      : null;
  return c.html(
    <DetailPage
      email={c.get('adminEmail')}
      cfg={loadConfig(c.env)}
      row={row}
      v={valuesFromRow(row)}
      errors={{}}
      notice={notice}
    />,
  );
});

participantAdminRoutes.post('/:id', async (c) => {
  if (!originLooksSane(c)) {
    return c.text('That request did not come from this site. Reload the page and try again.', 403);
  }
  const id = c.req.param('id');
  const row = await getById(c.env.DB, id);
  if (!row) return notFound(c.req.url);

  const body = (await c.req.parseBody()) as Record<string, unknown>;
  const v = valuesFromBody(body);
  const errors: Record<string, string> = {};

  const email = normalizeEmail(v.email);
  if (email === '') errors.email = 'An email address is required — it is how their link is addressed.';
  else if (!isValidEmail(email)) errors.email = `"${v.email.trim()}" is not a valid email address. Check for a missing @ or a typo in the domain.`;

  if (!errors.email && email !== row.email) {
    const clash = await getByEmail(c.env.DB, email);
    if (clash && clash.id !== row.id) {
      errors.email = `${email} already belongs to ${displayName(clash)}. Two people cannot share an address — edit that record instead, or delete the duplicate.`;
    }
  }
  if (Object.keys(errors).length > 0) {
    return c.html(
      <DetailPage
        email={c.get('adminEmail')}
        cfg={loadConfig(c.env)}
        row={row}
        v={v}
        errors={errors}
        notice={null}
      />,
      400,
    );
  }

  await adminUpdate(c.env.DB, row.id, {
    name: squish(v.name) || null,
    email,
    department: squish(v.department) || null,
    attending: v.attending === '' ? null : Number(v.attending),
    category: v.category === '' ? null : v.category,
    problem_statement: v.problem_statement.trim() || null,
    hopes: v.hopes.trim() || null,
    skill_understanding: levelOrNull(v.skills.understanding),
    skill_tools: levelOrNull(v.skills.tools),
    skill_prompting: levelOrNull(v.skills.prompting),
    skill_building: levelOrNull(v.skills.building),
    has_personal_laptop: v.laptop === '' ? null : Number(v.laptop),
    submitted_at: v.submitted ? (row.submitted_at ?? nowIso()) : null,
  });
  return c.redirect(`/admin/participants/${row.id}?saved=1`, 303);
});

/* ------------------------------------------------------------------ delete */

participantAdminRoutes.get('/:id/delete', async (c) => {
  const row = await getById(c.env.DB, c.req.param('id'));
  if (!row) return notFound(c.req.url);
  const name = displayName(row);
  return c.html(
    <AdminPage
      title={`Delete ${name}?`}
      active="participants"
      email={c.get('adminEmail')}
      heading={`Delete ${name}?`}
      lede="This removes their answers and takes them off any team they were placed on. It cannot be undone."
    >
      <Card>
        <p>
          <strong>{name}</strong> · {row.email}
          {row.submitted_at ? ' · has filled in the form' : ' · has not filled in the form'}
        </p>
        <div class="btn-row">
          <form method="post" action={`/admin/participants/${row.id}/delete`}>
            <button class="btn btn-danger" type="submit">
              Delete participant
            </button>
          </form>
          <a class="btn btn-secondary" href={`/admin/participants/${row.id}`}>
            Keep them
          </a>
        </div>
      </Card>
    </AdminPage>,
  );
});

participantAdminRoutes.post('/:id/delete', async (c) => {
  if (!originLooksSane(c)) {
    return c.text('That request did not come from this site. Reload the page and try again.', 403);
  }
  const row = await getById(c.env.DB, c.req.param('id'));
  if (!row) return notFound(c.req.url);
  const name = displayName(row);
  await deleteParticipant(c.env.DB, row.id);
  return c.redirect(`/admin/participants?deleted=${encodeURIComponent(name)}`, 303);
});

function notFound(url: string): Response {
  return new Response(
    `No participant with that id. They may already have been deleted — go back to /admin/participants.\n\n${url}\n`,
    { status: 404, headers: { 'Content-Type': 'text/plain; charset=utf-8' } },
  );
}
