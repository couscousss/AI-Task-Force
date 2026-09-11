/**
 * The one place that knows we use Resend. Workers have no TCP sockets, so this is a
 * plain `fetch` against their REST API rather than an SMTP library.
 *
 * Callers only ever see `OutboundEmail` and `SendResult` — swapping in Cloudflare Email
 * Sending later is a rewrite of this file and nothing else.
 */

import type { Env } from '../env';
import { loadConfig } from '../config';
import { isValidEmail, normalizeEmail } from '../lib/validation';

export interface OutboundEmail {
  to: string;
  subject: string;
  text: string;
  html: string;
}
export interface SendResult {
  ok: boolean;
  providerId: string | null;
  error?: string;
}

const RESEND_ENDPOINT = 'https://api.resend.com/emails';
const REQUEST_TIMEOUT_MS = 15_000;

/** Never throws. A caller that gets `ok: false` must not record a successful send. */
export async function sendEmail(env: Env, msg: OutboundEmail): Promise<SendResult> {
  const apiKey = env.RESEND_API_KEY?.trim();
  if (!apiKey) {
    return {
      ok: false,
      providerId: null,
      error:
        'Email is not configured, so nothing was sent. Set the API key with `wrangler secret put RESEND_API_KEY` and try again.',
    };
  }

  const to = normalizeEmail(msg.to);
  if (!isValidEmail(to)) {
    return { ok: false, providerId: null, error: `"${msg.to}" is not a usable email address. Fix it on the participant, then send again.` };
  }

  const cfg = loadConfig(env);
  let res: Response;
  try {
    res = await fetch(RESEND_ENDPOINT, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${apiKey}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        from: cfg.fromEmail,
        to: [to],
        subject: msg.subject,
        text: msg.text,
        html: msg.html,
      }),
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
  } catch (err) {
    return {
      ok: false,
      providerId: null,
      error: truncate(`Could not reach the email provider: ${errText(err)}`),
    };
  }

  const body = await res.text().catch(() => '');
  if (!res.ok) {
    return {
      ok: false,
      providerId: null,
      error: truncate(`Email provider returned ${res.status}. ${providerMessage(body)}`),
    };
  }

  return { ok: true, providerId: providerId(body) };
}

function providerId(body: string): string | null {
  try {
    const parsed: unknown = JSON.parse(body);
    if (parsed && typeof parsed === 'object' && 'id' in parsed) {
      const id = (parsed as { id: unknown }).id;
      if (typeof id === 'string' && id !== '') return id;
    }
  } catch {
    // A 2xx with an unparseable body still means it was accepted; we just lose the id.
  }
  return null;
}

/** Pull the provider's own sentence out of the error body so the log says something useful. */
function providerMessage(body: string): string {
  try {
    const parsed: unknown = JSON.parse(body);
    if (parsed && typeof parsed === 'object') {
      const rec = parsed as Record<string, unknown>;
      for (const key of ['message', 'error', 'name']) {
        const v = rec[key];
        if (typeof v === 'string' && v.trim() !== '') return v.trim();
      }
    }
  } catch {
    // fall through to the raw body
  }
  return body.trim() === '' ? 'No detail was returned.' : body.trim();
}

function errText(err: unknown): string {
  if (err instanceof Error) return err.name === 'TimeoutError' ? 'the request timed out' : err.message;
  return String(err);
}

function truncate(s: string, max = 240): string {
  return s.length <= max ? s : `${s.slice(0, max - 1)}…`;
}
