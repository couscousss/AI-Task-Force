import { Hono } from 'hono';
import type { AppBindings } from '../env';
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
} from '../config';
import type { ParticipantRow } from '../types';
import { forgetCookie, rememberCookie, rememberedToken } from '../lib/remember';
import {
  ensureInvite,
  getByEmail,
  getByToken,
  saveSubmission,
  type FormSubmission,
} from '../db/participants';
import { formatLocalDate, formatLocalDateTime, isPast } from '../lib/dates';
import { verifyTurnstile } from '../lib/turnstile';
import {
  checkProblemStatement,
  isValidCategory,
  isValidEmail,
  isValidSkill,
  normalizeEmail,
  squish,
} from '../lib/validation';
import { Callout, Card, Layout } from '../ui/layout';

export const participantRoutes = new Hono<AppBindings>();

/* ------------------------------------------------------------------ shapes */

/** Every value the form can hold, as strings, so a failed submit can be re-rendered verbatim. */
interface Values {
  name: string;
  attending: string;
  email: string;
  department: string;
  problem_statement: string;
  category: string;
  skills: Record<SkillAxis, string>;
  has_personal_laptop: string;
  hopes: string;
}

type Errors = Record<string, string>;

interface FieldMeta {
  label: string;
  anchor: string;
}

/** Insertion order is the order the error summary lists problems in. */
const FIELD_META: Record<string, FieldMeta> = {
  name: { label: 'Your name', anchor: 'name' },
  attending: { label: 'Are you attending?', anchor: 'field-attending' },
  email: { label: 'Your email', anchor: 'email' },
  department: { label: 'Cluster', anchor: 'department' },
  problem_statement: { label: 'The work challenge', anchor: 'problem_statement' },
  // Anchors the fieldset, not an input: this is a radio group, so there is no single
  // element called `category` to jump to.
  category: { label: 'What you want to explore', anchor: 'field-category' },
  skill_understanding: { label: 'AI Understanding', anchor: 'field-skill-understanding' },
  skill_tools: { label: 'AI Tools', anchor: 'field-skill-tools' },
  skill_prompting: { label: 'Prompting', anchor: 'field-skill-prompting' },
  skill_building: { label: 'Building / Technical', anchor: 'field-skill-building' },
  has_personal_laptop: { label: 'Bringing a laptop', anchor: 'field-laptop' },
  hopes: { label: 'What you hope to walk away with', anchor: 'hopes' },
  turnstile: { label: 'The check that you are a person', anchor: 'field-turnstile' },
};

// ATTENDING.unsure is deliberately absent: the form offers yes or no only. The value is
// still understood everywhere else so that any row already carrying it keeps rendering.
const ATTENDING_OPTIONS: { value: string; label: string; desc?: string }[] = [
  { value: String(ATTENDING.yes), label: "Yes, I'll be there" },
  { value: String(ATTENDING.no), label: "No, I can't make it" },
];

/** 'notyet' and 'closed' both render the form read-only; only 'open' accepts a POST. */
type Phase = 'notyet' | 'open' | 'closed';

function phaseOf(cfg: EventConfig, now: Date = new Date()): Phase {
  if (!isPast(cfg.formOpens, now)) return 'notyet';
  if (isPast(cfg.formDeadline, now)) return 'closed';
  return 'open';
}

/* --------------------------------------------------------------- utilities */

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

function numOrEmpty(v: number | null): string {
  return v === null ? '' : String(v);
}

function valuesFromRow(row: ParticipantRow): Values {
  return {
    name: row.name ?? '',
    attending: numOrEmpty(row.attending),
    email: row.email,
    department: row.department ?? '',
    problem_statement: row.problem_statement ?? '',
    category: row.category ?? '',
    skills: {
      understanding: numOrEmpty(row.skill_understanding),
      tools: numOrEmpty(row.skill_tools),
      prompting: numOrEmpty(row.skill_prompting),
      building: numOrEmpty(row.skill_building),
    },
    has_personal_laptop: numOrEmpty(row.has_personal_laptop),
    hopes: row.hopes ?? '',
  };
}

function bodyField(body: Record<string, unknown>, key: string): string {
  const v = body[key];
  return typeof v === 'string' ? v : '';
}

function valuesFromBody(body: Record<string, unknown>): Values {
  return {
    name: bodyField(body, 'name'),
    attending: bodyField(body, 'attending'),
    email: bodyField(body, 'email'),
    department: bodyField(body, 'department'),
    problem_statement: bodyField(body, 'problem_statement'),
    category: bodyField(body, 'category'),
    skills: {
      understanding: bodyField(body, 'skill_understanding'),
      tools: bodyField(body, 'skill_tools'),
      prompting: bodyField(body, 'skill_prompting'),
      building: bodyField(body, 'skill_building'),
    },
    has_personal_laptop: bodyField(body, 'has_personal_laptop'),
    hopes: bodyField(body, 'hopes'),
  };
}

function attendingLabel(v: number | null): string {
  if (v === ATTENDING.yes) return 'Yes';
  if (v === ATTENDING.no) return 'No';
  if (v === ATTENDING.unsure) return 'Not sure yet';
  return 'Not answered';
}

function skillText(v: number | null): string {
  if (v === null) return 'Not answered';
  const step = SKILL_SCALE.find((s) => s.value === v);
  return step ? `${v} — ${step.name}` : String(v);
}

function fieldClass(err: string | undefined): string {
  return err ? 'field field-invalid' : 'field';
}

function describedBy(...ids: (string | undefined | false)[]): string | undefined {
  const list = ids.filter((s): s is string => typeof s === 'string' && s !== '');
  return list.length > 0 ? list.join(' ') : undefined;
}

/* ------------------------------------------------------------- page pieces */

function organizerContact(cfg: EventConfig) {
  const to = cfg.organizerEmails[0];
  return to ? (
    <p>
      Something wrong? Email the organizers at <a href={`mailto:${to}`}>{to}</a> and they can change it
      for you.
    </p>
  ) : (
    <p>Something wrong? Contact the organizers and they can change it for you.</p>
  );
}

function errorSummary(errors: Errors) {
  const items = Object.entries(FIELD_META)
    .map(([key, meta]) => ({ meta, message: errors[key] }))
    .filter((i): i is { meta: FieldMeta; message: string } => typeof i.message === 'string');
  if (items.length === 0) return null;
  return (
    <Callout tone="bad" title="Not saved yet">
      <p>
        {items.length === 1
          ? 'One answer needs fixing, then this will save:'
          : `${items.length} answers need fixing, then this will save:`}
      </p>
      <ul>
        {items.map((i) => (
          <li>
            <a href={`#${i.meta.anchor}`}>{i.meta.label}</a> — {i.message}
          </li>
        ))}
      </ul>
    </Callout>
  );
}

interface FormPageProps {
  cfg: EventConfig;
  row: ParticipantRow;
  values: Values;
  errors: Errors;
  phase: Phase;
  /** Set when a POST was refused outright (closed form, failed bot check): says so at the top. */
  blocked?: string;
  /** Where the form posts. Defaults to the personal link; `/join` uses the open one. */
  action?: string;
}

function FormPage({ cfg, row, values: v, errors, phase, blocked, action }: FormPageProps) {
  const readOnly = phase !== 'open';
  const deadline = formatLocalDateTime(cfg.formDeadline, cfg.localUtcOffsetHours);
  const opens = formatLocalDateTime(cfg.formOpens, cfg.localUtcOffsetHours);
  const eventDay = formatLocalDate(cfg.eventDate, cfg.localUtcOffsetHours);
  const head = cfg.turnstileSiteKey ? (
    <script src="https://challenges.cloudflare.com/turnstile/v0/api.js" async defer></script>
  ) : undefined;

  return (
    <Layout
      title={`Check in — ${cfg.eventName}`}
      head={head}
      scripts={readOnly ? undefined : ['/form.js']}
    >
      <header class="hero">
        <div class="hero-art" aria-hidden="true">
          <svg viewBox="0 0 240 160" role="presentation" focusable="false">
            <defs>
              <linearGradient id="hg" x1="0" y1="0" x2="1" y2="1">
                <stop offset="0%" stop-color="var(--hero-a)" />
                <stop offset="100%" stop-color="var(--hero-b)" />
              </linearGradient>
            </defs>
            {/* Four people, four sizes: the mix of experience a team is built from. */}
            <circle cx="52" cy="58" r="26" fill="url(#hg)" opacity="0.9" />
            <circle cx="112" cy="42" r="16" fill="url(#hg)" opacity="0.65" />
            <circle cx="160" cy="74" r="30" fill="url(#hg)" opacity="0.8" />
            <circle cx="96" cy="104" r="21" fill="url(#hg)" opacity="0.5" />
            <path
              d="M52 58 L112 42 M112 42 L160 74 M160 74 L96 104 M96 104 L52 58"
              stroke="var(--hero-line)"
              stroke-width="2.5"
              fill="none"
              stroke-linecap="round"
            />
          </svg>
        </div>
        <div class="hero-text">
          <p class="hero-eyebrow">{eventDay}</p>
          {/* The welcome names the event, so the heading is the welcome rather than the
              event name again — cfg.eventName still drives the page title and email. */}
          <h1>Welcome to the {cfg.eventName}!</h1>
          <p class="hero-lede">
            {phase === 'open'
              ? "Please indicate your availability and what you would like to build. Sky's the limit!"
              : 'Your check-in form.'}
          </p>
          {phase === 'open' ? (
            <p class="hero-meta">
              <span class="hero-pill">Closes {deadline}</span>
              <span class="hero-note">You can come back and change anything until then.</span>
            </p>
          ) : null}
        </div>
      </header>

      <main class="narrow" id="main">

        {phase === 'notyet' ? (
          <Callout tone="info" title="Not open yet">
            <p>
              This form opens on {opens}. Come back to this same link then — it will still work, and
              nothing you type before then is saved.
            </p>
          </Callout>
        ) : null}

        {phase === 'closed' ? (
          <Callout tone="warn" title="The form has closed">
            <p>
              Answers closed on {deadline}, so this is now read-only.{' '}
              {row.submitted_at
                ? 'Everything you told us is below, and it still counts.'
                : 'We did not get an answer from you before then.'}
            </p>
            {organizerContact(cfg)}
          </Callout>
        ) : null}

        {blocked ? (
          <Callout tone="bad" title="Not saved">
            <p>{blocked}</p>
          </Callout>
        ) : null}

        {!blocked ? errorSummary(errors) : null}

        {phase === 'open' && row.submitted_at && Object.keys(errors).length === 0 ? (
          <Callout tone="good" title="Saved">
            <p>
              We have your answers{row.name ? `, ${row.name}` : ''}. Change anything below and save again.
            </p>
            {/* This browser is remembered, so the shared link lands here rather than on a
                blank form. On a machine somebody else also uses, that is the wrong person —
                so the way out is on the page rather than something to be worked out. */}
            <p class="small">
              Not you? <a href="/join?new=1">Fill in a new response instead</a>.
            </p>
          </Callout>
        ) : null}

        <form method="post" action={action ?? `/r/${row.token}`} id="checkin-form">
          {/* 1. Name */}
          <div class={fieldClass(errors['name'])}>
            <label for="name">
              Your Name <span class="req" aria-hidden="true">*</span>
            </label>
            <input
              type="text"
              id="name"
              name="name"
              value={v.name}
              autocomplete="name"
              required
              disabled={readOnly}
              aria-invalid={errors['name'] ? 'true' : undefined}
              aria-describedby={describedBy(errors['name'] && 'err-name')}
            />
            {errors['name'] ? (
              <p class="error-text" id="err-name">
                {errors['name']}
              </p>
            ) : null}
          </div>

          {/* 2. Attending */}
          <fieldset
            id="field-attending"
            class={errors['attending'] ? 'field-invalid' : undefined}
            aria-invalid={errors['attending'] ? 'true' : undefined}
            aria-describedby={describedBy(errors['attending'] && 'err-attending')}
          >
            <legend class="fieldset-legend">
              Are you attending? <span class="req" aria-hidden="true">*</span>
            </legend>
            <div class="choices">
              {ATTENDING_OPTIONS.map((o) => (
                <label class="choice">
                  <input
                    type="radio"
                    name="attending"
                    value={o.value}
                    checked={v.attending === o.value}
                    required
                    disabled={readOnly}
                  />
                  <span>
                    <span class="choice-label">{o.label}</span>
                    {o.desc ? <span class="choice-desc">{o.desc}</span> : null}
                  </span>
                </label>
              ))}
            </div>
            {errors['attending'] ? (
              <p class="error-text" id="err-attending">
                {errors['attending']}
              </p>
            ) : null}
          </fieldset>

          {/* 3. Email — stays visible even for a decline: it is how we know who you are. */}
          <div class={fieldClass(errors['email'])}>
            <label for="email">
              Your Email <span class="req" aria-hidden="true">*</span>
            </label>
            <input
              type="email"
              id="email"
              name="email"
              value={v.email}
              autocomplete="email"
              required
              disabled={readOnly}
              aria-invalid={errors['email'] ? 'true' : undefined}
              aria-describedby={describedBy(errors['email'] && 'err-email')}
            />
            {errors['email'] ? (
              <p class="error-text" id="err-email">
                {errors['email']}
              </p>
            ) : null}
          </div>

          {/* Everything below is skipped for a decline. form.js hides it; the server never
              requires it when the answer is No. */}
          <div id="attending-details">
            {/* 4. Department */}
            <div class={fieldClass(errors['department'])}>
              <label for="department">
                Cluster{' '}
                <span class="req" aria-hidden="true">
                  *
                </span>
              </label>
              <input
                type="text"
                id="department"
                name="department"
                value={v.department}
                autocomplete="organization-title"
                disabled={readOnly}
                aria-invalid={errors['department'] ? 'true' : undefined}
                aria-describedby={describedBy(errors['department'] && 'err-department')}
              />
              {errors['department'] ? (
                <p class="error-text" id="err-department">
                  {errors['department']}
                </p>
              ) : null}
            </div>

            {/* 5. Problem statement */}
            <div class={fieldClass(errors['problem_statement'])}>
              <label for="problem_statement">
                What are some work challenges or processes you would like to improve or explore using AI?{' '}
                <span class="req" aria-hidden="true">*</span>
              </label>
              <p class="hint" id="problem-hint">
                Two or three sentences is plenty. Say what the task is and what makes it slow, repetitive
                or error-prone today. This is what we build the teams around, so it is the answer that
                matters most.
              </p>
              <textarea
                id="problem_statement"
                name="problem_statement"
                rows={7}
                disabled={readOnly}
                aria-invalid={errors['problem_statement'] ? 'true' : undefined}
                aria-describedby={describedBy(
                  'problem-hint',
                  errors['problem_statement'] && 'err-problem_statement',
                )}
              >
                {`\n${v.problem_statement}`}
              </textarea>
              <p class="hint small" id="problem_count" hidden></p>
              {errors['problem_statement'] ? (
                <p class="error-text" id="err-problem_statement">
                  {errors['problem_statement']}
                </p>
              ) : null}
            </div>

            {/* 6. Category */}
            {/* A list rather than a dropdown: each area carries a line explaining it, and a
                native <option> can only hold flat text. Same .choice markup as the attending
                question, so it already reads and behaves correctly on a phone. */}
            <fieldset
              id="field-category"
              class={errors['category'] ? 'field-invalid' : undefined}
              aria-invalid={errors['category'] ? 'true' : undefined}
              aria-describedby={describedBy('category-hint', errors['category'] && 'err-category')}
            >
              <legend class="fieldset-legend">
                Which area best relates to the work challenge you would like to explore?{' '}
                <span class="req" aria-hidden="true">
                  *
                </span>
              </legend>
              <p class="hint" id="category-hint">
                The closest fit is fine — "Not sure yet" is a real answer.
              </p>
              <div class="choices">
                {CATEGORIES.map((c) => (
                  <label class="choice">
                    <input
                      type="radio"
                      name="category"
                      value={c.value}
                      checked={v.category === c.value}
                      required
                      disabled={readOnly}
                    />
                    <span>
                      <span class="choice-label">
                        {/* Decorative: a screen reader announcing "gear emoji" before every
                            option is noise, and the label already says what the area is. */}
                        <span aria-hidden="true">{c.emoji}</span> {c.label}
                      </span>
                      <span class="choice-desc">{c.description}</span>
                    </span>
                  </label>
                ))}
              </div>
              {errors['category'] ? (
                <p class="error-text" id="err-category">
                  {errors['category']}
                </p>
              ) : null}
            </fieldset>

            {/* 7. Capability */}
            <h2>Your AI capability today</h2>
            {/* The 1-5 scale, stated once, in full, and always on the page. Each option
                below still carries its name, so a level is identifiable without scrolling
                back up here. */}
            <div class="scale-legend">
              <h3 class="scale-legend-title">What the numbers mean</h3>
              <ol class="scale-legend-list">
                {SKILL_SCALE.map((s) => (
                  <li>
                    <span class="scale-num">{s.value}</span>
                    <span>
                      <strong>{s.name}</strong> <span class="muted">{s.description}</span>
                    </span>
                  </li>
                ))}
              </ol>
            </div>

            {SKILL_AXES.map((axis) => {
              const key = `skill_${axis}`;
              const meta = SKILL_AXIS_LABELS[axis];
              const err = errors[key];
              return (
                <div
                  class={err ? 'scale field-invalid' : 'scale'}
                  id={`field-${key.replace('_', '-')}`}
                  role="radiogroup"
                  aria-labelledby={`${key}-label`}
                  aria-invalid={err ? 'true' : undefined}
                  aria-describedby={describedBy(err && `err-${key}`)}
                >
                  <div class="scale-head" id={`${key}-label`}>
                    <strong>{meta.label}</strong>
                    <span>{meta.description}</span>
                  </div>
                  <div class="scale-row">
                    {SKILL_SCALE.map((s) => (
                      <label class="scale-cell" title={`${s.value} — ${s.name}: ${s.description}`}>
                        <input
                          type="radio"
                          name={key}
                          value={String(s.value)}
                          checked={v.skills[axis] === String(s.value)}
                          disabled={readOnly}
                        />
                        <span class="scale-num">{s.value}</span>
                        <span class="scale-cell-name">{s.name}</span>
                      </label>
                    ))}
                  </div>
                  {err ? (
                    <p class="error-text" id={`err-${key}`}>
                      {err}
                    </p>
                  ) : null}
                </div>
              );
            })}

            {/* 8. Laptop */}
            <fieldset
              id="field-laptop"
              class={errors['has_personal_laptop'] ? 'field-invalid' : undefined}
              aria-invalid={errors['has_personal_laptop'] ? 'true' : undefined}
              aria-describedby={describedBy(
                'laptop-hint',
                errors['has_personal_laptop'] && 'err-has_personal_laptop',
              )}
            >
              <legend class="fieldset-legend">
                Can you bring a personal laptop? <span class="req" aria-hidden="true">*</span>
              </legend>
              <p class="hint" id="laptop-hint">
                We ask because personal machines usually let you install tools and reach AI services that
                locked-down corporate builds block. It changes what your team can actually build on the
                day, so we make sure every team has enough of them.
              </p>
              <div class="choices">
                <label class="choice">
                  <input
                    type="radio"
                    name="has_personal_laptop"
                    value="1"
                    checked={v.has_personal_laptop === '1'}
                    disabled={readOnly}
                  />
                  <span>
                    <span class="choice-label">Yes, I can bring one</span>
                  </span>
                </label>
                <label class="choice">
                  <input
                    type="radio"
                    name="has_personal_laptop"
                    value="0"
                    checked={v.has_personal_laptop === '0'}
                    disabled={readOnly}
                  />
                  <span>
                    <span class="choice-label">No</span>
                  </span>
                </label>
              </div>
              {errors['has_personal_laptop'] ? (
                <p class="error-text" id="err-has_personal_laptop">
                  {errors['has_personal_laptop']}
                </p>
              ) : null}
            </fieldset>

            {/* 9. Hopes */}
            <div class={fieldClass(errors['hopes'])}>
              <label for="hopes">
                What do you hope to accomplish during the AI Builders' Day?{' '}
                <span class="optional">optional</span>
              </label>
              <textarea
                id="hopes"
                name="hopes"
                rows={4}
                disabled={readOnly}
                aria-invalid={errors['hopes'] ? 'true' : undefined}
                aria-describedby={describedBy(errors['hopes'] && 'err-hopes')}
              >
                {`\n${v.hopes}`}
              </textarea>
              {errors['hopes'] ? (
                <p class="error-text" id="err-hopes">
                  {errors['hopes']}
                </p>
              ) : null}
            </div>
          </div>

          {!readOnly && cfg.turnstileSiteKey ? (
            <div class="field" id="field-turnstile">
              <div class="cf-turnstile" data-sitekey={cfg.turnstileSiteKey}></div>
              {errors['turnstile'] ? <p class="error-text">{errors['turnstile']}</p> : null}
            </div>
          ) : null}

          {readOnly ? null : (
            <div class="btn-row">
              <button type="submit" class="btn btn-wide">
                Save my answers
              </button>
            </div>
          )}
        </form>

        {readOnly ? null : (
          <p class="small muted">
            You can reopen this link and change your answers until {deadline}.
          </p>
        )}
      </main>
    </Layout>
  );
}

function AnswersTable({ row }: { row: ParticipantRow }) {
  const rows: { label: string; value: string }[] = [
    { label: 'Name', value: row.name ?? 'Not given' },
    { label: 'Attending', value: attendingLabel(row.attending) },
    { label: 'Email', value: row.email },
  ];
  if (row.attending !== ATTENDING.no) {
    rows.push({ label: 'Cluster', value: (row.department ?? '').trim() || 'Not given' });
    rows.push({ label: 'Work challenge', value: (row.problem_statement ?? '').trim() || 'Not given' });
    rows.push({ label: 'Wants to explore', value: categoryLabel(row.category) });
    for (const axis of SKILL_AXES) {
      rows.push({ label: SKILL_AXIS_LABELS[axis].label, value: skillText(skillOf(row, axis)) });
    }
    rows.push({
      label: 'Personal laptop',
      value:
        row.has_personal_laptop === 1 ? 'Yes' : row.has_personal_laptop === 0 ? 'No' : 'Not answered',
    });
    rows.push({ label: 'Hopes to walk away with', value: (row.hopes ?? '').trim() || 'Not given' });
  }
  return (
    <div class="table-scroll">
      <table>
        <tbody>
          {rows.map((r) => (
            <tr>
              <th scope="row">{r.label}</th>
              <td>{r.value}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function ConfirmationPage({ cfg, row, phase }: { cfg: EventConfig; row: ParticipantRow; phase: Phase }) {
  const declined = row.attending === ATTENDING.no;
  const deadline = formatLocalDateTime(cfg.formDeadline, cfg.localUtcOffsetHours);
  const eventDay = formatLocalDate(cfg.eventDate, cfg.localUtcOffsetHours);
  return (
    <Layout title={`Answers saved — ${cfg.eventName}`}>
      <main class="narrow" id="main">
        <h1>{declined ? 'Thanks for telling us' : 'Your answers are saved'}</h1>
        <Callout tone="good" title="Saved">
          {declined ? (
            <p>
              You are down as not attending, so there is nothing else to do. If your plans change, reopen
              this link before {deadline} and change your answer.
            </p>
          ) : (
            // Deliberately does not name a channel: sending mail from the app is optional and
            // off by default, and even configured the organizer chooses when to send — so
            // promising an email is a promise the app cannot keep on its own.
            <p>
              That is everything we need. You will get your team and your project before {eventDay}. You
              can change any of this until {deadline}.
            </p>
          )}
        </Callout>

        {/* Saying "come back any time" is only true if coming back is actually easy. It is
            the shared link people keep, not this personal URL, so say plainly that the
            shared one now works — and give them the personal one for a different device,
            where the cookie will not be. */}
        {phase === 'open' ? (
          <Callout tone="info" title="Coming back later">
            <p>
              On this device, just open the same link the organizers sent — it will bring you straight
              back here instead of asking again.
            </p>
            <p class="small">
              On a different phone or computer, use your own link:{' '}
              <a class="mono" href={`/r/${row.token}`}>{`/r/${row.token}`}</a>
            </p>
          </Callout>
        ) : null}

        <Card title="What you told us">
          <AnswersTable row={row} />
        </Card>

        {/* .grid picks up the `.card + .grid` top margin, so no bespoke spacing is needed. */}
        <div class="grid">
          <div class="btn-row">
            {phase === 'open' ? (
              <a class="btn btn-secondary" href={`/r/${row.token}`}>
                Edit your answers
              </a>
            ) : null}
          </div>
        </div>
        {phase === 'open' ? null : organizerContact(cfg)}
      </main>
    </Layout>
  );
}

/** Deliberately says nothing about whether this token was ever real. */
function UnknownLinkPage({ cfg }: { cfg: EventConfig }) {
  return (
    <Layout title={`Link not recognised — ${cfg.eventName}`}>
      <main class="narrow" id="main">
        <h1>That link did not work</h1>
        <p>
          Personal links end in a long code, and mail clients often break them across two lines. Go back
          to the email, copy the whole link — including everything after the last slash — and paste it
          into your browser in one piece.
        </p>
        {organizerContact(cfg)}
      </main>
    </Layout>
  );
}

/* ---------------------------------------------------------------- handlers */

/**
 * One validation pass, shared by the personal link and the open `/join` link, so the two
 * entry points can never drift on what counts as a valid answer.
 *
 * `current` is the row being edited, or null on the open link where the person is not
 * known yet. The only behavioural difference is the email check: on a personal link a
 * different address that already exists is a clash and is refused, whereas on the open
 * link an existing address simply means we are updating that person's answers.
 */
async function validateSubmission(
  db: D1Database,
  body: Record<string, unknown>,
  current: ParticipantRow | null,
): Promise<{ values: Values; errors: Errors; submission: FormSubmission | null }> {
  const v = valuesFromBody(body);
  const errors: Errors = {};

  const name = squish(v.name);
  if (name === '') errors['name'] = 'Add your name so the organizers know whose answers these are.';
  else if (name.length > 120) errors['name'] = 'That is too long for the name field — 120 characters or fewer.';

  const attending =
    v.attending === String(ATTENDING.yes)
      ? ATTENDING.yes
      : v.attending === String(ATTENDING.no)
        ? ATTENDING.no
        : v.attending === String(ATTENDING.unsure)
          ? ATTENDING.unsure
          : null;
  if (attending === null) {
    errors['attending'] = 'Pick one: yes, no, or not sure yet. "Not sure yet" still keeps your place.';
  }

  const email = normalizeEmail(v.email);
  if (email === '') {
    errors['email'] = 'Add your email — it is how we send you your team.';
  } else if (!isValidEmail(email)) {
    errors['email'] = 'That does not look like an email address. Check for a missing @ or a typo in the domain.';
  } else if (current && email !== current.email) {
    const clash = await getByEmail(db, email);
    if (clash && clash.id !== current.id) {
      errors['email'] =
        'We already have a separate form for that address. Use the personal link that was emailed to it, or ask the organizers to merge the two.';
    }
  }

  const department = squish(v.department);
  if (department.length > 120) {
    errors['department'] = 'That is too long — 120 characters or fewer.';
  } else if (department === '' && attending !== ATTENDING.no) {
    errors['department'] = 'Add your cluster.';
  }

  // A decline is a complete answer. Everything below is optional in that case, and the
  // server is the authority: form.js only hides these fields, it never enforces anything.
  const declining = attending === ATTENDING.no;

  const problemStatement = v.problem_statement.trim();
  if (!declining) {
    const check = checkProblemStatement(problemStatement);
    if (!check.ok) errors['problem_statement'] = check.message ?? 'Please describe the challenge.';
  }

  const category = isValidCategory(v.category) ? v.category : null;
  if (!declining && category === null) {
    errors['category'] = 'Choose the closest fit. "Not sure yet" is a real answer.';
  }

  const skillValues: Partial<Record<SkillAxis, number>> = {};
  for (const axis of SKILL_AXES) {
    const raw = v.skills[axis];
    if (isValidSkill(raw)) {
      skillValues[axis] = Number(raw);
    } else if (!declining) {
      errors[`skill_${axis}`] = `Pick a level for ${SKILL_AXIS_LABELS[axis].label}. Your honest guess is the right answer.`;
    }
  }
  const { understanding, tools, prompting, building } = skillValues;
  const skills =
    understanding !== undefined && tools !== undefined && prompting !== undefined && building !== undefined
      ? { understanding, tools, prompting, building }
      : null;

  const laptop = v.has_personal_laptop === '1' ? 1 : v.has_personal_laptop === '0' ? 0 : null;
  if (!declining && laptop === null) {
    errors['has_personal_laptop'] =
      'Say yes or no. Teams are built around who can bring a machine, so we cannot leave this blank.';
  }

  const hopes = v.hopes.trim();
  if (hopes.length > 2000) errors['hopes'] = 'That is longer than we can store. Trim it to about 2000 characters.';

  if (Object.keys(errors).length > 0 || attending === null) {
    return { values: v, errors, submission: null };
  }

  return {
    values: v,
    errors,
    submission: {
      name,
      email,
      attending,
      department: department || null,
      problem_statement: problemStatement || null,
      category,
      skills,
      has_personal_laptop: laptop,
      hopes: hopes || null,
    },
  };
}

/** A stand-in row for the open link, where nobody is identified until they submit. */
function blankRow(): ParticipantRow {
  return {
    id: '', token: '', email: '', name: null, department: null, attending: null,
    problem_statement: null, category: null, skill_understanding: null, skill_tools: null,
    skill_prompting: null, skill_building: null, has_personal_laptop: null, hopes: null,
    submitted_at: null, updated_at: null,
  };
}

participantRoutes.get('/r/:token', async (c) => {
  const cfg = loadConfig(c.env);
  const row = await getByToken(c.env.DB, c.req.param('token'));
  if (!row) return c.html(<UnknownLinkPage cfg={cfg} />, 404);

  const phase = phaseOf(cfg);
  if (c.req.query('saved') === '1' && row.submitted_at) {
    return c.html(<ConfirmationPage cfg={cfg} row={row} phase={phase} />);
  }
  return c.html(<FormPage cfg={cfg} row={row} values={valuesFromRow(row)} errors={{}} phase={phase} />);
});

participantRoutes.post('/r/:token', async (c) => {
  const cfg = loadConfig(c.env);
  const row = await getByToken(c.env.DB, c.req.param('token'));
  if (!row) return c.html(<UnknownLinkPage cfg={cfg} />, 404);

  const phase = phaseOf(cfg);
  if (phase !== 'open') {
    // Show what we already hold rather than what they just typed — nothing was saved.
    return c.html(
      <FormPage
        cfg={cfg}
        row={row}
        values={valuesFromRow(row)}
        errors={{}}
        phase={phase}
        blocked={
          phase === 'closed'
            ? `Nothing was saved — the form closed on ${formatLocalDateTime(cfg.formDeadline, cfg.localUtcOffsetHours)}. What is shown below is what we already have.`
            : `Nothing was saved — the form does not open until ${formatLocalDateTime(cfg.formOpens, cfg.localUtcOffsetHours)}.`
        }
      />,
      403,
    );
  }

  const body = await c.req.parseBody();
  const v = valuesFromBody(body);
  const errors: Errors = {};

  if (cfg.turnstileSiteKey) {
    const ok = await verifyTurnstile(
      c.env,
      bodyField(body, 'cf-turnstile-response') || null,
      c.req.header('CF-Connecting-IP') ?? null,
    );
    if (!ok) {
      errors['turnstile'] =
        'The check that you are a person did not complete. Reload this page, tick the box, and save again.';
      return c.html(
        <FormPage
          cfg={cfg}
          row={row}
          values={v}
          errors={errors}
          phase={phase}
          blocked={errors['turnstile']}
        />,
        400,
      );
    }
  }

  const { values, errors: fieldErrors, submission } = await validateSubmission(c.env.DB, body, row);
  if (!submission) {
    return c.html(<FormPage cfg={cfg} row={row} values={values} errors={fieldErrors} phase={phase} />, 422);
  }
  await saveSubmission(c.env.DB, row, submission);

  // Remember them here as well as on /join: somebody who arrived by their emailed personal
  // link should still be recognised if they later open the shared one.
  c.header('Set-Cookie', rememberCookie(row.token, c.req.url));

  // POST-redirect-GET: a refresh on the confirmation must not resubmit.
  return c.redirect(`/r/${row.token}?saved=1`, 303);
});

/* ------------------------------------------------------------------ the open link */

/**
 * `/join` is the single URL an organizer can put in one message to the whole department.
 * No token, no invite list needed: whoever opens it fills the same form, and their email
 * becomes their identity. Filling it in again from the same address updates the same
 * record rather than creating a second one, so a colleague who loses their link can just
 * open /join again.
 */
participantRoutes.get('/join', async (c) => {
  const cfg = loadConfig(c.env);

  // Somebody who has already answered on this device gets their own answers back rather
  // than a blank form. ?new=1 is the way out for a shared machine, and is linked from the
  // form itself.
  if (c.req.query('new') !== '1') {
    const token = rememberedToken(c.req.header('Cookie'));
    if (token) {
      // Look the row up before redirecting: an organizer may have deleted them, and a
      // redirect to a dead token would land them on "that link did not work" with no idea
      // why. A stale cookie is cleared instead.
      const known = await getByToken(c.env.DB, token);
      if (known) return c.redirect(`/r/${known.token}`, 302);
      c.header('Set-Cookie', forgetCookie(c.req.url));
    }
  } else {
    c.header('Set-Cookie', forgetCookie(c.req.url));
  }

  return c.html(
    <FormPage
      cfg={cfg}
      row={blankRow()}
      values={valuesFromRow(blankRow())}
      errors={{}}
      phase={phaseOf(cfg)}
      action="/join"
    />,
  );
});

participantRoutes.post('/join', async (c) => {
  const cfg = loadConfig(c.env);
  const phase = phaseOf(cfg);

  if (phase !== 'open') {
    return c.html(
      <FormPage
        cfg={cfg}
        row={blankRow()}
        values={valuesFromRow(blankRow())}
        errors={{}}
        phase={phase}
        action="/join"
        blocked={
          phase === 'closed'
            ? `Nothing was saved — the form closed on ${formatLocalDateTime(cfg.formDeadline, cfg.localUtcOffsetHours)}.`
            : `Nothing was saved — the form does not open until ${formatLocalDateTime(cfg.formOpens, cfg.localUtcOffsetHours)}.`
        }
      />,
      403,
    );
  }

  const body = await c.req.parseBody();

  if (cfg.turnstileSiteKey) {
    const ok = await verifyTurnstile(
      c.env,
      bodyField(body, 'cf-turnstile-response') || null,
      c.req.header('CF-Connecting-IP') ?? null,
    );
    if (!ok) {
      const blocked =
        'The check that you are a person did not complete. Reload this page, tick the box, and save again.';
      return c.html(
        <FormPage
          cfg={cfg}
          row={blankRow()}
          values={valuesFromBody(body)}
          errors={{ turnstile: blocked }}
          phase={phase}
          action="/join"
          blocked={blocked}
        />,
        400,
      );
    }
  }

  const { values, errors, submission } = await validateSubmission(c.env.DB, body, null);
  if (!submission) {
    return c.html(
      <FormPage cfg={cfg} row={blankRow()} values={values} errors={errors} phase={phase} action="/join" />,
      422,
    );
  }

  // Their email is the identity. Returning from the same address edits the same record.
  const { row } = await ensureInvite(c.env.DB, { name: submission.name, email: submission.email });
  await saveSubmission(c.env.DB, row, submission);

  // From here on, opening the shared link on this device brings their answers back.
  c.header('Set-Cookie', rememberCookie(row.token, c.req.url));

  return c.redirect(`/r/${row.token}?saved=1`, 303);
});
