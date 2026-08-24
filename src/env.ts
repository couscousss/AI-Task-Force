export interface Env {
  DB: D1Database;
  ASSETS: Fetcher;

  // Secrets (wrangler secret put)
  ANTHROPIC_API_KEY?: string;
  RESEND_API_KEY?: string;
  TURNSTILE_SECRET_KEY?: string;

  // Non-secret vars (wrangler.jsonc -> vars)
  EVENT_NAME?: string;
  EVENT_DATE?: string;
  FORM_OPENS?: string;
  FORM_DEADLINE?: string;
  LOCAL_UTC_OFFSET_HOURS?: string;
  REMINDER_LOCAL_HOUR?: string;
  ORGANIZER_EMAILS?: string;
  PUBLIC_ORIGIN?: string;
  FROM_EMAIL?: string;
  MAX_REMINDERS?: string;
  EXPECTED_PARTICIPANTS?: string;
  ANTHROPIC_MODEL?: string;
  AI_GATEWAY_URL?: string;
  TURNSTILE_SITE_KEY?: string;
  DEV_ADMIN_EMAIL?: string;
}

/** Hono generics used by every router in this app. */
export type AppBindings = {
  Bindings: Env;
  Variables: {
    /** Set by the admin auth middleware. */
    adminEmail: string;
  };
};
