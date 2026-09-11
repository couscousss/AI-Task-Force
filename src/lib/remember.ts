/**
 * Remembering who someone is between visits, without asking them to log in.
 *
 * The open link is one URL for the whole department, so it cannot know who is opening it.
 * Saving an answer redirects to a personal URL ending in a token — but the link people
 * keep is the one the organizer sent them, and going back to that showed a blank form and
 * asked them to type everything again. Their answers were never lost (email is the
 * identity, so re-submitting updates the same record) but retyping a problem statement to
 * change one checkbox is a good reason to give up half way.
 *
 * So: on a successful save, drop their token in a cookie, and let the open link hand them
 * back their own answers on the next visit.
 *
 * The token in the cookie is the same secret already sitting in their address bar and
 * their browser history. HttpOnly makes it strictly less reachable than the URL is, not
 * more — no script can read it, and it is never rendered into a page.
 */

export const REMEMBER_COOKIE = 'bd_participant';

/** Long enough to cover an event a month or two out, short enough not to linger for ever. */
const MAX_AGE_SECONDS = 120 * 24 * 60 * 60;

/** Tokens are hex; anything else in the cookie is junk and is not worth a database round trip. */
const TOKEN_SHAPE = /^[A-Za-z0-9_-]{8,128}$/;

/**
 * `Secure` would stop the cookie being set at all over plain HTTP, which is what
 * `wrangler dev` serves — so it is set from the actual scheme rather than hardcoded, and
 * production (always HTTPS on workers.dev) still gets it.
 */
function isHttps(requestUrl: string): boolean {
  try {
    return new URL(requestUrl).protocol === 'https:';
  } catch {
    return true;
  }
}

export function rememberCookie(token: string, requestUrl: string): string {
  const parts = [
    `${REMEMBER_COOKIE}=${encodeURIComponent(token)}`,
    'Path=/',
    `Max-Age=${MAX_AGE_SECONDS}`,
    'HttpOnly',
    'SameSite=Lax',
  ];
  if (isHttps(requestUrl)) parts.push('Secure');
  return parts.join('; ');
}

export function forgetCookie(requestUrl: string): string {
  const parts = [`${REMEMBER_COOKIE}=`, 'Path=/', 'Max-Age=0', 'HttpOnly', 'SameSite=Lax'];
  if (isHttps(requestUrl)) parts.push('Secure');
  return parts.join('; ');
}

/**
 * Pull the token out of a Cookie header. Deliberately tolerant of the whitespace and
 * ordering variations different clients produce, and returns null rather than throwing on
 * anything malformed.
 */
export function rememberedToken(cookieHeader: string | null | undefined): string | null {
  if (!cookieHeader) return null;
  for (const pair of cookieHeader.split(';')) {
    const eq = pair.indexOf('=');
    if (eq === -1) continue;
    if (pair.slice(0, eq).trim() !== REMEMBER_COOKIE) continue;
    let value = pair.slice(eq + 1).trim();
    try {
      value = decodeURIComponent(value);
    } catch {
      return null;
    }
    return TOKEN_SHAPE.test(value) ? value : null;
  }
  return null;
}
