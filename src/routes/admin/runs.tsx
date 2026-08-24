import { Hono } from 'hono';
import type { FC } from 'hono/jsx';
import type { AppBindings } from '../../env';
import type { GroupingRunRow, RunStatus } from '../../types';
import type { ScoreBreakdown, Violation } from '../../grouping/types';
import { AdminPage, Callout, Card, EmptyState, Stat } from '../../ui/layout';
import { DEFAULT_SOLVER_PARAMS, loadConfig, type SolverParams } from '../../config';
import {
  createRun,
  deleteRun,
  getRun,
  listRuns,
  parseParams,
  parseScore,
  parseThemes,
  parseViolations,
} from '../../db/runs';
import { listAttendingSubmitted } from '../../db/participants';
import { executeRun } from '../../run/pipeline';
import { originLooksSane } from '../../lib/auth';
import { newSeed } from '../../lib/ids';
import { formatLocalDateTime } from '../../lib/dates';

export const runRoutes = new Hono<AppBindings>();

/* ------------------------------------------------------------------ shared bits */

const IN_PROGRESS: RunStatus[] = ['pending', 'clustering', 'solving', 'naming'];

function isRunning(row: GroupingRunRow): boolean {
  return IN_PROGRESS.includes(row.status);
}

const STATUS_WORD: Record<RunStatus, string> = {
  pending: 'Queued',
  clustering: 'Clustering',
  solving: 'Balancing teams',
  naming: 'Naming teams',
  done: 'Finished',
  failed: 'Failed',
};

const StatusTag: FC<{ row: GroupingRunRow }> = ({ row }) => {
  const cls =
    row.status === 'done' ? 'tag tag-yes' : row.status === 'failed' ? 'tag tag-no' : 'tag tag-maybe';
  return <span class={cls}>{STATUS_WORD[row.status]}</span>;
};

/** Violation messages already begin with their code; show the code as a tag instead. */
function violationBody(v: Violation): string {
  return v.message.replace(/^H[1-4]:\s*/, '');
}

const ViolationList: FC<{ violations: Violation[] }> = ({ violations }) => (
  <ul class="team-issues">
    {violations.map((v) => (
      <li>
        <span class="tag tag-no">{v.code}</span> {violationBody(v)}
      </li>
    ))}
  </ul>
);

const SCORE_COMPONENTS: { key: keyof Omit<ScoreBreakdown, 'weighted_total'>; label: string; help: string }[] = [
  {
    key: 'theme_cohesion',
    label: 'Shared problem',
    help: 'How much of each team came from the same problem theme. 1.00 means everyone on every team shares a theme.',
  },
  {
    key: 'skill_diversity',
    label: 'Skill mix inside teams',
    help: 'How wide the spread of skill levels is within a team. Higher is better — a team of all-beginners or all-experts learns less.',
  },
  {
    key: 'across_team_balance',
    label: 'Balance between teams',
    help: '0.00 means every team is about as capable as every other. The further below 0, the more one team is stacked.',
  },
  {
    key: 'category_match',
    label: 'Same kind of project',
    help: 'How many people on a team picked the same "what would you like to build" answer.',
  },
  {
    key: 'department_mixing',
    label: 'Departments mixed',
    help: 'Distinct departments per team, as a share of team size. Higher means more cross-functional teams.',
  },
];

function fmt(n: number | undefined): string {
  return typeof n === 'number' && Number.isFinite(n) ? n.toFixed(2) : '—';
}

/* ------------------------------------------------------------------ params form */

interface ParamFormValues {
  target_team_size: string;
  min_team_size: string;
  max_team_size: string;
  min_laptops_per_team: string;
  builder_threshold: string;
  novice_threshold: string;
  theme_cohesion: string;
  skill_diversity: string;
  across_team_balance: string;
  category_match: string;
  department_mixing: string;
  enforce_laptops: boolean;
  enforce_builder: boolean;
  enforce_not_all_novice: boolean;
  seed: string;
}

function valuesFromParams(p: SolverParams): ParamFormValues {
  return {
    target_team_size: String(p.target_team_size),
    min_team_size: String(p.min_team_size),
    max_team_size: String(p.max_team_size),
    min_laptops_per_team: String(p.min_laptops_per_team),
    builder_threshold: String(p.builder_threshold),
    novice_threshold: String(p.novice_threshold),
    theme_cohesion: String(p.weights.theme_cohesion),
    skill_diversity: String(p.weights.skill_diversity),
    across_team_balance: String(p.weights.across_team_balance),
    category_match: String(p.weights.category_match),
    department_mixing: String(p.weights.department_mixing),
    enforce_laptops: p.constraints.enforce_laptops,
    enforce_builder: p.constraints.enforce_builder,
    enforce_not_all_novice: p.constraints.enforce_not_all_novice,
    seed: '',
  };
}

function str(body: Record<string, unknown>, key: string): string {
  const v = body[key];
  return typeof v === 'string' ? v.trim() : '';
}

function valuesFromBody(body: Record<string, unknown>): ParamFormValues {
  return {
    target_team_size: str(body, 'target_team_size'),
    min_team_size: str(body, 'min_team_size'),
    max_team_size: str(body, 'max_team_size'),
    min_laptops_per_team: str(body, 'min_laptops_per_team'),
    builder_threshold: str(body, 'builder_threshold'),
    novice_threshold: str(body, 'novice_threshold'),
    theme_cohesion: str(body, 'theme_cohesion'),
    skill_diversity: str(body, 'skill_diversity'),
    across_team_balance: str(body, 'across_team_balance'),
    category_match: str(body, 'category_match'),
    department_mixing: str(body, 'department_mixing'),
    enforce_laptops: str(body, 'enforce_laptops') === '1',
    enforce_builder: str(body, 'enforce_builder') === '1',
    enforce_not_all_novice: str(body, 'enforce_not_all_novice') === '1',
    seed: str(body, 'seed'),
  };
}

type FieldErrors = Record<string, string>;

interface ParsedForm {
  params: SolverParams;
  seed: number;
  errors: FieldErrors;
}

function readInt(
  v: ParamFormValues,
  key: keyof ParamFormValues,
  label: string,
  min: number,
  max: number,
  errors: FieldErrors,
  fallback: number,
): number {
  const raw = String(v[key] ?? '');
  const n = Number(raw);
  if (raw === '' || !Number.isFinite(n) || !Number.isInteger(n)) {
    errors[key] = `${label} must be a whole number between ${min} and ${max}. Type a number and try again.`;
    return fallback;
  }
  if (n < min || n > max) {
    errors[key] = `${label} is ${n}. It must be between ${min} and ${max}.`;
    return fallback;
  }
  return n;
}

function readWeight(v: ParamFormValues, key: keyof ParamFormValues, label: string, errors: FieldErrors, fallback: number): number {
  const raw = String(v[key] ?? '');
  const n = Number(raw);
  if (raw === '' || !Number.isFinite(n)) {
    errors[key] = `${label} must be a number, for example 1.5. Leave it at 0 to ignore this entirely.`;
    return fallback;
  }
  if (n < 0) {
    errors[key] = `${label} is ${n}. Weights cannot be negative — set it to 0 to ignore this component.`;
    return fallback;
  }
  return n;
}

function parseParamForm(v: ParamFormValues): ParsedForm {
  const errors: FieldErrors = {};
  const d = DEFAULT_SOLVER_PARAMS;

  const min = readInt(v, 'min_team_size', 'Smallest team', 1, 20, errors, d.min_team_size);
  const target = readInt(v, 'target_team_size', 'Target team size', 1, 20, errors, d.target_team_size);
  const max = readInt(v, 'max_team_size', 'Largest team', 1, 20, errors, d.max_team_size);
  const laptops = readInt(v, 'min_laptops_per_team', 'Laptops per team', 0, 20, errors, d.min_laptops_per_team);
  const builder = readInt(v, 'builder_threshold', 'Builder rating', 1, 5, errors, d.builder_threshold);
  const novice = readInt(v, 'novice_threshold', 'Beginner rating', 1, 5, errors, d.novice_threshold);

  if (!errors['min_team_size'] && !errors['max_team_size'] && min > max) {
    errors['min_team_size'] = `The smallest team (${min}) is bigger than the largest (${max}). Lower the smallest, or raise the largest.`;
  }
  if (!errors['target_team_size'] && !errors['min_team_size'] && !errors['max_team_size']) {
    if (target < min || target > max) {
      errors['target_team_size'] = `The target of ${target} sits outside the ${min}–${max} range. Set a target between them.`;
    }
  }
  if (!errors['min_laptops_per_team'] && !errors['max_team_size'] && laptops > max) {
    errors['min_laptops_per_team'] = `You are asking for ${laptops} laptops on teams of at most ${max} people. Lower the laptop minimum, or raise the largest team size.`;
  }

  const weights = {
    theme_cohesion: readWeight(v, 'theme_cohesion', 'Shared problem', errors, d.weights.theme_cohesion),
    skill_diversity: readWeight(v, 'skill_diversity', 'Skill mix inside teams', errors, d.weights.skill_diversity),
    across_team_balance: readWeight(v, 'across_team_balance', 'Balance between teams', errors, d.weights.across_team_balance),
    category_match: readWeight(v, 'category_match', 'Same kind of project', errors, d.weights.category_match),
    department_mixing: readWeight(v, 'department_mixing', 'Departments mixed', errors, d.weights.department_mixing),
  };

  let seed = newSeed();
  if (v.seed !== '') {
    const n = Number(v.seed);
    if (!Number.isInteger(n) || n < 0 || n > 2147483647) {
      errors['seed'] = 'A seed must be a whole number from 0 to 2147483647. Clear the box to get a fresh random seed.';
    } else {
      seed = n;
    }
  }

  return {
    params: {
      target_team_size: target,
      min_team_size: min,
      max_team_size: max,
      min_laptops_per_team: laptops,
      builder_threshold: builder,
      novice_threshold: novice,
      weights,
      constraints: {
        enforce_laptops: v.enforce_laptops,
        enforce_builder: v.enforce_builder,
        enforce_not_all_novice: v.enforce_not_all_novice,
      },
      max_local_search_iterations: DEFAULT_SOLVER_PARAMS.max_local_search_iterations,
      local_search_patience: DEFAULT_SOLVER_PARAMS.local_search_patience,
    },
    seed,
    errors,
  };
}

const NumField: FC<{
  name: keyof ParamFormValues;
  label: string;
  help: string;
  value: string;
  errors: FieldErrors;
  min?: string;
  max?: string;
  step?: string;
  placeholder?: string;
}> = ({ name, label, help, value, errors, min, max, step, placeholder }) => {
  const err = errors[name];
  return (
    <div class={`field ${err ? 'field-invalid' : ''}`}>
      <label for={name}>{label}</label>
      <p class="hint" id={`${name}-help`}>
        {help}
      </p>
      <input
        type="number"
        id={name}
        name={name}
        value={value}
        min={min}
        max={max}
        step={step ?? '1'}
        placeholder={placeholder}
        inputmode="decimal"
        aria-describedby={err ? `${name}-help ${name}-error` : `${name}-help`}
        aria-invalid={err ? 'true' : undefined}
      />
      {err ? (
        <p class="error-text" id={`${name}-error`}>
          {err}
        </p>
      ) : null}
    </div>
  );
};

const ToggleField: FC<{ name: keyof ParamFormValues; label: string; help: string; checked: boolean }> = ({
  name,
  label,
  help,
  checked,
}) => (
  <label class="choice" for={name}>
    <input type="checkbox" id={name} name={name} value="1" checked={checked} />
    <span>
      <span class="choice-label">{label}</span>
      <span class="choice-desc">{help}</span>
    </span>
  </label>
);

const RunParamsForm: FC<{ v: ParamFormValues; errors: FieldErrors; attending: number }> = ({
  v,
  errors,
  attending,
}) => {
  const target = Number(v.target_team_size);
  const estimate =
    attending > 0 && Number.isFinite(target) && target > 0 ? Math.max(1, Math.round(attending / target)) : 0;
  return (
    <form method="post" action="/admin/runs">
      <Card title="Team sizes" sub="How big a team should be, and how far the solver may stray from that.">
        <div class="grid grid-3">
          <NumField
            name="target_team_size"
            label="Target team size"
            help="What you are aiming for. The number of teams is worked out from this and how many people are attending."
            value={v.target_team_size}
            errors={errors}
            min="1"
            max="20"
          />
          <NumField
            name="min_team_size"
            label="Smallest team"
            help="No team may end up with fewer people than this."
            value={v.min_team_size}
            errors={errors}
            min="1"
            max="20"
          />
          <NumField
            name="max_team_size"
            label="Largest team"
            help="No team may end up with more people than this."
            value={v.max_team_size}
            errors={errors}
            min="1"
            max="20"
          />
        </div>
        {estimate > 0 ? (
          <p class="small muted">
            {attending} people have confirmed and submitted the form, so expect roughly {estimate}{' '}
            {estimate === 1 ? 'team' : 'teams'}.
          </p>
        ) : null}
      </Card>

      <Card title="What every team must have" sub="These are checked for every team. Anything that cannot be satisfied is reported in words, never silently dropped.">
        <div class="grid grid-3">
          <NumField
            name="min_laptops_per_team"
            label="Laptops per team"
            help="How many people on a team must be bringing their own laptop. Two is usually the difference between building something and watching someone build."
            value={v.min_laptops_per_team}
            errors={errors}
            min="0"
            max="20"
          />
          <NumField
            name="builder_threshold"
            label="Counts as a builder at"
            help="Every team needs at least one person who rated themselves this or higher on Building / Technical, out of 5."
            value={v.builder_threshold}
            errors={errors}
            min="1"
            max="5"
          />
          <NumField
            name="novice_threshold"
            label="Counts as new to AI at"
            help="Someone at or below this on all four ratings counts as new to AI. No team may be made up entirely of them."
            value={v.novice_threshold}
            errors={errors}
            min="1"
            max="5"
          />
        </div>
        <fieldset>
          <legend class="fieldset-legend">Which of these the solver should actively work to fix</legend>
          <p class="hint">
            Turning one off does not hide the problem — it is still counted and reported. It only stops the
            solver trading other things away to chase it. Turn one off when you already know the pool cannot
            satisfy it.
          </p>
          <div class="choices">
            <ToggleField
              name="enforce_laptops"
              label="Fix laptop shortfalls"
              help="Move laptop owners around so every team reaches the minimum."
              checked={v.enforce_laptops}
            />
            <ToggleField
              name="enforce_builder"
              label="Fix teams with no builder"
              help="Spread the people who rated themselves highly on Building across the teams."
              checked={v.enforce_builder}
            />
            <ToggleField
              name="enforce_not_all_novice"
              label="Fix all-beginner teams"
              help="Break up teams where nobody has used AI much, so every table has someone to get it started."
              checked={v.enforce_not_all_novice}
            />
          </div>
        </fieldset>
      </Card>

      <Card
        title="What to optimise for"
        sub="Once the rules above are met, these decide between two otherwise-legal sets of teams. Bigger number = matters more. 0 = ignore it."
      >
        <div class="grid grid-2">
          {SCORE_COMPONENTS.map((comp) => (
            <NumField
              name={comp.key}
              label={comp.label}
              help={comp.help}
              value={String(v[comp.key])}
              errors={errors}
              min="0"
              max="100"
              step="0.1"
            />
          ))}
        </div>
      </Card>

      <Card
        title="Seed"
        sub="The same seed with the same people and the same settings always produces exactly the same teams."
      >
        <NumField
          name="seed"
          label="Seed (optional)"
          help="Leave this empty for a fresh random seed. Type the seed of an earlier run to reproduce it exactly, which is how you tell whether a change to the settings actually changed anything."
          value={v.seed}
          errors={errors}
          min="0"
          max="2147483647"
          placeholder="Random"
        />
        <div class="btn-row">
          <button class="btn" type="submit">
            Start run
          </button>
          <a class="btn btn-secondary" href="/admin/runs">
            Back to runs
          </a>
        </div>
      </Card>
    </form>
  );
};

/* ------------------------------------------------------------------ list */

runRoutes.get('/', async (c) => {
  const cfg = loadConfig(c.env);
  const email = c.get('adminEmail');
  const runs = await listRuns(c.env.DB);
  const countsRes = await c.env.DB.prepare(
    `SELECT run_id, COUNT(*) AS n FROM teams GROUP BY run_id`,
  ).all<{ run_id: string; n: number }>();
  const teamCounts = new Map<string, number>();
  for (const row of countsRes.results ?? []) teamCounts.set(row.run_id, row.n);

  const deleted = new URL(c.req.url).searchParams.get('deleted');

  return c.html(
    <AdminPage
      title="Grouping runs"
      active="runs"
      email={email}
      heading="Grouping runs"
      lede="Each run is a complete, immutable set of teams. Re-running never changes an old run — it makes a new one, so you can always compare and go back."
      actions={
        <a class="btn" href="/admin/runs/new">
          Start a run
        </a>
      }
    >
      {deleted ? (
        <Callout tone="good" title="Run deleted">
          That run and its teams are gone. The participants themselves are untouched.
        </Callout>
      ) : null}

      {runs.length === 0 ? (
        <Card>
          <EmptyState
            title="No teams have been built yet"
            body="Start a run and the system clusters everyone's problem statements into themes, then builds balanced teams around them. You can run it as many times as you like."
            action={
              <a class="btn" href="/admin/runs/new">
                Start a run
              </a>
            }
          />
        </Card>
      ) : (
        <Card
          title={`${runs.length} ${runs.length === 1 ? 'run' : 'runs'}`}
          sub="Newest first. Compare the score and the number of unsolved problems to decide which set of teams to publish."
        >
          <div class="table-scroll">
            <table>
              <thead>
                <tr>
                  <th scope="col">Started</th>
                  <th scope="col">Status</th>
                  <th scope="col" class="num">
                    Teams
                  </th>
                  <th scope="col" class="num">
                    Score
                  </th>
                  <th scope="col" class="num">
                    Unsolved
                  </th>
                  <th scope="col" class="num">
                    Seed
                  </th>
                  <th scope="col">
                    <span class="visually-hidden">Actions</span>
                  </th>
                </tr>
              </thead>
              <tbody>
                {runs.map((r) => {
                  const score = parseScore(r);
                  const violations = parseViolations(r);
                  return (
                    <tr>
                      <td>
                        <a href={`/admin/runs/${r.id}`}>
                          {formatLocalDateTime(r.created_at, cfg.localUtcOffsetHours)}
                        </a>
                        {r.is_published === 1 ? (
                          <>
                            {' '}
                            <span class="tag tag-yes">Published</span>
                          </>
                        ) : null}
                      </td>
                      <td>
                        <StatusTag row={r} />
                      </td>
                      <td class="num">{teamCounts.get(r.id) ?? 0}</td>
                      <td class="num">{score ? fmt(score.weighted_total) : '—'}</td>
                      <td class="num">
                        {r.status === 'done' ? (
                          violations.length === 0 ? (
                            <span class="tag tag-yes">None</span>
                          ) : (
                            violations.length
                          )
                        ) : (
                          '—'
                        )}
                      </td>
                      <td class="num mono">{r.seed}</td>
                      <td>
                        {r.status === 'done' ? (
                          <a class="btn btn-secondary btn-small" href={`/admin/review/${r.id}`}>
                            Review teams
                          </a>
                        ) : (
                          <a class="btn btn-secondary btn-small" href={`/admin/runs/${r.id}`}>
                            Open
                          </a>
                        )}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
          <p class="small muted">
            Score is the weighted total of the five things a run optimises for; it is only comparable
            between runs that used the same weights. "Unsolved" counts constraints the pool or the
            arrangement could not satisfy — open a run to read them in full.
          </p>
        </Card>
      )}
    </AdminPage>,
  );
});

/* ------------------------------------------------------------------ new run form */

runRoutes.get('/new', async (c) => {
  const email = c.get('adminEmail');
  const url = new URL(c.req.url);
  const attendees = await listAttendingSubmitted(c.env.DB);

  // "Start another run" from a finished run carries its settings across.
  let base = DEFAULT_SOLVER_PARAMS;
  const from = url.searchParams.get('from');
  if (from) {
    const prev = await getRun(c.env.DB, from);
    if (prev) base = parseParams(prev, DEFAULT_SOLVER_PARAMS);
  }

  return c.html(
    <AdminPage
      title="Start a grouping run"
      active="runs"
      email={email}
      heading="Start a grouping run"
      lede="Everything here has a sensible default. Change something only if you already know why."
    >
      {from ? (
        <Callout tone="info" title="Settings copied from the previous run">
          You are starting from the settings of an earlier run. The seed is blank, so you will get a
          different arrangement unless you type that run's seed in below.
        </Callout>
      ) : null}
      {attendees.length === 0 ? (
        <Callout tone="warn" title="Nobody has submitted the form yet">
          Only people who said they are attending <em>and</em> completed the form are grouped. Until
          someone does, a run has nothing to work with. Check{' '}
          <a href="/admin/participants">Participants</a> to see who is outstanding.
        </Callout>
      ) : null}
      <RunParamsForm v={valuesFromParams(base)} errors={{}} attending={attendees.length} />
    </AdminPage>,
  );
});

/* ------------------------------------------------------------------ start a run */

runRoutes.post('/', async (c) => {
  if (!originLooksSane(c)) {
    return c.text('That request did not come from this site. Reload the page and try again.', 403);
  }
  const email = c.get('adminEmail');
  const body = (await c.req.parseBody()) as Record<string, unknown>;
  const values = valuesFromBody(body);
  const parsed = parseParamForm(values);
  const attendees = await listAttendingSubmitted(c.env.DB);

  if (attendees.length === 0) {
    parsed.errors['target_team_size'] =
      parsed.errors['target_team_size'] ??
      'There is nobody to group yet. A run only includes people who said they are attending and submitted the form.';
  }

  if (Object.keys(parsed.errors).length > 0) {
    return c.html(
      <AdminPage
        title="Start a grouping run"
        active="runs"
        email={email}
        heading="Start a grouping run"
        lede="Everything here has a sensible default. Change something only if you already know why."
      >
        <Callout tone="bad" title="The run did not start">
          {Object.keys(parsed.errors).length === 1
            ? 'One setting needs fixing — it is marked below.'
            : `${Object.keys(parsed.errors).length} settings need fixing — they are marked below.`}{' '}
          Nothing has been saved, so nothing was lost.
        </Callout>
        <RunParamsForm v={values} errors={parsed.errors} attending={attendees.length} />
      </AdminPage>,
      422,
    );
  }

  const run = await createRun(c.env.DB, parsed.params, parsed.seed);

  // The solver plus two LLM calls is far too long for a request. Return now, work after.
  const work = executeRun(c.env, run.id).catch((err) => {
    console.error('executeRun failed outside the request', run.id, err);
  });
  try {
    c.executionCtx.waitUntil(work);
  } catch {
    // No execution context (some test harnesses). The promise is already running.
  }

  return c.redirect(`/admin/runs/${run.id}`, 303);
});

/* ------------------------------------------------------------------ status JSON */

runRoutes.get('/:id/status', async (c) => {
  const row = await getRun(c.env.DB, c.req.param('id'));
  if (!row) return c.json({ error: 'No such run' }, 404);
  return c.json({ status: row.status, progress: row.progress ?? '', error: row.error ?? null });
});

/* ------------------------------------------------------------------ run detail */

runRoutes.get('/:id', async (c) => {
  const cfg = loadConfig(c.env);
  const email = c.get('adminEmail');
  const id = c.req.param('id');
  const row = await getRun(c.env.DB, id);
  if (!row) return runNotFound(c.req.url);

  const url = new URL(c.req.url);
  const confirmDelete = url.searchParams.get('confirm') === 'delete';
  const params = parseParams(row, DEFAULT_SOLVER_PARAMS);
  const score = parseScore(row);
  const violations = parseViolations(row);
  const { themes, warnings } = parseThemes(row);
  const running = isRunning(row);

  const countRes = await c.env.DB.prepare(`SELECT COUNT(*) AS n FROM teams WHERE run_id = ?`)
    .bind(id)
    .first<{ n: number }>();
  const teamCount = countRes?.n ?? 0;

  // A meta refresh keeps the progress honest with JavaScript switched off.
  const head = running ? <meta http-equiv="refresh" content="2" /> : undefined;

  return c.html(
    <AdminPage
      title={running ? `${STATUS_WORD[row.status]} — grouping run` : 'Grouping run'}
      active="runs"
      email={email}
      head={head}
      heading={running ? 'Building teams' : row.status === 'failed' ? 'This run failed' : 'Grouping run'}
      lede={`Started ${formatLocalDateTime(row.created_at, cfg.localUtcOffsetHours)} · seed ${row.seed}`}
      actions={
        row.status === 'done' ? (
          <a class="btn" href={`/admin/review/${row.id}`}>
            Review teams
          </a>
        ) : null
      }
    >
      {row.is_published === 1 ? (
        <Callout tone="good" title="These are the published teams">
          This run is what <a href="/teams">/teams</a> shows and what participants have been told.
        </Callout>
      ) : null}

      {running ? (
        <Card title={STATUS_WORD[row.status]} sub="This page refreshes itself every two seconds.">
          <p class="stat-value" id="run-progress" role="status" aria-live="polite">
            {row.progress ?? 'Getting started'}
          </p>
          <p class="muted">
            Clustering and naming call the Anthropic API; the team building itself is local and fast.
            A run of 150 people usually finishes inside a minute. You can safely leave this page — the
            work carries on and the run will be waiting in <a href="/admin/runs">Grouping runs</a>.
          </p>
        </Card>
      ) : null}

      {row.status === 'failed' ? (
        <>
          <Callout tone="bad" title="The run stopped before it produced teams">
            {row.error ?? 'No error was recorded.'}
          </Callout>
          <Card title="What to do now">
            <p>
              Nothing was changed by this — no teams were saved and no earlier run was touched. Start
              another run; if it fails the same way, group by hand from the spreadsheet.
            </p>
            <div class="btn-row">
              <a class="btn" href={`/admin/runs/new?from=${row.id}`}>
                Start another run
              </a>
              <a class="btn btn-secondary" href="/admin/participants/export.csv">
                Export CSV
              </a>
            </div>
            <p class="small muted">
              Export CSV always works, whatever the solver is doing. It contains every answer you have
              collected, so the day can go ahead from a spreadsheet.
            </p>
          </Card>
        </>
      ) : null}

      {row.status === 'done' ? (
        <>
          <div class="grid grid-4">
            <Stat value={teamCount} label={teamCount === 1 ? 'Team' : 'Teams'} big={true} />
            <Stat value={fmt(score?.weighted_total)} label="Weighted score" hint="Only comparable with runs using the same weights" />
            <Stat
              value={violations.length}
              label={violations.length === 1 ? 'Unsolved constraint' : 'Unsolved constraints'}
              hint={violations.length === 0 ? 'Every rule is satisfied' : 'Listed in full below'}
            />
            <Stat value={themes.length} label={themes.length === 1 ? 'Theme' : 'Themes'} hint="Clusters found in the problem statements" />
          </div>

          {violations.length === 0 ? (
            <Callout tone="good" title="Every rule is satisfied">
              Team sizes, laptop coverage, at least one builder per team and no all-beginner team — all
              of them hold. Review the teams and publish when you are happy.
            </Callout>
          ) : (
            <Card
              title={violations.length === 1 ? '1 thing this run could not solve' : `${violations.length} things this run could not solve`}
              sub="These are not errors. They are the honest state of the pool — each one tells you what to do about it."
            >
              <ViolationList violations={violations} />
            </Card>
          )}

          {warnings.length > 0 ? (
            <Callout tone="warn" title="Clustering fell back or was corrected">
              <ul class="team-issues">
                {warnings.map((w) => (
                  <li>{w}</li>
                ))}
              </ul>
            </Callout>
          ) : null}

          <Card title="Score breakdown" sub="Each component is on its own scale, then multiplied by the weight you set.">
            <div class="table-scroll">
              <table>
                <thead>
                  <tr>
                    <th scope="col">Component</th>
                    <th scope="col" class="num">
                      Score
                    </th>
                    <th scope="col" class="num">
                      Weight
                    </th>
                    <th scope="col" class="num">
                      Contribution
                    </th>
                  </tr>
                </thead>
                <tbody>
                  {SCORE_COMPONENTS.map((comp) => {
                    const value = score ? score[comp.key] : undefined;
                    const weight = params.weights[comp.key];
                    return (
                      <tr>
                        <td>
                          <strong>{comp.label}</strong>
                          <div class="small muted">{comp.help}</div>
                        </td>
                        <td class="num">{fmt(value)}</td>
                        <td class="num">{fmt(weight)}</td>
                        <td class="num">{fmt(typeof value === 'number' ? value * weight : undefined)}</td>
                      </tr>
                    );
                  })}
                  <tr>
                    <td>
                      <strong>Weighted total</strong>
                    </td>
                    <td class="num" colspan={2}></td>
                    <td class="num">
                      <strong>{fmt(score?.weighted_total)}</strong>
                    </td>
                  </tr>
                </tbody>
              </table>
            </div>
          </Card>

          {themes.length > 0 ? (
            <Card title="Themes found" sub="Clustered from the problem statements only — no names, emails or ratings were sent.">
              <div class="table-scroll">
                <table>
                  <thead>
                    <tr>
                      <th scope="col">Theme</th>
                      <th scope="col" class="num">
                        People
                      </th>
                      <th scope="col">Summary</th>
                    </tr>
                  </thead>
                  <tbody>
                    {themes.map((t) => (
                      <tr>
                        <td>
                          <strong>{t.label}</strong>
                        </td>
                        <td class="num">{t.participant_ids.length}</td>
                        <td>{t.summary}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </Card>
          ) : null}
        </>
      ) : null}

      <Card title="Settings used" sub="Stored with the run, so an old run always explains itself.">
        <div class="table-scroll">
          <table>
            <tbody>
              <tr>
                <th scope="row">Team size</th>
                <td>
                  target {params.target_team_size}, between {params.min_team_size} and {params.max_team_size}
                </td>
              </tr>
              <tr>
                <th scope="row">Laptops per team</th>
                <td>{params.min_laptops_per_team}</td>
              </tr>
              <tr>
                <th scope="row">Counts as a builder at</th>
                <td>{params.builder_threshold} or higher on Building / Technical</td>
              </tr>
              <tr>
                <th scope="row">Counts as new to AI at</th>
                <td>{params.novice_threshold} or below on all four ratings</td>
              </tr>
              <tr>
                <th scope="row">Actively fixed</th>
                <td>
                  {[
                    params.constraints.enforce_laptops ? 'laptop shortfalls' : null,
                    params.constraints.enforce_builder ? 'teams with no builder' : null,
                    params.constraints.enforce_not_all_novice ? 'all-beginner teams' : null,
                  ]
                    .filter((s): s is string => s !== null)
                    .join(', ') || 'nothing — sizes only'}
                </td>
              </tr>
              <tr>
                <th scope="row">Seed</th>
                <td class="mono">{row.seed}</td>
              </tr>
            </tbody>
          </table>
        </div>
        <div class="btn-row">
          <a class="btn btn-secondary" href={`/admin/runs/new?from=${row.id}`}>
            Start another run with these settings
          </a>
          {row.is_published === 1 ? null : (
            <a class="btn btn-secondary" href={`/admin/runs/${row.id}?confirm=delete`}>
              Delete this run
            </a>
          )}
        </div>
      </Card>

      {confirmDelete && row.is_published !== 1 ? (
        <Callout tone="warn" title="Delete this run permanently?">
          <p>
            The {teamCount} {teamCount === 1 ? 'team' : 'teams'} in this run and any edits you made to
            them will be gone. Participants and their answers are not touched. This cannot be undone.
          </p>
          <form method="post" action={`/admin/runs/${row.id}/delete`}>
            <div class="btn-row">
              <button class="btn btn-danger" type="submit">
                Delete run
              </button>
              <a class="btn btn-secondary" href={`/admin/runs/${row.id}`}>
                Keep it
              </a>
            </div>
          </form>
        </Callout>
      ) : null}

      {row.is_published === 1 ? (
        <Callout tone="info" title="Published runs cannot be deleted">
          Publish a different run first, and this one becomes deletable.
        </Callout>
      ) : null}
    </AdminPage>,
  );
});

/* ------------------------------------------------------------------ delete */

runRoutes.post('/:id/delete', async (c) => {
  if (!originLooksSane(c)) {
    return c.text('That request did not come from this site. Reload the page and try again.', 403);
  }
  const id = c.req.param('id');
  const row = await getRun(c.env.DB, id);
  if (!row) return runNotFound(c.req.url);
  if (row.is_published === 1) {
    return c.text(
      'This run is published, so it cannot be deleted. Publish a different run first, then delete this one.',
      409,
    );
  }
  await deleteRun(c.env.DB, id);
  return c.redirect('/admin/runs?deleted=1', 303);
});

function runNotFound(url: string): Response {
  return new Response(
    'No run with that id. It may have been deleted — see /admin/runs for the list.\n' + url,
    { status: 404, headers: { 'content-type': 'text/plain; charset=utf-8' } },
  );
}
