import { Hono } from 'hono';
import type { FC } from 'hono/jsx';
import type { AppBindings } from '../../env';
import { AdminPage, Callout, Card, EmptyState, Stat } from '../../ui/layout';
import { dashboardStats, type DashboardStats } from '../../db/participants';
import {
  DEFAULT_SOLVER_PARAMS,
  SKILL_AXES,
  SKILL_AXIS_LABELS,
  SKILL_SCALE,
  categoryLabel,
  loadConfig,
} from '../../config';
import { formatLocalDate } from '../../lib/dates';

export const dashboardRoutes = new Hono<AppBindings>();

function pct(n: number, d: number): number {
  return d > 0 ? Math.round((n / d) * 100) : 0;
}

/** One labelled row with a count and a proportional bar. The count is always text. */
const BarRows: FC<{ rows: { label: string; count: number }[]; caption: string }> = ({ rows, caption }) => {
  const max = Math.max(1, ...rows.map((r) => r.count));
  return (
    <table>
      <caption class="visually-hidden">{caption}</caption>
      <thead>
        <tr>
          <th scope="col">Level</th>
          <th scope="col" class="num">
            People
          </th>
          <th scope="col">
            <span class="visually-hidden">Share</span>
          </th>
        </tr>
      </thead>
      <tbody>
        {rows.map((r) => (
          <tr>
            <td>{r.label}</td>
            <td class="num">{r.count}</td>
            <td style="width:50%">
              <div class="bar" aria-hidden="true">
                <span style={`width:${Math.round((r.count / max) * 100)}%`}></span>
              </div>
            </td>
          </tr>
        ))}
      </tbody>
    </table>
  );
};

const LaptopVerdict: FC<{ stats: DashboardStats }> = ({ stats }) => {
  const p = DEFAULT_SOLVER_PARAMS;
  if (stats.attending === 0) {
    return (
      <Callout tone="info" title="Nobody has confirmed yet">
        Once people start saying yes, this number tells you whether the day can actually run. Every
        team needs {p.min_laptops_per_team} laptops.
      </Callout>
    );
  }
  const teamsNeeded = Math.max(1, Math.round(stats.attending / p.target_team_size));
  const laptopsNeeded = teamsNeeded * p.min_laptops_per_team;
  const shortfall = laptopsNeeded - stats.laptops;
  return (
    <>
      {shortfall > 0 ? (
        <Callout tone="warn" title={`${shortfall} laptops short`}>
          {stats.attending} attendees split into {teamsNeeded} teams of {p.target_team_size} need{' '}
          {laptopsNeeded} laptops. You have {stats.laptops}. Ask {shortfall} more people to bring one,
          or run fewer, larger teams — you can raise the target team size when you start a run.
        </Callout>
      ) : (
        <Callout tone="good" title="Enough laptops">
          {teamsNeeded} teams of {p.target_team_size} need {laptopsNeeded} laptops and you have{' '}
          {stats.laptops}, so {stats.laptops - laptopsNeeded} spare.
        </Callout>
      )}
      {stats.laptopsUnknown > 0 ? (
        <Callout tone="info" title="Still unanswered">
          {stats.laptopsUnknown} {stats.laptopsUnknown === 1 ? 'attendee has' : 'attendees have'} not
          answered the laptop question. Filter for them on the{' '}
          <a href="/admin/participants?laptop=unknown&attending=yes">participants page</a>.
        </Callout>
      ) : null}
    </>
  );
};

dashboardRoutes.get('/', async (c) => {
  const stats = await dashboardStats(c.env.DB);
  const cfg = loadConfig(c.env);
  const email = c.get('adminEmail');
  const p = DEFAULT_SOLVER_PARAMS;

  if (stats.invited === 0) {
    return c.html(
      <AdminPage
        title={`Dashboard — ${cfg.eventName}`}
        active="dashboard"
        email={email}
        heading="Dashboard"
        lede={`${cfg.eventName}, ${formatLocalDate(cfg.eventDate, cfg.localUtcOffsetHours)}.`}
      >
        <Card>
          <EmptyState
            title="Upload your invite list to get started"
            body="Nothing is counted here until people are invited. Upload a CSV of names and emails and every number on this page starts filling in."
            action={
              <a class="btn" href="/admin/invites">
                Upload invite list
              </a>
            }
          />
        </Card>
      </AdminPage>,
    );
  }

  const teamsSupplied = Math.floor(stats.laptops / p.min_laptops_per_team);

  return c.html(
    <AdminPage
      title={`Dashboard — ${cfg.eventName}`}
      active="dashboard"
      email={email}
      heading="Dashboard"
      lede={`${cfg.eventName}, ${formatLocalDate(cfg.eventDate, cfg.localUtcOffsetHours)}. Form closes ${formatLocalDate(cfg.formDeadline, cfg.localUtcOffsetHours)}.`}
      actions={
        <a class="btn btn-secondary" href="/admin/participants/export.csv">
          Export CSV
        </a>
      }
    >
      <Card title="Laptop supply" sub="The constraint that decides whether the day works.">
        <div class="grid grid-2">
          <Stat
            big
            value={stats.laptops}
            label="Laptops promised"
            hint={`${stats.laptops} laptops across ${stats.attending} ${stats.attending === 1 ? 'attendee' : 'attendees'} — enough for ${teamsSupplied} ${teamsSupplied === 1 ? 'team' : 'teams'} of ${p.target_team_size} at ${p.min_laptops_per_team} each.`}
          />
          <div>
            <LaptopVerdict stats={stats} />
          </div>
        </div>
      </Card>

      <div class="grid grid-4">
        <Stat value={stats.invited} label="Invited" />
        <Stat
          value={`${stats.responded} / ${stats.invited}`}
          label="Responses"
          hint={`${pct(stats.responded, stats.invited)}% of the invite list`}
        />
        <Stat
          value={stats.attending}
          label="Attending"
          hint={`${stats.withProblem} have written a problem statement`}
        />
        <Stat
          value={stats.noResponse}
          label="No response yet"
          hint={stats.noResponse > 0 ? 'Send them a reminder from Email' : 'Everyone has answered'}
        />
      </div>

      <div class="grid grid-3">
        <Stat value={stats.declined} label="Declined" />
        <Stat value={stats.unsure} label="Not sure yet" hint="Chase these before you group" />
        <Stat
          value={stats.withProblem}
          label="Ready to group"
          hint="Said yes and described a problem"
        />
      </div>

      <Card
        title="AI capability"
        sub="Self-rated by attendees, across four separate axes. Never added into one score."
      >
        <div class="grid grid-2">
          {SKILL_AXES.map((axis) => {
            const counts = stats.skillHistogram[axis];
            const answered = counts.reduce((a, b) => a + b, 0);
            return (
              <Card
                title={SKILL_AXIS_LABELS[axis].label}
                sub={`${answered} of ${stats.attending} attendees answered · ${SKILL_AXIS_LABELS[axis].description}`}
              >
                <BarRows
                  caption={`${SKILL_AXIS_LABELS[axis].label} ratings`}
                  rows={SKILL_SCALE.map((s) => ({
                    label: `${s.value} · ${s.name}`,
                    count: counts[s.value - 1] ?? 0,
                  }))}
                />
              </Card>
            );
          })}
        </div>
      </Card>

      <div class="grid grid-2">
        <Card title="What people want to build" sub="Attendees who picked a category.">
          {stats.categoryCounts.length === 0 ? (
            <p class="muted">No categories chosen yet.</p>
          ) : (
            <BarRows
              caption="Categories chosen"
              rows={stats.categoryCounts.map((r) => ({
                label: categoryLabel(r.category),
                count: r.count,
              }))}
            />
          )}
        </Card>
        <Card title="Departments" sub="Used to mix teams across the organisation.">
          {stats.departmentCounts.length === 0 ? (
            <p class="muted">No departments given yet.</p>
          ) : (
            <>
              <BarRows
                caption="Departments represented"
                rows={stats.departmentCounts.slice(0, 12).map((r) => ({
                  label: r.department,
                  count: r.count,
                }))}
              />
              {stats.departmentCounts.length > 12 ? (
                <p class="small muted">
                  And {stats.departmentCounts.length - 12} more — the CSV export has every one.
                </p>
              ) : null}
            </>
          )}
        </Card>
      </div>

      <Card title="What happens next">
        <ol>
          <li>
            Chase the {stats.noResponse} people who have not responded, from{' '}
            <a href="/admin/participants?attending=none">Participants</a> or{' '}
            <a href="/admin/email">Email</a>.
          </li>
          <li>
            Take a <a href="/admin/participants/export.csv">CSV backup</a> before the day. It has
            every field you collected, so teams can be built by hand if anything else breaks.
          </li>
          <li>
            When enough people have answered, <a href="/admin/runs">start a grouping run</a>, review
            the teams, and publish.
          </li>
        </ol>
      </Card>
    </AdminPage>,
  );
});
