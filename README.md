# AI Builder Day — check-in and team formation

An internal tool for the two weeks before an in-person AI Builder Day.

**Phase 1.** Participants get a personal link, confirm whether they are attending,
describe a work problem they would like to tackle with AI, self-rate their AI capability
across four dimensions, and say whether they can bring a laptop.

**Phase 2.** Organizers press a button. The problem statements are clustered into themes,
then people are assigned to balanced teams that satisfy hard constraints — laptop
coverage, at least one capable builder per team, sensible size. Organizers review, drag
people between teams, and publish.

Cloudflare Workers + Hono + D1, one deployment unit. Cloudflare Access guards `/admin/*`;
there is no authentication code in this repository and there should never be any.

---

## Local development

```bash
npm install

# Create the local D1 database and apply migrations
npx wrangler d1 create secc-builder-day     # copy the printed database_id
#   → paste it into wrangler.jsonc under d1_databases[0].database_id
npm run db:migrate:local

npm run dev            # http://localhost:8787
```

`wrangler dev` has no Cloudflare Access in front of it, so `/admin` falls back to the
`DEV_ADMIN_EMAIL` var in `wrangler.jsonc`. That fallback only applies when the
`Cf-Access-Authenticated-User-Email` header is absent, which in production it never is.

### Fake data

Nothing about the app needs to wait for real responses:

```bash
npm run seed:local                          # 60 synthetic participants, wiped and reseeded
npx tsx scripts/seed-fake.ts --help         # options: --count, --seed, --out, --reset
```

The generator is seeded, so the same `--seed` gives the same people every time. It prints
a one-line summary to stderr — how many attending, how many laptops, how many builders at
3+ — so you can see at a glance whether the generated pool is solvable.

### Tests

```bash
npm test           # vitest, the grouping engine
npm run typecheck  # tsc over src/, test/ and scripts/
```

The grouping engine is a pure module with no D1 or network calls inside it, so its tests
run in plain Node in a couple of seconds. That is where the coverage is concentrated;
everything else is deliberately light.

---

## Migrations

Migrations live in `migrations/` and are applied by Wrangler in filename order.

```bash
npm run db:migrate:local     # local D1
npm run db:migrate:remote    # the deployed database — do this before deploying code that needs it
```

Never edit an applied migration; add a new numbered file.

---

## Deploy

```bash
npx wrangler secret put ANTHROPIC_API_KEY
npx wrangler secret put RESEND_API_KEY
npx wrangler secret put TURNSTILE_SECRET_KEY

npm run db:migrate:remote
npm run deploy
```

Non-secret configuration lives in `wrangler.jsonc` → `vars`. **Set `PUBLIC_ORIGIN` to the
real domain before sending any email** — it is what personal links are built from, and
the default points at localhost.

| Var | What it does |
|---|---|
| `EVENT_NAME`, `EVENT_DATE` | Shown to participants |
| `FORM_OPENS`, `FORM_DEADLINE` | The form is read-only outside this window |
| `LOCAL_UTC_OFFSET_HOURS`, `REMINDER_LOCAL_HOUR` | When the reminder cron actually sends |
| `PUBLIC_ORIGIN` | Base of every personal link |
| `FROM_EMAIL` | Sender on all outbound mail |
| `MAX_REMINDERS` | Reminders per person before we stop (default 2) |
| `ANTHROPIC_MODEL` | Defaults to `claude-sonnet-5` |
| `AI_GATEWAY_URL` | Route the Anthropic calls through AI Gateway; leave empty to call the API directly |
| `TURNSTILE_SITE_KEY` | Renders the widget; leave empty to skip the check entirely |
| `DEV_ADMIN_EMAIL` | Local-dev-only stand-in for the Access header |

### Cloudflare Access policy

1. Zero Trust dashboard → **Access → Applications → Add an application → Self-hosted**.
2. Application domain: your domain, path `/admin`. Add a second application for
   `/admin/*` if your Access version does not treat the path as a prefix.
3. Policy: **Allow**, include → *Emails* (the organizers) or an *Email domain* rule.
4. Leave everything else at its default. Access injects
   `Cf-Access-Authenticated-User-Email`, which is the only thing this app reads.

Do **not** put `/r/*` or `/teams` behind Access — participants have no accounts, and the
projected team view has to open on a room laptop that nobody has logged into.

### Cron

`wrangler.jsonc` registers `0 * * * *` — hourly. The handler returns immediately unless
it is `REMINDER_LOCAL_HOUR` on a weekday in the configured offset, so the schedule is a
config value rather than a cron edit, and a double fire is harmless. Every send is gated
on `email_log` regardless.

---

## Day-of runbook

*Written for someone who has not read the build spec and is standing in a room with 40
people waiting. Everything here is reachable from `/admin`.*

### Before anything else

Open **`/teams`** on the room's projector. That is the published team list. It is a plain
read-only page, it prints, and it needs no login.

If it says no teams are published, go to **Grouping runs**, open the most recent finished
run, check it over, and press **Publish teams**.

### Someone did not show up

1. **Participants** → find them → set *Attending* to **No** → Save.
2. **Grouping runs** → open the published run → **Review teams**.
3. Drag them into the **Unassigned** column at the end of the board.
4. The teams they left will immediately say what is now wrong, in words — for example
   *"Only 1 laptop — needs 2"*. Fix it by dragging someone across; the warnings update as
   you go.
5. **Save changes**. Refresh `/teams` on the projector.

Do **not** start a new run to handle no-shows. A new run is a fresh arrangement and
throws away every manual move you have made.

### Someone turned up who was not invited

1. **Participants → Add participant**. Name and email are enough, but if they are standing
   in front of you, also tick whether they brought a laptop and set their four capability
   scores — it takes fifteen seconds and it is what the teams are balanced on.
2. Their personal link appears on screen. Hand it to them to fill in the rest, or type
   their problem statement in yourself.
3. **Review teams** → drag them onto a team. Watch the warnings; put them where they help.
4. **Save changes**.

### A team has no laptop / no builder

The review board tells you which team and what it is short of. Drag one person across
from a team that has spare. Every team re-checks itself as you drop.

If the whole room is short — the run page will have said so up front, e.g. *"Only 6
participants rating themselves 3+ on Building across 9 teams"* — then no arrangement can
fix it. Pair two teams up, or ask a facilitator to sit with the teams that have nobody.

### Reprint or re-project the teams

`/teams` → browser print (Cmd/Ctrl-P). The stylesheet has a print layout: one card per
team, no navigation, no colours that vanish on a mono printer.

### The grouping engine will not run, or produces nonsense

**Participants → Export CSV.** Every answer anyone gave is in that file, with the four
skill scores in four separate columns. Group by hand in a spreadsheet; you have lost
nothing but the convenience.

This is the intended fallback, not an emergency. It was built before the solver was.

### Someone cannot find their link

**Participants** → search their name → their personal link is on the row, and there is a
**Resend link** button next to it. If their email was wrong, fix it on their detail page
first — the link is tied to the person, not the address.

### Re-running the grouping

**Grouping runs → Start a run.** Adjust team size bounds or weights if the first result
was not right; each run is kept, with its score and violation count, so you can compare
two and publish whichever is better.

A new run **discards manual edits** made on a previous run's board. The app warns you
before you do it. Publishing a run makes it the canonical one and unpublishes the other.

---

## How the grouping works, in one screen

```
attending participants
  → [model] cluster problem statements into named themes
  → validate: every id used exactly once, no invented ids, sensible theme count
  → [code]  allocate team slots to themes
  → [code]  seed the strongest builders one per team, then snake draft the rest
  → [code]  repair hard-constraint violations with the cheapest swaps
  → [code]  local search on the soft score
  → [model] write team names, briefs and rationales
  → persist
```

The model reads prose and writes prose. It never decides who is on which team — that is
deterministic, seeded, and tested. Constraint satisfaction is the thing language models
are worst at, and the failure mode is invisible: plausible-looking output with a team
that has no laptops.

**Hard constraints** — every team is within the size bounds; every team has at least two
people with a laptop; every team has someone rating themselves 3+ on Building; no team is
entirely novices. When the room itself cannot satisfy one of these, the run does not fail
and does not quietly relax it: it spreads the scarce resource as evenly as it can and
tells you, in a sentence with real numbers, what is short and what you might do about it.

**Soft score** — theme cohesion (3.0), within-team skill diversity (1.5), across-team
balance (2.0), category match (1.0), department mixing (0.5). All five are computed on the
four-dimensional skill vector; the four axes are never summed into one number, because
someone strong at prompting and weak at building is not interchangeable with the reverse
— and we want the two of them on the same team.

Runs are immutable. Re-running creates a new one; the same seed and the same input produce
the same teams, so you can tell what changed and why.

---

## Repository map

```
src/
  config.ts          every event tunable, in one place
  index.tsx          Worker entry: routes + the scheduled handler
  grouping/          the pure solver — no D1, no fetch, no clock in any decision
  llm/               clustering and naming calls, both with deterministic fallbacks
  run/pipeline.ts    orchestration: load → cluster → solve → narrate → persist
  routes/            participant form, admin screens, the public team view
  db/                D1 access
  email/             Resend behind one sendEmail() interface, plus the reminder sweep
  lib/               CSV, validation, dates, Access gate, Turnstile
  ui/layout.tsx      shared page shell
public/              styles.css and two small progressive-enhancement scripts
migrations/          D1 schema
scripts/seed-fake.ts synthetic participants
test/                the solver's tests
```

`DECISIONS.md` records the judgement calls, including the ones the build spec left open.
