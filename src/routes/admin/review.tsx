import { Hono } from 'hono';
import type { FC } from 'hono/jsx';
import type { AppBindings } from '../../env';
import type { GroupingRunRow, ParticipantRow } from '../../types';
import type { ArrangementTeam, Evaluation, SolverParticipant, Violation } from '../../grouping/types';
import { AdminPage, Callout, Card, EmptyState, Stat, jsonScript } from '../../ui/layout';
import {
  DEFAULT_SOLVER_PARAMS,
  SKILL_AXES,
  SKILL_AXIS_LABELS,
  loadConfig,
  type SkillAxis,
  type SolverParams,
} from '../../config';
import {
  getRun,
  getTeams,
  parseParams,
  parseThemes,
  publishRun,
  replaceMembership,
  unpublishAll,
  updateTeamMeta,
  type TeamWithMembers,
} from '../../db/runs';
import { listAttendingSubmitted, listByIds, toSolverParticipant } from '../../db/participants';
import { evaluateArrangement } from '../../grouping';
import { originLooksSane } from '../../lib/auth';
import { squish } from '../../lib/validation';

export const reviewRoutes = new Hono<AppBindings>();

/** The column that holds anyone who is not on a team — no-shows get dragged here. */
const UNASSIGNED = '__unassigned';

const AXIS_LETTER: Record<SkillAxis, string> = {
  understanding: 'U',
  tools: 'T',
  prompting: 'P',
  building: 'B',
};

/* ------------------------------------------------------------------ page context */

interface Person {
  id: string;
  label: string;
  department: string | null;
  solver: SolverParticipant;
}

interface BoardContext {
  run: GroupingRunRow;
  params: SolverParams;
  teams: TeamWithMembers[];
  /** Everyone the board shows: on a team already, or attending and not yet placed. */
  people: Map<string, Person>;
  themeOf: Map<string, string>;
  unassigned: string[];
  manual: Set<string>;
}

function personOf(row: ParticipantRow): Person {
  return {
    id: row.id,
    label: squish(row.name) || row.email,
    department: squish(row.department) || null,
    solver: toSolverParticipant(row),
  };
}

async function loadBoard(db: D1Database, run: GroupingRunRow): Promise<BoardContext> {
  const params = parseParams(run, DEFAULT_SOLVER_PARAMS);
  const teams = await getTeams(db, run.id);

  const assigned = new Set<string>();
  const manual = new Set<string>();
  for (const t of teams) {
    for (const id of t.member_ids) assigned.add(id);
    for (const id of t.manual_overrides) manual.add(id);
  }

  const people = new Map<string, Person>();
  // Everyone still eligible, plus anyone already on a team even if they have since
  // declined — they must stay visible so an organizer can drag them out.
  for (const row of await listAttendingSubmitted(db)) people.set(row.id, personOf(row));
  const missing = [...assigned].filter((id) => !people.has(id));
  for (const row of await listByIds(db, missing)) people.set(row.id, personOf(row));

  // Key theme cohesion exactly as the solver did, off the POST-merge buckets it stored.
  // Falling back to raw clustering labels here would score an untouched arrangement
  // differently from the run page whenever a small theme was merged away.
  const parsedThemes = parseThemes(run);
  const themeOf = new Map<string, string>();
  if (Object.keys(parsedThemes.themeOf).length > 0) {
    for (const [id, key] of Object.entries(parsedThemes.themeOf)) themeOf.set(id, key);
  } else {
    for (const theme of parsedThemes.themes) {
      for (const id of theme.participant_ids) themeOf.set(id, theme.label);
    }
  }

  const unassigned = [...people.keys()].filter((id) => !assigned.has(id));
  unassigned.sort((a, b) => (people.get(a)?.label ?? '').localeCompare(people.get(b)?.label ?? ''));

  return { run, params, teams, people, themeOf, unassigned, manual };
}

function arrangementFrom(ctx: BoardContext): ArrangementTeam[] {
  return ctx.teams.map((t) => ({
    index: t.team.sort_order,
    theme_label: t.team.theme_label ?? '',
    member_ids: t.member_ids,
  }));
}

function evaluate(ctx: BoardContext, teams: ArrangementTeam[]): Evaluation {
  return evaluateArrangement(
    [...ctx.people.values()].map((p) => p.solver),
    teams,
    ctx.params,
    ctx.themeOf,
  );
}

/* ------------------------------------------------------------------ view pieces */

function violationBody(v: Violation): string {
  return v.message.replace(/^H[1-4]:\s*/, '');
}

function fmt(n: number): string {
  return Number.isFinite(n) ? n.toFixed(2) : '—';
}

const Chip: FC<{ person: Person; manual: boolean; teamKey: string; runId: string; targets: { key: string; label: string }[] }> = ({
  person,
  manual,
  teamKey,
  runId,
  targets,
}) => {
  const selectId = `move_to_${person.id}`;
  return (
    <li class="chip" draggable="true" data-participant-id={person.id} data-person-name={person.label}>
      <span class="chip-name">
        <span>{person.label}</span>
        <span class="chip-dept">{person.department ?? 'No department given'}</span>
      </span>
      <span class="chip-meta">
        {SKILL_AXES.map((axis) => {
          const level = person.solver.skills[axis];
          return (
            <span
              class="skillpip"
              data-level={String(level)}
              title={`${SKILL_AXIS_LABELS[axis].label}: ${level} of 5`}
            >
              {AXIS_LETTER[axis]}
              {level}
            </span>
          );
        })}
        <span class={`chip-laptop ${person.solver.has_laptop ? 'yes' : 'no'}`}>
          {person.solver.has_laptop ? 'Laptop' : 'No laptop'}
        </span>
        {manual ? <span class="tag tag-maybe">Moved by hand</span> : null}
      </span>
      {/* Works with JavaScript off. review.js hides this row once drag-and-drop is live. */}
      <span class="chip-meta" data-nojs-move="">
        <label class="visually-hidden" for={selectId}>
          Move {person.label} to
        </label>
        <select
          id={selectId}
          name={selectId}
          style="width:auto;min-width:8rem;font-size:0.8rem;padding:0.15rem 0.35rem"
        >
          {targets.map((t) => (
            <option value={t.key} selected={t.key === teamKey}>
              {t.label}
            </option>
          ))}
        </select>
        <button
          class="chip-move"
          type="submit"
          formaction={`/admin/review/${runId}/move`}
          name="move_participant"
          value={person.id}
        >
          Move
        </button>
      </span>
    </li>
  );
};

const TeamStatus: FC<{ issues: string[] }> = ({ issues }) =>
  issues.length === 0 ? (
    <p class="team-ok">Meets every rule</p>
  ) : (
    <ul class="team-issues">
      {issues.map((issue) => (
        <li>{issue}</li>
      ))}
    </ul>
  );

/* ------------------------------------------------------------------ the board */

reviewRoutes.get('/:runId', async (c) => {
  const cfg = loadConfig(c.env);
  const email = c.get('adminEmail');
  const runId = c.req.param('runId');
  const run = await getRun(c.env.DB, runId);
  if (!run) return reviewNotFound();
  if (run.status !== 'done') return c.redirect(`/admin/runs/${runId}`, 303);

  const url = new URL(c.req.url);
  const saved = url.searchParams.get('saved') === '1';
  const published = url.searchParams.get('published') === '1';
  const unpublished = url.searchParams.get('unpublished') === '1';
  const moved = url.searchParams.get('moved');
  const confirmPublish = url.searchParams.get('confirm') === 'publish';

  const ctx = await loadBoard(c.env.DB, run);
  const arrangement = arrangementFrom(ctx);
  const evaluation = evaluate(ctx, arrangement);
  const manualCount = ctx.manual.size;

  const targets: { key: string; label: string }[] = [
    ...ctx.teams.map((t) => ({
      key: t.team.id,
      label: t.team.name ?? `Team ${t.team.sort_order + 1}`,
    })),
    { key: UNASSIGNED, label: 'Unassigned' },
  ];

  const initialArrangement = JSON.stringify({
    teams: ctx.teams.map((t) => ({ team_id: t.team.id, member_ids: t.member_ids })),
    unassigned: ctx.unassigned,
  });

  const actions = (
    <>
      <button class="btn" type="submit" form="board-form">
        Save changes
      </button>
      <a class="btn btn-secondary" href={`/admin/review/${runId}?confirm=publish`}>
        Publish teams
      </a>
      <a class="btn btn-secondary" href={`/admin/runs/new?from=${runId}`}>
        Start another run
      </a>
    </>
  );

  if (ctx.teams.length === 0) {
    return c.html(
      <AdminPage title="Team review" active="runs" email={email} heading="Team review">
        <Card>
          <EmptyState
            title="This run produced no teams"
            body="Nothing was saved for it. Start another run — if it keeps happening, export the CSV and group by hand."
            action={
              <a class="btn" href={`/admin/runs/new?from=${runId}`}>
                Start another run
              </a>
            }
          />
        </Card>
      </AdminPage>,
    );
  }

  return c.html(
    <AdminPage
      title="Team review"
      active="runs"
      email={email}
      heading="Team review"
      lede="Drag a person onto another team and every rule is re-checked as you go. Nothing is stored until you press Save changes."
      actions={actions}
      scripts={['/review.js']}
    >
      {published ? (
        <Callout tone="good" title="Teams published">
          These are now the canonical teams. Anyone can see them at <a href="/teams">/teams</a> — that
          page shows names only and is what you project on the day. The shared /join link now shows
          each person their own team and brief.
        </Callout>
      ) : null}
      {unpublished ? (
        <Callout tone="good" title="Teams taken down">
          Nothing is published now: <a href="/teams">/teams</a> says the teams are not out yet, and the
          shared /join link is the form again. Publish this run, or another, when you are ready.
        </Callout>
      ) : null}
      {saved ? (
        <Callout tone="good" title="Changes saved">
          The teams below are what is stored. People you moved are marked "Moved by hand".
        </Callout>
      ) : null}
      {moved ? (
        <Callout tone="good" title="Person moved">
          {moved} has been moved and the change is saved.
        </Callout>
      ) : null}

      {run.is_published === 1 ? (
        <Callout tone="info" title="This run is published">
          <p>
            Everything you save here goes live on <a href="/teams">/teams</a> and the shared /join link
            immediately — which is what you want when someone does not turn up, and worth knowing before
            you start experimenting.
          </p>
          <form method="post" action={`/admin/review/${runId}/unpublish`}>
            <button class="btn btn-secondary btn-small" type="submit">
              Take the teams down
            </button>
          </form>
        </Callout>
      ) : null}

      {confirmPublish ? (
        <Callout tone="warn" title="Publish these teams?">
          <p>
            Publishing makes this run the canonical one: <a href="/teams">/teams</a> starts showing it,
            and any previously published run is unpublished. You can still fix teams afterwards.
          </p>
          <p>
            {evaluation.violations.length === 0
              ? 'Every rule is currently satisfied.'
              : `${evaluation.violations.length} ${evaluation.violations.length === 1 ? 'rule is' : 'rules are'} still unsatisfied — they are listed below. You can publish anyway; the list is there so you know what to expect on the day.`}
          </p>
          <form method="post" action={`/admin/review/${runId}/publish`}>
            <div class="btn-row">
              <button class="btn" type="submit">
                Publish teams
              </button>
              <a class="btn btn-secondary" href={`/admin/review/${runId}`}>
                Not yet
              </a>
            </div>
          </form>
        </Callout>
      ) : null}

      {manualCount > 0 ? (
        <Callout tone="warn" title={`${manualCount} ${manualCount === 1 ? 'person has' : 'people have'} been moved by hand`}>
          Hand edits belong to this run only. Starting another run builds fresh teams from scratch and
          these moves are not carried over — so make your manual fixes last, after you have settled on a
          run.
        </Callout>
      ) : null}

      <Card
        title="Rules and score"
        sub="Re-checked on the server every time you move someone, so this is the same logic the solver used."
      >
        <p class="small muted" id="validate-status" role="status" aria-live="polite">
          Checked against what is currently saved.
        </p>
        <div class="grid grid-3">
          <div data-live="score">
            <Stat
              value={fmt(evaluation.score.weighted_total)}
              label="Weighted score"
              hint="Higher is better. Only comparable within this run's settings."
              big={true}
            />
          </div>
          <div data-live="placed">
            <Stat
              value={ctx.teams.length}
              label={ctx.teams.length === 1 ? 'Team' : 'Teams'}
              hint={`${ctx.people.size - ctx.unassigned.length} placed, ${ctx.unassigned.length} unassigned`}
            />
          </div>
          <div data-live="violations">
            <Stat
              value={evaluation.violations.length}
              label="Rules not satisfied"
              hint="Every one of them is spelled out below"
            />
          </div>
        </div>
        <div id="board-violations">
          {evaluation.violations.length === 0 ? (
            <p class="team-ok">Team sizes, laptops, builders and skill mix all check out.</p>
          ) : (
            <ul class="team-issues">
              {evaluation.violations.map((v) => (
                <li>
                  <span class="tag tag-no">{v.code}</span> {violationBody(v)}
                </li>
              ))}
            </ul>
          )}
        </div>
        <p class="small muted">
          Score components:{' '}
          {(['theme_cohesion', 'skill_diversity', 'across_team_balance', 'category_match', 'department_mixing'] as const).map(
            (key, i) => (
              <>
                {i > 0 ? ' · ' : ''}
                {
                  {
                    theme_cohesion: 'shared problem',
                    skill_diversity: 'skill mix',
                    across_team_balance: 'balance',
                    category_match: 'project kind',
                    department_mixing: 'departments',
                  }[key]
                }{' '}
                <strong data-score-key={key}>{fmt(evaluation.score[key])}</strong>
              </>
            ),
          )}
        </p>
      </Card>

      <Card title="How to move people">
        <p class="small muted">
          Drag a person's card onto another team. With a keyboard: tab to a person, press Enter or
          Space to pick them up, then tab to the team you want and press Enter to drop them there;
          Escape puts them back. With JavaScript off, use the "Move" control on each card — that saves
          straight away, one person at a time.
        </p>
      </Card>

      <form method="post" action={`/admin/review/${runId}`} id="board-form">
        <input type="hidden" name="arrangement" id="arrangement" value={initialArrangement} />

        <div class="board" id="board">
          {ctx.teams.map((t) => {
            const idx = t.team.sort_order;
            const issues = evaluation.per_team[idx] ?? [];
            return (
              <section
                class={`team ${issues.length > 0 ? 'is-invalid' : ''}`}
                data-team-key={t.team.id}
                data-team-index={String(idx)}
                data-theme-label={t.team.theme_label ?? ''}
                aria-label={t.team.name ?? `Team ${idx + 1}`}
              >
                <div class="team-head">
                  <div>
                    <h3>{t.team.name ?? `Team ${idx + 1}`}</h3>
                    <span class="team-theme">{t.team.theme_label ?? 'No theme'}</span>
                  </div>
                  <span class="team-count" data-team-count="">
                    {t.member_ids.length} {t.member_ids.length === 1 ? 'person' : 'people'}
                  </span>
                </div>

                <div data-team-status="">
                  <TeamStatus issues={issues} />
                </div>

                <ul class="chips" data-chips="">
                  {t.member_ids.map((id) => {
                    const person = ctx.people.get(id);
                    if (!person) return null;
                    return (
                      <Chip
                        person={person}
                        manual={ctx.manual.has(id)}
                        teamKey={t.team.id}
                        runId={runId}
                        targets={targets}
                      />
                    );
                  })}
                </ul>

                <details class="examples">
                  <summary>Name, brief and rationale</summary>
                  <div style="padding:0.75rem">
                    <div class="field" style="margin-bottom:0.9rem">
                      <label for={`name_${t.team.id}`}>Team name</label>
                      <input type="text" id={`name_${t.team.id}`} name={`name_${t.team.id}`} value={t.team.name ?? ''} />
                    </div>
                    <div class="field" style="margin-bottom:0.9rem">
                      <label for={`brief_${t.team.id}`}>Project brief</label>
                      <p class="hint">What this team is going to try to build on the day.</p>
                      <textarea
                        id={`brief_${t.team.id}`}
                        name={`brief_${t.team.id}`}
                        style="min-height:5rem"
                      >
                        {t.team.project_brief ?? ''}
                      </textarea>
                    </div>
                    <div class="field" style="margin-bottom:0">
                      <label for={`rationale_${t.team.id}`}>Why these people</label>
                      <p class="hint">Organizer notes. Not shown on the projected teams page.</p>
                      <textarea
                        id={`rationale_${t.team.id}`}
                        name={`rationale_${t.team.id}`}
                        style="min-height:5rem"
                      >
                        {t.team.rationale ?? ''}
                      </textarea>
                    </div>
                  </div>
                </details>
              </section>
            );
          })}

          <section class="team unassigned" data-team-key={UNASSIGNED} aria-label="Unassigned">
            <div class="team-head">
              <div>
                <h3>Unassigned</h3>
                <span class="team-theme">Not on any team</span>
              </div>
              <span class="team-count" data-team-count="">
                {ctx.unassigned.length} {ctx.unassigned.length === 1 ? 'person' : 'people'}
              </span>
            </div>
            <div data-team-status="">
              <p class="team-ok">Drag no-shows here on the day</p>
            </div>
            <ul class="chips" data-chips="">
              {ctx.unassigned.map((id) => {
                const person = ctx.people.get(id);
                if (!person) return null;
                return (
                  <Chip
                    person={person}
                    manual={false}
                    teamKey={UNASSIGNED}
                    runId={runId}
                    targets={targets}
                  />
                );
              })}
            </ul>
            <p class="small muted">
              Anyone here is counted as unplaced and will not appear on the projected teams page.
            </p>
          </section>
        </div>

        <Card>
          <div class="btn-row">
            <button class="btn" type="submit">
              Save changes
            </button>
            <a class="btn btn-secondary" href={`/admin/review/${runId}`}>
              Discard and reload
            </a>
          </div>
          <p class="small muted">
            Saving rewrites this run's teams. Team names, briefs and rationales you typed above are
            saved at the same time.
          </p>
        </Card>
      </form>

      {jsonScript('review-data', {
        runId,
        validateUrl: `/admin/review/${runId}/validate`,
        unassignedKey: UNASSIGNED,
        eventName: cfg.eventName,
      })}
    </AdminPage>,
  );
});

/* ------------------------------------------------------------------ live validate */

function readArrangementTeams(payload: unknown): ArrangementTeam[] {
  if (typeof payload !== 'object' || payload === null) return [];
  const raw = (payload as { teams?: unknown }).teams;
  if (!Array.isArray(raw)) return [];
  const out: ArrangementTeam[] = [];
  const list = raw as unknown[];
  for (let i = 0; i < list.length; i++) {
    const entry = list[i];
    if (typeof entry !== 'object' || entry === null) continue;
    const rec = entry as Record<string, unknown>;
    const declared = rec['index'];
    const ids = Array.isArray(rec['member_ids']) ? (rec['member_ids'] as unknown[]) : [];
    out.push({
      index: typeof declared === 'number' && Number.isInteger(declared) ? declared : i,
      theme_label: typeof rec['theme_label'] === 'string' ? rec['theme_label'] : '',
      member_ids: ids.filter((v): v is string => typeof v === 'string'),
    });
  }
  return out;
}

/**
 * One source of truth for the constraint logic: the board never re-implements a rule,
 * it asks the server the same question the solver asked.
 */
reviewRoutes.post('/:runId/validate', async (c) => {
  const run = await getRun(c.env.DB, c.req.param('runId'));
  if (!run) return c.json({ error: 'No run with that id. Reload the page.' }, 404);

  let payload: unknown;
  try {
    payload = await c.req.json();
  } catch {
    return c.json({ error: 'The board sent something that was not JSON. Reload the page.' }, 400);
  }

  const ctx = await loadBoard(c.env.DB, run);
  const teams = readArrangementTeams(payload);
  return c.json(evaluate(ctx, teams.length > 0 ? teams : arrangementFrom(ctx)));
});

/* ------------------------------------------------------------------ saving */

function str(body: Record<string, unknown>, key: string): string {
  const v = body[key];
  return typeof v === 'string' ? v.trim() : '';
}

async function saveTeamMeta(
  db: D1Database,
  teams: TeamWithMembers[],
  body: Record<string, unknown>,
): Promise<void> {
  for (const t of teams) {
    const patch: { name?: string; project_brief?: string; rationale?: string } = {};
    if (`name_${t.team.id}` in body) patch.name = str(body, `name_${t.team.id}`);
    if (`brief_${t.team.id}` in body) patch.project_brief = str(body, `brief_${t.team.id}`);
    if (`rationale_${t.team.id}` in body) patch.rationale = str(body, `rationale_${t.team.id}`);
    if (Object.keys(patch).length > 0) await updateTeamMeta(db, t.team.id, patch);
  }
}

/** Turn a submitted arrangement into `{ teamId: [participantId] }`, dropping anything unknown. */
function assignmentFromJson(
  raw: string,
  ctx: BoardContext,
): Record<string, string[]> | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }
  if (typeof parsed !== 'object' || parsed === null) return null;
  const teams = (parsed as { teams?: unknown }).teams;
  // An empty list would silently empty every team, so treat it as a broken payload.
  if (!Array.isArray(teams) || teams.length === 0) return null;

  const validTeams = new Set(ctx.teams.map((t) => t.team.id));
  const placed = new Set<string>();
  const assignment: Record<string, string[]> = {};
  for (const t of ctx.teams) assignment[t.team.id] = [];

  for (const entry of teams as unknown[]) {
    if (typeof entry !== 'object' || entry === null) continue;
    const rec = entry as Record<string, unknown>;
    const teamId = typeof rec['team_id'] === 'string' ? rec['team_id'] : '';
    if (!validTeams.has(teamId)) continue;
    const ids = Array.isArray(rec['member_ids']) ? (rec['member_ids'] as unknown[]) : [];
    const bucket = assignment[teamId];
    if (!bucket) continue;
    for (const id of ids) {
      if (typeof id !== 'string') continue;
      if (!ctx.people.has(id)) continue;
      if (placed.has(id)) continue; // one person, one team — silently de-duplicated
      placed.add(id);
      bucket.push(id);
    }
  }
  return assignment;
}

reviewRoutes.post('/:runId', async (c) => {
  if (!originLooksSane(c)) {
    return c.text('That request did not come from this site. Reload the page and try again.', 403);
  }
  const runId = c.req.param('runId');
  const run = await getRun(c.env.DB, runId);
  if (!run) return reviewNotFound();

  const body = (await c.req.parseBody()) as Record<string, unknown>;
  const ctx = await loadBoard(c.env.DB, run);

  await saveTeamMeta(c.env.DB, ctx.teams, body);

  const assignment = assignmentFromJson(str(body, 'arrangement'), ctx);
  if (!assignment) {
    return c.text(
      'The board could not be read, so nobody was moved. Reload /admin/review/' +
        runId +
        ' and make the moves again — team names and briefs you typed have been saved.',
      422,
    );
  }
  await replaceMembership(c.env.DB, runId, assignment);
  return c.redirect(`/admin/review/${runId}?saved=1`, 303);
});

/** The no-JavaScript path: one person, one move, saved immediately. */
reviewRoutes.post('/:runId/move', async (c) => {
  if (!originLooksSane(c)) {
    return c.text('That request did not come from this site. Reload the page and try again.', 403);
  }
  const runId = c.req.param('runId');
  const run = await getRun(c.env.DB, runId);
  if (!run) return reviewNotFound();

  const body = (await c.req.parseBody()) as Record<string, unknown>;
  const ctx = await loadBoard(c.env.DB, run);

  await saveTeamMeta(c.env.DB, ctx.teams, body);

  const personId = str(body, 'move_participant');
  const person = ctx.people.get(personId);
  const target = str(body, `move_to_${personId}`);
  if (!person) {
    return c.text('That person is no longer on this run. Reload the page and try again.', 422);
  }
  const known = target === UNASSIGNED || ctx.teams.some((t) => t.team.id === target);
  if (!known) {
    return c.text('That team is not part of this run. Reload the page and try again.', 422);
  }

  const assignment: Record<string, string[]> = {};
  for (const t of ctx.teams) {
    assignment[t.team.id] = t.member_ids.filter((id) => id !== personId);
  }
  if (target !== UNASSIGNED) {
    const bucket = assignment[target];
    if (bucket) bucket.push(personId);
  }
  await replaceMembership(c.env.DB, runId, assignment);
  return c.redirect(`/admin/review/${runId}?moved=${encodeURIComponent(person.label)}`, 303);
});

/* ------------------------------------------------------------------ publish */

reviewRoutes.post('/:runId/publish', async (c) => {
  if (!originLooksSane(c)) {
    return c.text('That request did not come from this site. Reload the page and try again.', 403);
  }
  const runId = c.req.param('runId');
  const run = await getRun(c.env.DB, runId);
  if (!run) return reviewNotFound();
  if (run.status !== 'done') {
    return c.text('This run has not finished, so there is nothing to publish yet.', 409);
  }
  await publishRun(c.env.DB, runId);
  return c.redirect(`/admin/review/${runId}?published=1`, 303);
});

/**
 * Reversible, so no confirmation step: publishing again puts the teams straight back.
 * Clears whichever run is published rather than only this one, so a stale board cannot
 * leave a different run showing.
 */
reviewRoutes.post('/:runId/unpublish', async (c) => {
  if (!originLooksSane(c)) {
    return c.text('That request did not come from this site. Reload the page and try again.', 403);
  }
  const runId = c.req.param('runId');
  const run = await getRun(c.env.DB, runId);
  if (!run) return reviewNotFound();
  await unpublishAll(c.env.DB);
  return c.redirect(`/admin/review/${runId}?unpublished=1`, 303);
});

function reviewNotFound(): Response {
  return new Response(
    'No run with that id. It may have been deleted — see /admin/runs for the list of runs.\n',
    { status: 404, headers: { 'content-type': 'text/plain; charset=utf-8' } },
  );
}
