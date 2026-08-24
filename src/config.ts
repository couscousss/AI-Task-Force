/**
 * Every tunable for the event lives here. Nothing that an organizer might want to
 * change on the morning of the day should be scattered anywhere else.
 *
 * Values marked "overridable" can be set in `wrangler.jsonc` -> `vars` without a code
 * change. Everything else is a code change + redeploy.
 */

import type { Env } from './env';

/** Skill axes. Never collapsed into a single number anywhere in the grouping pipeline. */
export const SKILL_AXES = ['understanding', 'tools', 'prompting', 'building'] as const;
export type SkillAxis = (typeof SKILL_AXES)[number];

export const SKILL_AXIS_LABELS: Record<SkillAxis, { label: string; description: string }> = {
  understanding: {
    label: 'AI Understanding',
    description: 'Understanding AI concepts and possibilities',
  },
  tools: {
    label: 'AI Tools',
    description: 'Ability to use AI applications effectively',
  },
  prompting: {
    label: 'Prompting',
    description: 'Ability to communicate with and direct AI',
  },
  building: {
    label: 'Building / Technical',
    description: 'Ability to turn ideas into prototypes or solutions',
  },
};

export const SKILL_SCALE: { value: 1 | 2 | 3 | 4 | 5; name: string; description: string }[] = [
  { value: 1, name: 'New to AI', description: 'Little or no hands-on use yet' },
  { value: 2, name: 'Beginner', description: 'Basic use of common AI tools' },
  { value: 3, name: 'Comfortable', description: 'Regularly uses AI and can write useful prompts' },
  { value: 4, name: 'Advanced', description: 'Uses AI tools and workflows extensively' },
  {
    value: 5,
    name: 'Builder',
    description: 'Strong practical experience building with AI, automation, APIs or technical workflows',
  },
];

/**
 * [DECIDE] resolved: kept the spec's starter list verbatim, with stable machine keys so
 * that renaming a label later does not orphan data already collected. See DECISIONS.md.
 */
export const CATEGORIES: { value: string; label: string }[] = [
  { value: 'automate', label: 'Automating a manual process' },
  { value: 'search', label: 'Searching or summarizing documents' },
  { value: 'analysis', label: 'Data analysis and reporting' },
  { value: 'product', label: 'A customer or user-facing tool' },
  { value: 'content', label: 'Content and drafting' },
  { value: 'unsure', label: 'Not sure yet' },
];

export const CATEGORY_VALUES = CATEGORIES.map((c) => c.value);

export function categoryLabel(value: string | null | undefined): string {
  if (!value) return 'Not specified';
  return CATEGORIES.find((c) => c.value === value)?.label ?? value;
}

export const ATTENDING = {
  yes: 1,
  no: 0,
  unsure: 2,
} as const;

/** Minimum characters accepted for the problem statement. Enforced on the server. */
export const MIN_PROBLEM_STATEMENT_CHARS = 40;

/** Default solver parameters. Organizers can override per run from the admin UI. */
export interface SolverParams {
  target_team_size: number;
  min_team_size: number;
  max_team_size: number;
  min_laptops_per_team: number;
  /** H3: a "builder" is someone self-rating at least this on the Building axis. */
  builder_threshold: number;
  /** H4: a "novice" rates at most this on every one of the four axes. */
  novice_threshold: number;
  weights: SoftScoreWeights;
  constraints: {
    /** Toggles only affect *repair and local search*. Violations are always reported. */
    enforce_laptops: boolean;
    enforce_builder: boolean;
    enforce_not_all_novice: boolean;
  };
  max_local_search_iterations: number;
  local_search_patience: number;
}

export interface SoftScoreWeights {
  theme_cohesion: number;
  skill_diversity: number;
  across_team_balance: number;
  category_match: number;
  department_mixing: number;
}

export const DEFAULT_SOLVER_PARAMS: SolverParams = {
  target_team_size: 4,
  min_team_size: 3,
  max_team_size: 5,
  min_laptops_per_team: 2,
  builder_threshold: 3,
  novice_threshold: 2,
  weights: {
    theme_cohesion: 3.0,
    skill_diversity: 1.5,
    across_team_balance: 2.0,
    category_match: 1.0,
    department_mixing: 0.5,
  },
  constraints: {
    enforce_laptops: true,
    enforce_builder: true,
    enforce_not_all_novice: true,
  },
  max_local_search_iterations: 5000,
  local_search_patience: 500,
};

/**
 * Event-level configuration. Defaults are placeholders that are safe to run with;
 * override the ones that matter in `wrangler.jsonc` -> `vars` before the invites go out.
 */
export interface EventConfig {
  eventName: string;
  /** ISO date, e.g. '2026-09-18'. Overridable: EVENT_DATE */
  eventDate: string;
  /** ISO datetime with offset. Overridable: FORM_OPENS */
  formOpens: string;
  /** ISO datetime with offset. Overridable: FORM_DEADLINE */
  formDeadline: string;
  /** IANA-ish fixed offset in hours used for "09:00 local" reminder scheduling. */
  localUtcOffsetHours: number;
  /** Local hour (0-23) at which the reminder cron should actually send. */
  reminderLocalHour: number;
  /** Comma-separated in env. Informational only — Cloudflare Access is the real gate. */
  organizerEmails: string[];
  /** Public origin, used to build participant links in emails. Overridable: PUBLIC_ORIGIN */
  publicOrigin: string;
  fromEmail: string;
  maxReminders: number;
  expectedParticipants: number;
  anthropicModel: string;
  aiGatewayUrl: string | null;
  turnstileSiteKey: string | null;
  devAdminEmail: string | null;
}

export const EVENT_DEFAULTS: EventConfig = {
  eventName: 'SECC AI Builder Day',
  eventDate: '2026-09-18',
  formOpens: '2026-08-01T09:00:00+08:00',
  formDeadline: '2026-09-15T17:00:00+08:00',
  localUtcOffsetHours: 8,
  reminderLocalHour: 9,
  organizerEmails: [],
  publicOrigin: 'http://localhost:8787',
  fromEmail: 'AI Builder Day <builderday@example.org>',
  maxReminders: 2,
  expectedParticipants: 80,
  anthropicModel: 'claude-sonnet-5',
  aiGatewayUrl: null,
  turnstileSiteKey: null,
  devAdminEmail: null,
};

function str(v: unknown, fallback: string): string {
  return typeof v === 'string' && v.trim() !== '' ? v.trim() : fallback;
}

function optStr(v: unknown, fallback: string | null): string | null {
  return typeof v === 'string' && v.trim() !== '' ? v.trim() : fallback;
}

function num(v: unknown, fallback: number): number {
  if (typeof v === 'number' && Number.isFinite(v)) return v;
  if (typeof v === 'string' && v.trim() !== '') {
    const n = Number(v);
    if (Number.isFinite(n)) return n;
  }
  return fallback;
}

/** Overlay wrangler `vars` onto the defaults. Called once per request. */
export function loadConfig(env: Env): EventConfig {
  const d = EVENT_DEFAULTS;
  return {
    eventName: str(env.EVENT_NAME, d.eventName),
    eventDate: str(env.EVENT_DATE, d.eventDate),
    formOpens: str(env.FORM_OPENS, d.formOpens),
    formDeadline: str(env.FORM_DEADLINE, d.formDeadline),
    localUtcOffsetHours: num(env.LOCAL_UTC_OFFSET_HOURS, d.localUtcOffsetHours),
    reminderLocalHour: num(env.REMINDER_LOCAL_HOUR, d.reminderLocalHour),
    organizerEmails: str(env.ORGANIZER_EMAILS, '')
      .split(',')
      .map((s) => s.trim().toLowerCase())
      .filter(Boolean),
    publicOrigin: str(env.PUBLIC_ORIGIN, d.publicOrigin).replace(/\/+$/, ''),
    fromEmail: str(env.FROM_EMAIL, d.fromEmail),
    maxReminders: num(env.MAX_REMINDERS, d.maxReminders),
    expectedParticipants: num(env.EXPECTED_PARTICIPANTS, d.expectedParticipants),
    anthropicModel: str(env.ANTHROPIC_MODEL, d.anthropicModel),
    aiGatewayUrl: optStr(env.AI_GATEWAY_URL, d.aiGatewayUrl),
    turnstileSiteKey: optStr(env.TURNSTILE_SITE_KEY, d.turnstileSiteKey),
    devAdminEmail: optStr(env.DEV_ADMIN_EMAIL, d.devAdminEmail),
  };
}
