/**
 * Synthetic participant generator.
 *
 * Emits `INSERT` statements for the `participants` table so the whole pipeline —
 * dashboard, CSV export, clustering, solver, team review — can be exercised before a
 * single real response arrives, and so organizers can see a working demo while the
 * invite list is still being assembled.
 *
 *   npx tsx scripts/seed-fake.ts --help
 *
 * Runs under Node (tsx), checked by tsconfig.scripts.json. Deliberately self-contained:
 * importing from src/ would drag Worker types into a Node script.
 */

import { writeFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';

// --- shape ------------------------------------------------------------------

/** Structurally identical to `ParticipantRow` in src/types.ts, duplicated to stay src-free. */
export interface FakeParticipant {
  id: string;
  token: string;
  email: string;
  name: string | null;
  department: string | null;
  /** NULL = no response yet, 0 = declined, 1 = attending, 2 = not sure yet. */
  attending: number | null;
  problem_statement: string | null;
  category: string | null;
  skill_understanding: number | null;
  skill_tools: number | null;
  skill_prompting: number | null;
  skill_building: number | null;
  has_personal_laptop: number | null;
  hopes: string | null;
  submitted_at: string | null;
  updated_at: string | null;
}

export interface GenerateOptions {
  count: number;
  seed?: number;
  /** Share of the invite list that answers at all. Default 0.82. */
  responseRate?: number;
  /** Share of responders who decline. Default 0.09. */
  declineRate?: number;
  /** Share of responders who pick "not sure yet". Default 0.08. */
  unsureRate?: number;
  /** Baseline chance of a personal laptop. Default 0.68 (≈70% once builders are added). */
  laptopRate?: number;
  /** Email domain for the generated addresses. */
  emailDomain?: string;
}

// --- PRNG -------------------------------------------------------------------

/**
 * mulberry32, written out rather than pulled in as a dependency — the same generator
 * src/grouping/prng.ts uses, so "same seed, same people" survives a lockfile change.
 */
interface Rng {
  next(): number;
  int(maxExclusive: number): number;
}

function createRng(seed: number): Rng {
  let state = (Number.isFinite(seed) ? Math.trunc(seed) : 0) >>> 0;
  const next = (): number => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
  const int = (maxExclusive: number): number => {
    if (!Number.isFinite(maxExclusive) || maxExclusive <= 0) return 0;
    return Math.floor(next() * maxExclusive) % Math.floor(maxExclusive);
  };
  return { next, int };
}

function pick<T>(rng: Rng, items: readonly T[]): T {
  const v = items[rng.int(items.length)];
  if (v === undefined) throw new Error('seed-fake: cannot pick from an empty list');
  return v;
}

function pickWeighted<T>(rng: Rng, items: readonly { value: T; weight: number }[]): T {
  const total = items.reduce((a, b) => a + b.weight, 0);
  let r = rng.next() * total;
  for (const item of items) {
    r -= item.weight;
    if (r < 0) return item.value;
  }
  const last = items[items.length - 1];
  if (last === undefined) throw new Error('seed-fake: cannot pick from an empty list');
  return last.value;
}

const HEX = '0123456789abcdef';

function hex(rng: Rng, length: number): string {
  let out = '';
  for (let i = 0; i < length; i++) out += HEX[rng.int(16)];
  return out;
}

/** A v4-shaped uuid from the seeded stream, so ids are stable across runs. */
function uuid(rng: Rng): string {
  return `${hex(rng, 8)}-${hex(rng, 4)}-4${hex(rng, 3)}-${pick(rng, ['8', '9', 'a', 'b'])}${hex(rng, 3)}-${hex(rng, 12)}`;
}

// --- people -----------------------------------------------------------------

const FIRST_NAMES = [
  'Aisha', 'Alex', 'Amara', 'Andrew', 'Anita', 'Ben', 'Bryan', 'Carmen', 'Chloe', 'Daniel',
  'Deepa', 'Eleanor', 'Elias', 'Emma', 'Farah', 'Fiona', 'Gabriel', 'Grace', 'Hannah', 'Hassan',
  'Ines', 'Isaac', 'Jasmine', 'Joel', 'Karan', 'Katie', 'Lena', 'Liam', 'Lucas', 'Maya',
  'Mei', 'Nadia', 'Nathan', 'Nora', 'Omar', 'Priya', 'Rachel', 'Rafael', 'Ravi', 'Rosa',
  'Samuel', 'Sara', 'Simon', 'Sofia', 'Tara', 'Thomas', 'Tobias', 'Wei', 'Yasmin', 'Zoe',
];

const LAST_NAMES = [
  'Abbas', 'Adeyemi', 'Ahmed', 'Alvarez', 'Baptiste', 'Bennett', 'Bergman', 'Chan', 'Clarke', 'Costa',
  'Dawson', 'Dias', 'Duarte', 'Ellis', 'Farrell', 'Fischer', 'Gallagher', 'Gomez', 'Hale', 'Haruna',
  'Iqbal', 'Jensen', 'Kaur', 'Keane', 'Kowalski', 'Lam', 'Lindqvist', 'Mahmood', 'Marsh', 'Mbeki',
  'Mendes', 'Moreau', "O'Brien", 'Nakamura', 'Nowak', 'Okafor', 'Osei', 'Patel', 'Quinn', 'Rahman', 'Reyes',
  'Santos', 'Sharma', 'Silva', 'Sullivan', 'Tan', 'Thompson', 'Vasquez', 'Walsh', 'Whitfield', 'Yusuf',
];

/** Weighted so the big operational departments dominate, the way a real invite list does. */
const DEPARTMENTS: { value: string; weight: number }[] = [
  { value: 'Customer Services', weight: 14 },
  { value: 'Operations', weight: 13 },
  { value: 'Finance', weight: 10 },
  { value: 'Digital & IT', weight: 9 },
  { value: 'People & Culture', weight: 8 },
  { value: 'Housing', weight: 8 },
  { value: 'Community Services', weight: 7 },
  { value: 'Communications', weight: 6 },
  { value: 'Legal & Governance', weight: 5 },
  { value: 'Procurement', weight: 5 },
  { value: 'Planning & Development', weight: 5 },
  { value: 'Data & Insight', weight: 4 },
];

// --- skills -----------------------------------------------------------------

/**
 * Four correlated-but-distinct axes. Everyone gets one latent ability, skewed low, then
 * an archetype tilts the individual axes. The point of the archetypes is that people who
 * are strong at prompting and weak at building genuinely occur in the pool — that mix is
 * the entire reason the four axes are stored separately.
 */
const ARCHETYPES: {
  value: { key: string; offsets: [number, number, number, number] };
  weight: number;
}[] = [
  // understanding, tools, prompting, building
  { value: { key: 'newcomer', offsets: [-0.04, -0.06, -0.10, -0.18] }, weight: 24 },
  { value: { key: 'reader', offsets: [0.24, 0.0, 0.02, -0.26] }, weight: 20 },
  { value: { key: 'power-user', offsets: [0.06, 0.28, 0.32, -0.24] }, weight: 24 },
  { value: { key: 'tinkerer', offsets: [0.1, 0.08, -0.02, 0.34] }, weight: 12 },
  { value: { key: 'builder', offsets: [0.14, 0.12, 0.06, 0.5] }, weight: 8 },
  { value: { key: 'even', offsets: [0.0, 0.0, 0.0, 0.0] }, weight: 12 },
];

/** Latent [0,1] → 1..5. Tuned so most people land on 1–3 and 5s stay rare. */
function toScore(latent: number): number {
  if (latent < 0.17) return 1;
  if (latent < 0.42) return 2;
  if (latent < 0.7) return 3;
  if (latent < 0.91) return 4;
  return 5;
}

function skillsFor(rng: Rng): [number, number, number, number] {
  // Pow > 1 pushes the mass toward the low end: self-assessments come back modest.
  const base = Math.pow(rng.next(), 1.9);
  const archetype = pickWeighted(rng, ARCHETYPES);
  const out: number[] = [];
  for (const offset of archetype.offsets) {
    const noise = (rng.next() - 0.5) * 0.2;
    out.push(toScore(base + offset + noise));
  }
  return [out[0] ?? 1, out[1] ?? 1, out[2] ?? 1, out[3] ?? 1];
}

// --- problem statements -----------------------------------------------------

/**
 * A handful of templated themes, each with several interchangeable phrasings and slot
 * fills. Variety matters: if every statement in a theme were the same sentence the
 * clustering step would have nothing real to do.
 */
interface ThemeTemplate {
  key: string;
  category: string;
  cores: string[];
  slots: Record<string, string[]>;
}

const OPENERS = [
  'Every week we',
  'Most weeks we',
  'The thing that eats my time is that we',
  'Right now we',
  "Honestly, the most frustrating part of my job is that we",
  'Across the team we',
  'For as long as I have been here we',
  'It sounds small, but we',
  'In my service we still',
  'My team and I still',
];

const CLOSERS = [
  "I'd like to see whether AI could take the first pass and leave us to check it.",
  'I want to find out how much of this can be automated without losing the audit trail.',
  'Even a rough first draft coming out automatically would give the team hours back.',
  "I'd like to build something my colleagues would actually use, not just a demo.",
  "I want to understand what's realistic here before we ask anyone for budget.",
  'If we could cut the manual step out entirely, that would change how the team works.',
  "I'm hoping to leave the day with something we can pilot in one service area.",
  "I'd like to try this on real examples and see where it falls over.",
];

const THEMES: ThemeTemplate[] = [
  {
    key: 'invoices',
    category: 'automate',
    cores: [
      're-key supplier invoices from {inbox} into {system} by hand, line by line',
      'chase purchase orders that do not match the invoice, which is {count} emails a week',
      'check every invoice against the contract before it can be approved in {system}',
      'reconcile {artifact} against {system} at month end, and the mismatches are always the same handful of suppliers',
    ],
    slots: {
      inbox: ['a shared mailbox', 'PDF attachments', 'scanned post', 'the finance inbox'],
      system: ['the finance system', 'our ERP', 'the payments ledger', 'the procurement portal'],
      artifact: ['supplier statements', 'the purchase order log', 'the accruals spreadsheet'],
      count: ['thirty or forty', 'well over fifty', 'a couple of dozen'],
    },
  },
  {
    key: 'policy-lookup',
    category: 'search',
    cores: [
      "cannot find the current version of a policy without asking {who}, and half the time they're on leave",
      'answer the same questions about {topic} because the guidance is spread across {places}',
      'have to read through {artifact} to find one clause, and nobody is confident it is the latest one',
      'lose time hunting for precedent decisions on {topic} that we know somebody has already made',
    ],
    slots: {
      who: ['the one person who wrote it', 'a colleague in Legal', 'whoever has been here longest'],
      topic: ['procurement thresholds', 'data sharing', 'eligibility rules', 'contract variations'],
      places: ['the intranet, email and three shared drives', 'four different SharePoint sites', 'PDFs and old email threads'],
      artifact: ['a 90-page policy pack', 'the contract library', 'years of committee minutes'],
    },
  },
  {
    key: 'reporting',
    category: 'analysis',
    cores: [
      'assemble the {cadence} report by hand from {sources}, and it takes two full days',
      'copy the same figures into the same slides every {period} before anyone reads them',
      'produce performance packs where the numbers are right but the commentary is written from scratch each time',
      'pull {sources} together just to answer one question from {who}',
    ],
    slots: {
      cadence: ['monthly', 'quarterly', 'weekly'],
      period: ['month', 'week', 'quarter'],
      sources: ['four separate exports', 'three systems that do not talk to each other', 'the case system and two spreadsheets'],
      who: ['a committee', 'the leadership team', 'an external auditor'],
    },
  },
  {
    key: 'enquiries',
    category: 'product',
    cores: [
      'take the same {count} enquiries about {topic} every week, and most of them have a published answer already',
      'want residents to be able to check {topic} themselves instead of waiting in a phone queue',
      'triage incoming requests by reading every one, when the routing rules are basically known',
      'send a holding reply to {topic} enquiries because nobody can get to them the same day',
    ],
    slots: {
      count: ['forty or fifty', 'over a hundred', 'a few dozen'],
      topic: ['bin collections', 'application status', 'appointment changes', 'benefits eligibility'],
    },
  },
  {
    key: 'drafting',
    category: 'content',
    cores: [
      'write near-identical {artifact} from a blank page every time, when 80% of the wording never changes',
      'spend an afternoon turning rough notes into {artifact} that follow our tone of voice',
      'rewrite the same {artifact} for three different audiences, and the plain-English version always slips',
      'draft {artifact} under time pressure, which is exactly when the quality drops',
    ],
    slots: {
      artifact: ['case notes', 'decision letters', 'briefing notes', 'service updates', 'grant applications', 'meeting minutes'],
    },
  },
  {
    key: 'spreadsheets',
    category: 'analysis',
    cores: [
      'clean up {artifact} before any analysis can start, and the same errors come back next month',
      'match records between {sources} by hand because the reference numbers never line up',
      'spot-check {artifact} for duplicates and typos, which is slow and we still miss things',
      'maintain a spreadsheet that {who} depends on, held together by formulas nobody else understands',
    ],
    slots: {
      artifact: ['an export full of inconsistent addresses', 'a returns spreadsheet', 'the supplier list', 'survey responses'],
      sources: ['two case systems', 'a CRM and a finance export', 'the old and new databases'],
      who: ['the whole service', 'three other teams', 'our reporting'],
    },
  },
  {
    key: 'onboarding',
    category: 'search',
    cores: [
      'walk every new starter through the same explanation of {topic}, because the induction material is scattered',
      'lose knowledge when someone leaves, because {topic} only ever lived in their head',
      'have induction notes that are two reorganisations out of date, and nobody owns updating them',
      'answer the same first-week questions about {topic} in {places}',
    ],
    slots: {
      topic: ['systems access', 'the approval routes', 'the case handling process', 'local procedures'],
      places: ['Teams chats', 'a 40-page handbook', 'one-to-one calls'],
    },
  },
  {
    key: 'scheduling',
    category: 'automate',
    cores: [
      'build the {cadence} rota by hand around leave, skills and site coverage, and one change breaks the lot',
      'juggle appointment slots for {count} staff on a whiteboard, then re-type it into {system}',
      'match visits to the right qualified officer, which is a puzzle somebody solves by hand every {period}',
      'redo the schedule whenever someone calls in sick, usually before 8am',
    ],
    slots: {
      cadence: ['weekly', 'fortnightly', 'monthly'],
      period: ['week', 'fortnight', 'month'],
      count: ['twelve', 'twenty', 'thirty-odd'],
      system: ['the scheduling system', 'the shared calendar', 'the works order system'],
    },
  },
];

const HOPES = [
  'A working prototype I can show my team on Monday.',
  'Enough confidence to try this without asking IT first.',
  'Ideas I can actually take back to my service, not theory.',
  'To meet people outside my department who have the same problem.',
  'A clearer sense of what AI is genuinely good at and what it is not.',
  'One thing removed from my to-do list permanently.',
  'To stop saying "we should look into AI" and start doing it.',
  "Hands-on practice — I've read plenty and built nothing.",
  'A realistic view of what we could pilot this year.',
  'Something I can hand over to a colleague and have it still work.',
];

function fillSlots(rng: Rng, template: string, slots: Record<string, string[]>): string {
  return template.replace(/\{(\w+)\}/g, (whole, key: string) => {
    const options = slots[key];
    if (!options || options.length === 0) return whole;
    return pick(rng, options);
  });
}

function problemStatementFor(rng: Rng, theme: ThemeTemplate): string {
  const opener = pick(rng, OPENERS);
  const core = fillSlots(rng, pick(rng, theme.cores), theme.slots);
  const closer = pick(rng, CLOSERS);
  return `${opener} ${core}. ${closer}`;
}

// --- timestamps -------------------------------------------------------------

/**
 * Fixed window rather than "now", because the output has to be byte-identical for a
 * given seed. Roughly matches the default form window in src/config.ts.
 */
const INVITE_SENT_AT = Date.UTC(2026, 7, 3, 9, 0, 0); // 2026-08-03T09:00:00Z
const RESPONSE_WINDOW_MS = 12 * 24 * 60 * 60 * 1000;

function isoAt(ms: number): string {
  return new Date(Math.round(ms / 1000) * 1000).toISOString();
}

// --- generator --------------------------------------------------------------

export function generateParticipants(options: GenerateOptions): FakeParticipant[] {
  const count = Math.max(0, Math.floor(options.count));
  const rng = createRng(options.seed ?? 1);
  const responseRate = options.responseRate ?? 0.82;
  const declineRate = options.declineRate ?? 0.09;
  const unsureRate = options.unsureRate ?? 0.08;
  const laptopRate = options.laptopRate ?? 0.68;
  const domain = options.emailDomain ?? 'example.org';

  const usedEmails = new Set<string>();
  const rows: FakeParticipant[] = [];

  for (let i = 0; i < count; i++) {
    const first = pick(rng, FIRST_NAMES);
    const last = pick(rng, LAST_NAMES);
    const name = `${first} ${last}`;

    const localPart = `${first}.${last}`.toLowerCase().replace(/[^a-z.]/g, '');
    let email = `${localPart}@${domain}`;
    for (let n = 2; usedEmails.has(email); n++) email = `${localPart}${n}@${domain}`;
    usedEmails.add(email);

    // ~8% never fill in a department even when they submit.
    const department = rng.next() < 0.92 ? pickWeighted(rng, DEPARTMENTS) : null;

    const row: FakeParticipant = {
      id: uuid(rng),
      token: hex(rng, 32),
      email,
      name,
      department,
      attending: null,
      problem_statement: null,
      category: null,
      skill_understanding: null,
      skill_tools: null,
      skill_prompting: null,
      skill_building: null,
      has_personal_laptop: null,
      hopes: null,
      submitted_at: null,
      updated_at: isoAt(INVITE_SENT_AT),
    };

    const responded = rng.next() < responseRate;
    const answerRoll = rng.next();
    const submittedAt = INVITE_SENT_AT + rng.next() * RESPONSE_WINDOW_MS;
    // A few people come back and edit their answer before the deadline.
    const editedAt = submittedAt + (rng.next() < 0.18 ? rng.next() * 3 * 24 * 60 * 60 * 1000 : 0);

    // Draw the whole person regardless, so the PRNG stream stays aligned and changing
    // the response rate does not reshuffle everybody's skills.
    const theme = pick(rng, THEMES);
    const statement = problemStatementFor(rng, theme);
    const [understanding, tools, prompting, building] = skillsFor(rng);
    // ~15% pick a category that does not match the obvious one for their problem —
    // real data is never that tidy, and the solver's category term should feel it.
    const category = rng.next() < 0.15 ? pickWeighted(rng, [
      { value: 'unsure', weight: 3 },
      { value: 'automate', weight: 2 },
      { value: 'search', weight: 2 },
      { value: 'analysis', weight: 2 },
      { value: 'product', weight: 1 },
      { value: 'content', weight: 2 },
    ]) : theme.category;
    const laptopRoll = rng.next();
    const hopesRoll = rng.next();

    if (responded) {
      row.submitted_at = isoAt(submittedAt);
      row.updated_at = isoAt(editedAt);

      if (answerRoll < declineRate) {
        // Declined: the form hides everything below the question, so nothing else is stored.
        row.attending = 0;
      } else {
        row.attending = answerRoll < declineRate + unsureRate ? 2 : 1;
        row.problem_statement = statement;
        row.category = category;
        row.skill_understanding = understanding;
        row.skill_tools = tools;
        row.skill_prompting = prompting;
        row.skill_building = building;
        // Confident builders are a little more likely to have a machine they control.
        row.has_personal_laptop = laptopRoll < laptopRate + (building >= 4 ? 0.14 : 0) ? 1 : 0;
        row.hopes = hopesRoll < 0.55 ? pick(rng, HOPES) : null;
      }
    }

    rows.push(row);
  }

  return rows;
}

// --- SQL --------------------------------------------------------------------

const COLUMNS = [
  'id',
  'token',
  'email',
  'name',
  'department',
  'attending',
  'problem_statement',
  'category',
  'skill_understanding',
  'skill_tools',
  'skill_prompting',
  'skill_building',
  'has_personal_laptop',
  'hopes',
  'submitted_at',
  'updated_at',
] as const;

/** Single quotes are doubled; control characters would break the statement, so they go. */
function sqlLiteral(value: string | number | null): string {
  if (value === null) return 'NULL';
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) throw new Error(`seed-fake: refusing to emit ${value} as SQL`);
    return String(value);
  }
  const clean = value.replace(/[\u0000-\u001f\u007f]/g, ' ').replace(/\s+/g, ' ').trim();
  return `'${clean.replace(/'/g, "''")}'`;
}

export const RESET_SQL = [
  'DELETE FROM team_members;',
  'DELETE FROM teams;',
  'DELETE FROM grouping_runs;',
  'DELETE FROM participants;',
].join('\n');

export function renderSql(rows: readonly FakeParticipant[], opts: { reset?: boolean; header?: string } = {}): string {
  const lines: string[] = [];
  if (opts.header) lines.push(`-- ${opts.header}`);
  if (opts.reset) {
    lines.push('-- --reset: wipes teams, runs and every participant already in this database.');
    lines.push(RESET_SQL);
  }
  lines.push('');
  for (const row of rows) {
    const values = COLUMNS.map((c) => sqlLiteral(row[c])).join(', ');
    lines.push(`INSERT INTO participants (${COLUMNS.join(', ')}) VALUES (${values});`);
  }
  lines.push('');
  return lines.join('\n');
}

// --- summary ----------------------------------------------------------------

export interface Summary {
  total: number;
  attending: number;
  unsure: number;
  declined: number;
  noResponse: number;
  laptops: number;
  builders: number;
  teamsAtTarget: number;
}

export function summarize(rows: readonly FakeParticipant[], targetTeamSize = 4): Summary {
  const attending = rows.filter((r) => r.attending === 1);
  const teamsAtTarget = attending.length === 0 ? 0 : Math.max(1, Math.round(attending.length / targetTeamSize));
  return {
    total: rows.length,
    attending: attending.length,
    unsure: rows.filter((r) => r.attending === 2).length,
    declined: rows.filter((r) => r.attending === 0).length,
    noResponse: rows.filter((r) => r.attending === null).length,
    laptops: attending.filter((r) => r.has_personal_laptop === 1).length,
    builders: attending.filter((r) => (r.skill_building ?? 0) >= 3).length,
    teamsAtTarget,
  };
}

function plural(n: number, word: string): string {
  return `${n} ${word}${n === 1 ? '' : 's'}`;
}

/** One line, so an operator can see at a glance whether this pool is solvable. */
export function summaryLine(s: Summary, seed: number, minLaptopsPerTeam = 2, targetTeamSize = 4): string {
  return (
    `seed ${seed}: ${s.total} rows — ${s.attending} attending, ${s.unsure} not sure, ${s.declined} declined, ` +
    `${s.noResponse} no response. Of the ${s.attending} attending, ${s.laptops} can bring a laptop and ` +
    `${s.builders} rate Building 3+; that is ${plural(s.teamsAtTarget, 'team')} of ${targetTeamSize}, needing ` +
    `${plural(s.teamsAtTarget, 'builder')} and ${plural(s.teamsAtTarget * minLaptopsPerTeam, 'laptop')}.`
  );
}

// --- CLI --------------------------------------------------------------------

const HELP = `Generate synthetic participants for SECC AI Builder Day.

Usage:
  npx tsx scripts/seed-fake.ts [options]

Options:
  -n, --count <n>   How many people to generate (default 60).
      --seed <n>    PRNG seed (default 1). The same seed always gives the same people.
      --out <file>  Write the SQL to <file>. Without it the SQL goes to stdout.
      --reset       Prefix the SQL with DELETE statements. THIS WIPES DATA: every
                    team member, team, grouping run and participant already in the
                    target database is deleted before the new rows are inserted.
                    Use it for a clean demo re-seed, never against real responses.
  -h, --help        Show this.

The one-line pool summary goes to stderr, so stdout stays pipeable.

Examples:
  npx tsx scripts/seed-fake.ts -n 60 --seed 1 --out scripts/.seed.sql
  npx wrangler d1 execute secc-builder-day --local --file scripts/.seed.sql

  # or in one step (this is what \`npm run seed:local\` does):
  npx tsx scripts/seed-fake.ts --reset --out scripts/.seed.sql \\
    && npx wrangler d1 execute secc-builder-day --local --file scripts/.seed.sql
`;

interface CliOptions {
  count: number;
  seed: number;
  out: string | null;
  reset: boolean;
  help: boolean;
}

function parseArgs(argv: readonly string[]): CliOptions {
  const opts: CliOptions = { count: 60, seed: 1, out: null, reset: false, help: false };

  const readNumber = (flag: string, example: string, raw: string | undefined): number => {
    if (raw === undefined || raw.trim() === '') {
      throw new Error(`${flag} needs a number, e.g. ${flag} ${example}`);
    }
    const n = Number(raw);
    if (!Number.isFinite(n) || !Number.isInteger(n) || n < 0) {
      throw new Error(`${flag} needs a whole number of 0 or more, not "${raw}"`);
    }
    return n;
  };

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === undefined) continue;
    const eq = arg.indexOf('=');
    const flag = arg.startsWith('--') && eq > -1 ? arg.slice(0, eq) : arg;
    const inline = arg.startsWith('--') && eq > -1 ? arg.slice(eq + 1) : undefined;
    const takeValue = (): string | undefined => {
      if (inline !== undefined) return inline;
      i += 1;
      return argv[i];
    };

    switch (flag) {
      case '-h':
      case '--help':
        opts.help = true;
        break;
      case '-n':
      case '--count':
        opts.count = readNumber('--count', '60', takeValue());
        break;
      case '--seed':
        opts.seed = readNumber('--seed', '1', takeValue());
        break;
      case '--out': {
        const value = takeValue();
        if (value === undefined || value.trim() === '') {
          throw new Error('--out needs a file path, e.g. --out scripts/.seed.sql');
        }
        opts.out = value;
        break;
      }
      case '--reset':
        opts.reset = true;
        break;
      default:
        throw new Error(`Unknown option "${arg}". Run with --help to see the options.`);
    }
  }

  return opts;
}

function main(argv: readonly string[]): number {
  let opts: CliOptions;
  try {
    opts = parseArgs(argv);
  } catch (err) {
    process.stderr.write(`${err instanceof Error ? err.message : String(err)}\n`);
    return 1;
  }

  if (opts.help) {
    process.stdout.write(HELP);
    return 0;
  }

  const rows = generateParticipants({ count: opts.count, seed: opts.seed });
  const sql = renderSql(rows, {
    reset: opts.reset,
    header: `${rows.length} synthetic participants generated by scripts/seed-fake.ts --seed ${opts.seed}. Not real people.`,
  });

  if (opts.out) {
    try {
      writeFileSync(opts.out, sql, 'utf8');
    } catch (err) {
      const reason = err instanceof Error ? err.message : String(err);
      process.stderr.write(`Could not write ${opts.out}: ${reason}. Check the directory exists and is writable.\n`);
      return 1;
    }
  } else {
    process.stdout.write(sql);
  }

  process.stderr.write(`${summaryLine(summarize(rows), opts.seed)}\n`);
  if (opts.out) process.stderr.write(`Wrote ${rows.length} INSERTs to ${opts.out}.\n`);
  return 0;
}

const entry = process.argv[1];
if (entry !== undefined && import.meta.url === pathToFileURL(entry).href) {
  process.exitCode = main(process.argv.slice(2));
}
