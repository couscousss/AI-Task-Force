import { CATEGORY_VALUES, MIN_PROBLEM_STATEMENT_CHARS } from '../config';

/**
 * Deliberately permissive but structural: one @, a dot in the domain, no spaces.
 * We are checking for typos, not policing RFC 5322.
 */
const EMAIL_RE = /^[^\s@,;]+@[^\s@,;]+\.[^\s@,;]{2,}$/;

export function normalizeEmail(raw: string): string {
  return raw.trim().toLowerCase();
}

export function isValidEmail(raw: string): boolean {
  const e = normalizeEmail(raw);
  return e.length <= 254 && EMAIL_RE.test(e);
}

/** Collapse runs of whitespace so " a   b " and "a b" compare equal. */
export function squish(raw: string | null | undefined): string {
  return (raw ?? '').replace(/\s+/g, ' ').trim();
}

export function countWords(raw: string): number {
  const s = squish(raw);
  return s === '' ? 0 : s.split(' ').length;
}

export interface FieldErrors {
  [field: string]: string;
}

export interface ProblemStatementCheck {
  ok: boolean;
  message?: string;
}

/**
 * The single most valuable field in the app, so the rule is enforced here and used by
 * both the server handler and (via the same messages) the client-side hint.
 */
export function checkProblemStatement(raw: string | null | undefined): ProblemStatementCheck {
  const s = squish(raw);
  if (s === '') {
    return {
      ok: false,
      message: 'Tell us the work challenge you would like to explore — this is what we build the teams around.',
    };
  }
  if (countWords(s) < 5) {
    return {
      ok: false,
      message: 'A few more words would help. Describe the task or process, and what makes it awkward today.',
    };
  }
  if (s.length < MIN_PROBLEM_STATEMENT_CHARS) {
    return {
      ok: false,
      message: `A little more detail, please — about ${MIN_PROBLEM_STATEMENT_CHARS} characters. You have ${s.length}. What is the task, and what makes it slow or frustrating?`,
    };
  }
  if (s.length > 4000) {
    return { ok: false, message: 'That is longer than we can store. Please trim it to about 4000 characters.' };
  }
  return { ok: true };
}

export function isValidSkill(v: unknown): v is number {
  const n = Number(v);
  return Number.isInteger(n) && n >= 1 && n <= 5;
}

export function isValidCategory(v: unknown): v is string {
  return typeof v === 'string' && CATEGORY_VALUES.includes(v);
}
