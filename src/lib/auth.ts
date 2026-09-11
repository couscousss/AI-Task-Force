import type { Context, Next } from 'hono';
import type { AppBindings } from '../env';
import { loadConfig } from '../config';

/**
 * Cloudflare Access is the authentication. There is deliberately no login page, no
 * session, and no password reset in this codebase.
 *
 * In production the Access policy on /admin/* guarantees the header is present and
 * signed. In `wrangler dev` there is no Access in front, so DEV_ADMIN_EMAIL stands in —
 * but ONLY on a local hostname.
 *
 * That last clause is load-bearing. DEV_ADMIN_EMAIL is an ordinary var, so it ships with
 * a deploy; without the hostname check, a deployed Worker with the var set would admit
 * anyone who found the URL, before an Access policy is in place. Every participant's
 * email and problem statement sits behind this middleware, so the failure has to be shut
 * rather than open.
 */
function isLocalDev(requestUrl: string): boolean {
  try {
    const { hostname } = new URL(requestUrl);
    return hostname === 'localhost' || hostname === '127.0.0.1' || hostname === '[::1]';
  } catch {
    return false;
  }
}

export async function requireAdmin(c: Context<AppBindings>, next: Next) {
  const header = c.req.header('Cf-Access-Authenticated-User-Email');
  const cfg = loadConfig(c.env);
  const fallback = isLocalDev(c.req.url) ? (cfg.devAdminEmail?.toLowerCase() ?? null) : null;
  const email = header?.trim().toLowerCase() || fallback;

  if (!email) {
    return c.text(
      'This page is not protected yet, so it is refusing to open.\n\n' +
        'Turn Cloudflare Access on for this Worker before using it. You do not have to\n' +
        'do it by hand:\n\n' +
        '  GitHub -> Actions -> "Protect the admin dashboard" -> Run workflow\n\n' +
        'The first run needs two extra permissions on the Cloudflare API token you\n' +
        'already have; the workflow file lists them. Editing a token does not change its\n' +
        'secret, so nothing needs re-pasting.\n\n' +
        'Leave the participant form and /teams outside Access — they are on the other\n' +
        'Worker, and participants have no accounts.\n\n' +
        'Running locally? DEV_ADMIN_EMAIL stands in for the Access header, but only on\n' +
        'localhost, so that it can never do so on a deployed Worker.\n',
      403,
    );
  }

  c.set('adminEmail', email);
  await next();
  return;
}

/** Cheap same-origin check for state-changing admin requests. */
export function originLooksSane(c: Context<AppBindings>): boolean {
  const origin = c.req.header('Origin');
  if (!origin) return true; // form posts without Origin (older browsers) still work
  try {
    return new URL(origin).host === new URL(c.req.url).host;
  } catch {
    return false;
  }
}
