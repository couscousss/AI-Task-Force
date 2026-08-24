# Decisions

Every `[DECIDE]` from the build spec, plus the judgement calls that were not in it.
Recorded so that the next person does not have to re-derive them.

---

## Parameters left as `TODO` in §0

The spec said: if these are still `TODO`, put them in a single `config.ts` with sensible
defaults so they are changeable in one place. They are all in `src/config.ts`
(`EVENT_DEFAULTS`), and every one of them is also overridable from `wrangler.jsonc`
→ `vars` without a code change.

| Parameter | Default chosen | Why |
|---|---|---|
| Event date | `2026-09-18` | A placeholder Friday. Set `EVENT_DATE` before invites go out. |
| Form opens / closes | `2026-09-04` → `2026-09-15 17:00 +08:00` | The spec's "two weeks before", ending the working day before the event. |
| Expected participants | 80 | Middle of the 40–150 design range; only used for dashboard framing. |
| Target team size | 4 (min 3, max 5) | Locked by the spec. Configurable per run from the admin UI. |
| Organizer emails | empty | Cloudflare Access is the real gate; `ORGANIZER_EMAILS` is informational only. |
| Domain | `http://localhost:8787` | `PUBLIC_ORIGIN` — must be set before any email is sent, or links will point at localhost. |

Timezone is expressed as a fixed UTC offset (`LOCAL_UTC_OFFSET_HOURS`, default +8) rather
than an IANA zone. The event window is two weeks with no DST transition in the target
region, and this avoids shipping a timezone database into a Worker.

---

## §5.6 — the "what would you like to explore or build?" list

Kept the spec's starter list verbatim, but stored as stable machine keys
(`automate`, `search`, `analysis`, `product`, `content`, `unsure`) with the label as
presentation. Renaming a label later then does not orphan data already collected, and
the clustering fallback groups on the key rather than on prose that might have changed
mid-collection.

Confirm the final wording with the organizers; it is one array in `src/config.ts`.

---

## §6.5.2 — merging themes smaller than `min_team_size`

**Chosen: deterministic token overlap (Jaccard), with a "Mixed" bucket as backstop.**

A small theme is merged into the theme with the highest Jaccard similarity over the
lowercased word tokens of `label + summary`, minus a short stopword list. Ties break on
larger theme first, then label ascending, so the result cannot depend on map ordering.

Rejected alternatives:

- *Embeddings.* Another network call, another failure mode on the morning of the event,
  and it would put a model back in the critical path of something that must not depend
  on one. §3.2's spirit is that the deterministic side stays deterministic.
- *A second LLM call to merge.* Same objection, plus it makes re-running with the same
  seed non-reproducible.

Token overlap is crude, but the input is a handful of themes with descriptive labels
generated moments earlier by the same model, so the labels share vocabulary when the
themes are genuinely related. Where nothing overlaps at all, the leftovers land in a
"Mixed" bucket, which is honest rather than confidently wrong.

---

## Additions to the schema in §4

Two, both small, both visible in `migrations/0001_init.sql`:

1. **`participants.attending` also accepts `2` = "not sure yet".** The form in §5 offers
   three answers but the column comment lists two. Squeezing "not sure" into NULL would
   destroy the distinction between *has not replied* and *replied, undecided* — and the
   number organizers chase is the first one. The solver only ever considers `attending = 1`.
2. **`grouping_runs.progress`.** §6.6 requires the admin page to show real progress
   ("Clustering 47 problem statements"), not an indefinite spinner. That string has to
   live somewhere the polling request can read it.

Also added: a partial unique index enforcing that at most one run can have
`is_published = 1`. §4 states the rule; this makes it unbreakable, including from the
D1 console.

---

## Live constraint re-validation is a server round-trip

§7 requires that dragging a person between teams re-validates every constraint live.
The alternative to a round-trip is reimplementing the constraint logic in browser
JavaScript, which means two implementations of the rules that decide whether the day
works, drifting apart from the first bugfix.

`POST /admin/review/:runId/validate` calls the same `evaluateArrangement()` the solver
uses. One source of truth, ~50ms on an office network, debounced at 250ms. The board
shows a "checking…" state and keeps the last known result if the call fails, rather
than silently showing green.

---

## Cron fires hourly and decides for itself

§8 asks for reminders on weekdays at 09:00 *local*. Cron triggers are UTC-only, so
encoding the offset in the cron expression would bury a config value in
`wrangler.jsonc` and break silently if the event moved timezone.

Instead the trigger is `0 * * * *` and `runReminderSweep()` returns immediately unless
it is `REMINDER_LOCAL_HOUR` on a weekday in `LOCAL_UTC_OFFSET_HOURS`. A double fire is
harmless because every send is gated on `email_log` anyway — which §8 requires
regardless.

---

## Plain Vitest, not `@cloudflare/vitest-pool-workers`

§6 requires the grouping engine to be a pure module with no D1 or network calls inside
it, and §11 asks for it to be exercised entirely with generated fixtures. Pure TypeScript
tested in Node needs no Workers runtime, runs in a fraction of the time, and removes a
whole class of setup failure from the one part of the system where correctness matters
most. Everything else in the spec is explicitly "light coverage is fine".

---

## Hono JSX rather than template strings

Server-rendered HTML either way — no SPA, no client router, no state library, exactly as
§2 requires. JSX escapes interpolated text by default, which matters because
participant-written problem statements are rendered on the admin screens and on the
projected team view. Template strings would make that a per-call-site decision, and one
missed escape is a stored-XSS bug on a page an organizer projects onto a wall.

---

## Skill vectors: how aggregate statistics avoid §3.1

§3.1 forbids collapsing the four axes into one number as a solver input. Two of the soft
score components are nonetheless *statistics over a population*:

- **Within-team skill diversity** computes a standard deviation **per axis** across a
  team's members, then averages those four numbers.
- **Across-team balance** computes each team's mean **per axis**, then the variance of
  that per-axis mean across teams, then averages the four variances.

In both cases the aggregation happens over per-axis statistics, never over a per-person
scalar. No participant is ever reduced to a single number on the way in. The admin UI
does show a derived total as a rough sort key, which §3.1 explicitly permits — it is not
passed to the solver.

---

## Anthropic model

`claude-sonnet-5`, set in `src/config.ts` and overridable via the `ANTHROPIC_MODEL` var,
per §6.2's "default to a current Sonnet-class model". Called via the official
`@anthropic-ai/sdk` with `baseURL` pointed at AI Gateway when `AI_GATEWAY_URL` is set.

Structured outputs (`output_config.format` with a Zod schema) do the shape validation, so
the retry loop in §6.2 only has to handle the *semantic* rules — ids appearing exactly
once, no invented ids, theme count within bounds — rather than malformed JSON.

Note for whoever revisits this: on this model generation `temperature`, `top_p`, `top_k`
and `thinking.budget_tokens` are rejected with a 400, and assistant prefill is not
available. The call sites are written accordingly.

---

## Turnstile and Resend degrade rather than block

If `TURNSTILE_SECRET_KEY` is unset the check is skipped; if `RESEND_API_KEY` is unset
`sendEmail()` returns a clear failure instead of throwing. Neither is a security position
— it is that an expired key must not be able to take the participant form down on the
morning of the event. Both are logged.

---

## Spreadsheet-injection guard on CSV export

`toCsv()` prefixes any cell starting with `=`, `+`, `-`, `@` or a control character with
an apostrophe. §3.3 makes the CSV the escape hatch, which means it gets opened in Excel
by a stressed organizer; a problem statement beginning with "=" should not become a
formula.

---

## Typography: two webfonts, loaded non-blocking

§9 asks for calm, legible, and fast, with real type hierarchy. The first pass used the
system font stack, which is fast but reads as unstyled — and on an internal tool that
people fill in once, "unstyled" reads as "thrown together", which is exactly the wrong
signal above a question about someone's own capability.

Chosen: **Newsreader** for headings (a warm, low-contrast serif — it gives the form a
human voice, which matters directly under the sentence saying this is not a performance
assessment) and **Public Sans** for body and UI (highly legible at small sizes on a
phone, neutral without being the default everyone reaches for).

Both are loaded from Google Fonts with `display=swap` and `preconnect`, so text paints
immediately in the fallback stack and swaps when the font arrives. Nothing blocks
rendering — which is the actual requirement behind "participants will fill this in on
phones with bad conference wifi", and matters more than the two extra requests.

## "Required" is a word, not an asterisk

A bare red `*` is a convention the reader has to decode, and it carries meaning by colour
alone. The `.req` element renders as a small "REQUIRED" chip and `.optional` as a muted
"OPTIONAL" one, so the state is legible without relying on colour and without a legend.
Done in CSS against the existing markup, so no view had to change.

## Still open: the capability section repeats its descriptors twenty times

Four axes times five levels, with the full scale descriptor on every option, makes the
form about 4700px tall on a phone. §5 requires the descriptors to be inline and always
visible rather than in a tooltip, so they cannot be hidden.

Tightened the spacing as far as it goes without cramping (roughly 8% shorter). The real
fix is structural — show the 1–5 scale once as an always-visible legend, then render the
four axes as compact segmented rows — which still satisfies "always visible" and would cut
the section by more than half. That is a change to the form's markup rather than its
stylesheet, and is worth doing before the invites go out.

---

# Decisions taken while building

## Publishing locks deletion, not editing — a deliberate deviation from §7

§7 says "Publish locks the run and makes it the canonical one." Taken literally, that
would freeze the team arrangement at exactly the moment it most needs to change: §7 also
says the drag interaction is "the single most important interaction in the app — the
day-of reality is no-shows", and no-shows happen after teams are published, not before.

So publish makes the run canonical and refuses deletion, but the board stays editable,
with a banner saying that saved changes go live on `/teams` immediately. The two
sentences in §7 pull in opposite directions; this resolves them in favour of the one
about the morning of the event.

## Draft order is lexicographic across the four axes, never a sum

§6.5 says to snake draft "ordered by capability", and §3.1 forbids a scalar total. The
order is therefore lexicographic: building, then prompting, then tools, then
understanding, tie-broken on participant id. Building leads because seeding the strongest
builders first is what front-loads H3.

## Soft-score normalisation

Cohesion, category and department shares are already 0..1. Skill diversity is the mean of
the four per-axis population standard deviations divided by 2 (the maximum on a 1..5
scale) → [0,1]. Across-team balance is the mean of the four per-axis variances of team
means divided by 4, negated → [-1,0]. Negative zero is collapsed to zero so that two
identical arrangements serialise identically.

## Repair requires a strict fall in total hard cost

Not merely "no increase". Two teams each holding exactly `min_laptops_per_team` would
otherwise trade a laptop owner back and forth forever — a real cycle, found at n=53.
Size violations are repaired before laptops, builders and novices, because size is
structural and an oversized team late in the list would otherwise never be reached on a
laptop-poor pool.

## The form requires category and all four skill scales from anyone not declining

§5 names only name, attending, email, problem statement and laptop as required. But a
missing skill answer becomes a `1` in `toSolverParticipant`, which silently distorts team
balance rather than failing loudly — and "Not sure yet" is a real category answer, so
nobody is blocked. Only an explicit **No** exempts the rest of the form; "Not sure yet"
is validated as attending.

## CSV export ignores the table filters

It always contains every participant and every column. A filtered export at 8am would
silently lose people, and §3.3 makes this the escape hatch. The page says so under the
toolbar. Values are human-readable (Attending / Declined / Not sure), the four skills
stay four separate integer columns, and the personal link is included so links can be
handed out from a spreadsheet.

## Invite parsing detects a header by "no @ anywhere in the row"

Checked before matching `mail`/`name` against cell text — otherwise a headerless first
row like `Ada,ada@example.org` is eaten as a header. Headerless files find the email by
the `@` and take the other non-empty cell as the name, so either column order works.
Duplicate emails within one file are reported as skips rather than silently deduped, so
the counts reconcile against the organizer's own file.

## Email: never the same message to the same person twice on the same local day

The rule applies to all three kinds, not just reminders. A single-participant invite
resend is gated by "sent today" rather than "ever sent" — a hard ever-gate would make the
Resend link button on the participants table permanently dead, while a stray double-click
still cannot double-send.

Bulk sends cap at 100 messages per invocation with a 250ms pause, and stop after five
consecutive failures. Reserve-before-send makes a truncated batch safe to resume: anyone
missed stays eligible, and the summary says to click again for the remainder. Bulk sends
run in `waitUntil`, so the redirect states the plan rather than the outcome — the log
table is the record of what actually happened.

## Clustering call details

`AI_GATEWAY_URL` must already include the provider path (`…/anthropic`); the SDK appends
`/v1/messages`. Problem statements are truncated to 600 characters for the clustering
call and 400 for the naming call — in the prompt only; D1 keeps the full text and both
the admin UI and the CSV show it.

The retry feeds the previous JSON back as an assistant turn plus a user turn listing the
failed checks. That is an ordinary conversation turn, not an assistant prefill, which is
not available on this model generation.

Naming accepts partial answers: teams the model named are kept, the rest fall back to
`Team N` with the theme summary as the brief. By the time naming runs the teams are
already correct, so this step must never be able to fail a run.

## Seed data is generated from a fixed clock

Timestamps come from a fixed window (invites sent 2026-08-03, responses spread over 12
days) rather than `Date.now()` — "same seed, same output" cannot hold if the clock is an
input. Skills are drawn from one low-skewed latent ability plus a weighted archetype tilt
(newcomer / reader / power-user / tinkerer / builder). The archetypes are what make
"strong prompting, weak building" a real subpopulation rather than noise, which is the
whole reason the four axes exist: at n=4000, 173 people rate prompting ≥4 with building
≤2, against 58 the other way round.
