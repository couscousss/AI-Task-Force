import { Hono } from 'hono';
import type { AppBindings } from '../env';
import { Layout } from '../ui/layout';
import { getPublishedRun, getTeams } from '../db/runs';
import { listByIds } from '../db/participants';
import { loadConfig } from '../config';
import { formatLocalDate } from '../lib/dates';
import { squish } from '../lib/validation';

export const publicTeamRoutes = new Hono<AppBindings>();

/**
 * The projector page. This route is deliberately NOT behind Cloudflare Access, so it
 * shows names and nothing else: no emails, no tokens, no ratings, no unpublished run.
 */
publicTeamRoutes.get('/teams', async (c) => {
  const cfg = loadConfig(c.env);
  const run = await getPublishedRun(c.env.DB);

  if (!run) {
    return c.html(
      <Layout title={`Teams — ${cfg.eventName}`}>
        <main class="narrow" id="main">
          <h1>The teams are not out yet</h1>
          <p class="lede">
            When the organizers publish them, this page shows every team, its project and who is on
            it — ready to project on a screen or print.
          </p>
          <p>
            <a class="btn btn-secondary" href="/admin/runs">
              Organizers: build and publish teams
            </a>
          </p>
        </main>
      </Layout>,
      404,
    );
  }

  const teams = await getTeams(c.env.DB, run.id);
  const ids = teams.flatMap((t) => t.member_ids);
  const rows = await listByIds(c.env.DB, ids);

  // Names only. Anyone whose record has gone missing is simply left out rather than
  // leaking an id or an email onto a public page.
  const nameOf = new Map<string, string>();
  for (const row of rows) {
    const name = squish(row.name);
    if (name) nameOf.set(row.id, name);
  }

  const totalPeople = teams.reduce(
    (acc, t) => acc + t.member_ids.filter((id) => nameOf.has(id)).length,
    0,
  );

  return c.html(
    <Layout title={`Teams — ${cfg.eventName}`} bodyClass="project-view">
      <main class="wrap" id="main">
        <div class="page-head">
          <div>
            <h1>{cfg.eventName} teams</h1>
            <p>
              {teams.length} {teams.length === 1 ? 'team' : 'teams'} · {totalPeople} people ·{' '}
              {formatLocalDate(cfg.eventDate, cfg.localUtcOffsetHours)}
            </p>
          </div>
        </div>

        {teams.length === 0 ? (
          <p>The published run has no teams in it. Ask an organizer to run it again.</p>
        ) : (
          <>
            <p class="small no-print">
              Print this page or project it as it is — press Ctrl+P, or Cmd+P on a Mac.
            </p>
            <div class="project-grid">
              {teams.map((t) => {
                const members = t.member_ids
                  .map((id) => nameOf.get(id))
                  .filter((n): n is string => n !== undefined)
                  .sort((a, b) => a.localeCompare(b));
                return (
                  <section class="project-team">
                    <h2>{t.team.name ?? `Team ${t.team.sort_order + 1}`}</h2>
                    {t.team.theme_label ? <p class="small">{t.team.theme_label}</p> : null}
                    {t.team.project_brief ? <p>{t.team.project_brief}</p> : null}
                    <ol>
                      {members.map((name) => (
                        <li>{name}</li>
                      ))}
                    </ol>
                    {members.length === 0 ? <p>Nobody assigned yet</p> : null}
                  </section>
                );
              })}
            </div>
          </>
        )}
      </main>
    </Layout>,
  );
});
