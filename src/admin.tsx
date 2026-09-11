import { Hono } from 'hono';
import type { AppBindings, Env } from './env';
import { adminRoutes } from './routes/admin';
import { Layout } from './ui/layout';

/**
 * The ADMIN Worker: every organizer screen, and nothing a participant ever sees.
 *
 * Deployed separately from the public Worker precisely so that Cloudflare Access can be
 * turned on for the whole of it. Access protects a Worker or a domain you own; a
 * workers.dev URL cannot be path-scoped, so protecting /admin without also locking the
 * participant form means two Workers. Both bind the same D1 database, so there is one
 * copy of the data.
 *
 * `requireAdmin` still reads the Cf-Access-Authenticated-User-Email header that Access
 * injects, so this Worker refuses to serve anything until Access is actually in front of
 * it — a deployment nobody has protected yet fails shut.
 */
const app = new Hono<AppBindings>();

app.route('/admin', adminRoutes);

app.get('/healthz', (c) => c.json({ ok: true }));

// This Worker exists to serve /admin, so the bare hostname goes there.
app.get('/', (c) => c.redirect('/admin', 302));

app.notFound((c) =>
  c.html(
    <Layout title="Page not found">
      <main class="narrow">
        <h1>That page does not exist</h1>
        <p>
          This is the organizer side. The participant form and the published team list live on the
          other address — the dashboard shows both links.
        </p>
        <p>
          <a href="/admin">Back to the dashboard</a>
        </p>
      </main>
    </Layout>,
    404,
  ),
);

app.onError((err, c) => {
  console.error('unhandled error', err);
  return c.html(
    <Layout title="Something went wrong">
      <main class="narrow">
        <h1>Something went wrong</h1>
        <p>The page could not be loaded. Try again, and if it keeps happening the message below is
        the useful part.</p>
        <p class="small muted mono">{String(err?.message ?? err)}</p>
      </main>
    </Layout>,
    500,
  );
});

export default {
  fetch: app.fetch,
} satisfies ExportedHandler<Env>;
