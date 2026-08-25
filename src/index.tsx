import { Hono } from 'hono';
import type { AppBindings } from './env';
import type { Env } from './env';
import { participantRoutes } from './routes/participant';
import { publicTeamRoutes } from './routes/public-teams';
import { runReminderSweep } from './email/cron';
import { Layout } from './ui/layout';

/**
 * The PUBLIC Worker: the check-in form and the projected team list, and nothing else.
 *
 * The organizer screens live in a separate Worker (src/admin.tsx) so that Cloudflare
 * Access can be switched on for the whole of that one. Access attaches to a Worker or to
 * a domain you own, and a workers.dev URL is neither yours nor path-scopable — so the only
 * way to have company login on /admin without also putting the participant form behind a
 * login is to make them two Workers. They share one D1 database.
 */
const app = new Hono<AppBindings>();

app.route('/', participantRoutes);
app.route('/', publicTeamRoutes);

app.get('/healthz', (c) => c.json({ ok: true }));

// The bare domain is the link an organizer shares with the whole department, so it goes
// straight to the form rather than to a landing page nobody needs.
app.get('/', (c) => c.redirect('/join', 302));

app.notFound((c) => {
  return c.html(
    <Layout title="Page not found">
      <main class="narrow">
        <h1>That page does not exist</h1>
        <p>
          If you followed a personal link from an email, check that it was not cut in half by your
          mail client. Copy the whole link, including the long code at the end.
        </p>
        <p>
          <a href="/">Back to the start</a>
        </p>
      </main>
    </Layout>,
    404,
  );
});

app.onError((err, c) => {
  console.error('unhandled error', err);
  return c.html(
    <Layout title="Something went wrong">
      <main class="narrow">
        <h1>Something went wrong</h1>
        <p>
          The page could not be loaded. Try again; if it keeps happening, tell an organizer what you
          were doing and roughly when.
        </p>
        <p class="small muted mono">{String(err?.message ?? err)}</p>
      </main>
    </Layout>,
    500,
  );
});

export default {
  fetch: app.fetch,

  /**
   * Hourly cron. The handler decides whether it is actually 09:00 on a weekday in the
   * event's local timezone, which keeps the timezone a config value instead of a
   * wrangler.jsonc edit, and makes a double-fire harmless.
   */
  async scheduled(_event: ScheduledController, env: Env, ctx: ExecutionContext): Promise<void> {
    ctx.waitUntil(runReminderSweep(env, new Date()));
  },
} satisfies ExportedHandler<Env>;
