import type { Context, Next } from 'hono';
import type { AppBindings } from '../env';
import { loadConfig } from '../config';

/**
 * Cloudflare Access is the authentication. There is deliberately no login page, no
 * session, and no password reset in this codebase.
 *
 * In production the Access policy on /admin/* guarantees the header is present and
 * signed. In `wrangler dev` there is no Access in front, so DEV_ADMIN_EMAIL stands in.
 */
export async function requireAdmin(c: Context<AppBindings>, next: Next) {
  const header = c.req.header('Cf-Access-Authenticated-User-Email');
  const cfg = loadConfig(c.env);
  const email = header?.trim().toLowerCase() || cfg.devAdminEmail?.toLowerCase() || null;

  if (!email) {
    return c.text(
      'Admin access is protected by Cloudflare Access.\n\n' +
        'If you are seeing this in production, the Access application is not covering /admin/*.\n' +
        'If you are running `wrangler dev`, set DEV_ADMIN_EMAIL in wrangler.jsonc vars.\n',
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
