import type { Env } from '../env';

const VERIFY_URL = 'https://challenges.cloudflare.com/turnstile/v0/siteverify';

/**
 * Verify a Turnstile token. If no secret is configured the check is skipped, so the
 * app remains usable in local dev and does not become unrunnable on the morning of the
 * event because a key expired.
 */
export async function verifyTurnstile(env: Env, token: string | null, ip: string | null): Promise<boolean> {
  const secret = env.TURNSTILE_SECRET_KEY;
  if (!secret) return true;
  if (!token) return false;

  const body = new FormData();
  body.append('secret', secret);
  body.append('response', token);
  if (ip) body.append('remoteip', ip);

  try {
    const res = await fetch(VERIFY_URL, { method: 'POST', body });
    if (!res.ok) return false;
    const json = (await res.json()) as { success?: boolean };
    return json.success === true;
  } catch {
    return false;
  }
}
