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

## Resolved: the capability section no longer repeats its descriptors twenty times

Four axes times five levels, each carrying the full scale descriptor, made the form about
4700px tall on a phone. §5 requires the descriptors to be inline and always visible rather
than in a tooltip, so they could not be hidden.

Restructured rather than trimmed: the 1-5 scale is now stated once, in full, in an
always-visible legend at the top of the capability section, and each axis is a single row
of five options. The descriptors are still on the page, still not in a tooltip, and are
now read once instead of four times.

Below ~26rem the option labels are visually hidden and the numbers stand alone, because
five names cannot fit on one line each at 360px and "Comfortable" breaks mid-word. The
legend sits directly above, which is the ordinary Likert arrangement. The names stay in
the accessibility tree, so a screen reader never announces a bare digit.

The section went from roughly 700px per axis to roughly 200px; all four axes and the
laptop question now fit within about a screen and a half instead of four screens.

---

# Defects found by review, and how they were fixed

An adversarial review pass over the finished code produced 20 candidate findings; 9 were
refuted on inspection and 11 confirmed, which deduplicate to six real defects. All six are
fixed. The three serious ones are worth recording, because each was invisible from the
outside and each would have surfaced on the day.

## A team could be published under a theme none of its members wrote about

`teamBucket[t]` was fixed when team slots were allocated and never updated afterwards, but
the emitted `theme_label` read from it. Local search legitimately exchanges whole groups
between teams to raise cohesion, so after it ran the label followed the *slot* rather than
the *people*. That label is written to `teams.theme_label`, passed to the naming call as
the team's theme, and shown on the review board, the projected page and the announcement
email.

Across a 2668-team sweep, 65 teams carried a label with zero members from that theme.
Teams are now labelled by the theme their final members actually came from, with a
deterministic tie-break; the same sweep now reports zero.

## Reminders could be sent twice

Eligibility was read from `email_log` once, before a batch started, and `reserve()` was an
unconditional INSERT with no unique index. Any second trigger starting while a batch was
still draining — the hourly cron firing during an organizer's "Send reminders" click, or a
retried cron — re-selected and re-sent to everyone not yet reserved. §8 says that must be
impossible.

The rule now lives in the schema (`migrations/0002_email_day_key.sql`): a unique index on
`(participant_id, kind, day_key)`, where `day_key` is the **local** calendar day. A second
reserve fails and that person is skipped. A failed send sets `day_key` to NULL, releasing
the slot — SQLite treats NULLs as distinct in a unique index — so a genuine failure can
still be retried, while a race cannot double-send.

## Walk-ins were invisible to the grouping engine

`POST /admin/participants/new` never set `submitted_at`, and both the review board and the
solver draw their pool from `listAttendingSubmitted` (`attending = 1 AND submitted_at IS
NOT NULL`). A walk-in added with every field filled in was therefore in no run, and did not
even appear in the Unassigned column — so the README's own walk-in procedure, "drag them
onto a team", could not be carried out. A walk-in marked as attending now gets
`submitted_at` at the moment they are added, because a person standing in the room is a
response.

## The three smaller ones

- **Score disagreement.** The review board rebuilt its theme lookup from the raw clustering
  labels while the solver had scored against post-merge buckets, so an untouched
  arrangement showed a different number on the run page and the board — which claims to use
  "the same logic the solver used". The solver now emits the keys it actually scored
  against, the pipeline stores them, and the board uses them. Verified: stored and
  recomputed scores now agree exactly.
- **Nameless members vanished from the projected page.** A member with no name on record was
  dropped from both the `/teams` roster and its headcount. They now appear as "Name not
  recorded" and are counted — deliberately not their email, since `/teams` is the one route
  not behind Cloudflare Access.
- **An emptied team name rendered as a blank heading**, because `?? 'Team N'` does not fire
  for an empty string.

---

## The solver runs in the browser, so the free Cloudflare plan is enough

The build spec says to assume the Workers Paid plan, because "the free tier's 10ms CPU
limit will not accommodate the team solver". That is correct — measured here, balancing
takes 12ms for 40 people, 25ms for 80 and 61ms for 150, and switching local search off
entirely only brings 150 people down to 14ms. No amount of tuning fits it into 10ms.

Rather than require a paid plan, the balancing step moved into the organizer's browser.
This is only possible because §6 required the grouping engine to be a pure module with no
D1 or network calls inside it: the same bundle runs unchanged in a browser.

The split is now:

- **Worker** — loads participants, clusters the problem statements (a network call, so
  cheap in CPU terms), hands the browser a seeded input, then names and persists what
  comes back. All I/O, no computation.
- **Browser** — runs `solve()` and posts the arrangement.

Three things keep this honest:

1. **The result is identical.** The run carries its seed, the solver is deterministic, and
   a browser solve and a server solve of the same pool were compared directly: weighted
   total 4.857067 and theme cohesion 0.90625 from both.
2. **The membership is checked, not trusted.** The server rejects an unknown participant
   id or the same person on two teams, and a second POST for a run that is already done is
   a no-op rather than a duplicate write.
3. **The score is recomputed server-side**, which costs 0.15ms, so the numbers an
   organizer reads always come from the same code path as everything else — never from
   whatever the page sent.

The cost is that this one admin screen needs JavaScript. That is a real departure from
the progressive-enhancement rule, so it is stated plainly on the page: if JavaScript is
off, the run page says so and points at the CSV export. The participant form — the part
the spec cared about, filled in on phones with bad wifi — is untouched and still works
with JavaScript disabled.

---

## One open link, not only personal token links

§4 says participants are seeded from an invite list rather than self-registering, because
that is what lets organizers see who has *not* replied. That reason is real and the invite
flow is still there.

But it makes the smallest version of this event needlessly heavy: to collect any answers
at all you first have to assemble a list, upload it, and distribute forty individual URLs.
For an organizer who just wants to put one link in one message to their department, that
is the wrong shape.

`/join` is that link, and the bare domain redirects to it. Email address is the identity:
returning to the link from the same address updates that person's answers rather than
creating a second record, and someone who was on the invite list is matched to their
existing row, keeping the personal link they were sent. Both routes run the same
`validateSubmission`, so the two entry points cannot drift on what counts as a valid
answer.

What is given up: with no invite list there is no denominator, so the dashboard can show
how many people replied but not how many have not. Uploading a list is still offered, and
is worth it when chasing non-responders matters.

## Links are built from the request, not from configuration

`PUBLIC_ORIGIN` used to default to `http://localhost:8787`, which meant a deploy that
skipped that setting would show a localhost link on the dashboard — and the dashboard is
where an organizer copies the link they send to their whole department. A setting that is
load-bearing, easy to miss, and silently wrong is the wrong shape.

Every link shown to a human is now derived from the origin of the request being served,
via `loadConfigFor`. The var is empty by default and only needs setting for email, where
the reminder cron has no request to read from — and the email screen already warns when it
looks local. Verified by requesting the admin pages with a different Host header: both the
share link and the personal links follow it.

## Two deploy routes, one provisioning script

The one-command `scripts/setup.sh` needs Node on the operator's machine, which is a real
barrier for an organizer who does not otherwise use a terminal. A GitHub Actions workflow
now does the same deploy from GitHub's machines: two secrets pasted into the repo settings
in a browser, then a Run button.

Both call `scripts/provision-d1.mjs` rather than each having their own copy of the
find-or-create-then-patch logic, so the routes cannot drift. The CI run also typechecks
and runs the solver tests before deploying, and the provisioning script exits non-zero on
failure so a missing permission stops the deploy instead of shipping against no database.

## The dev auth fallback is gated on a local hostname

`DEV_ADMIN_EMAIL` stands in for the Cloudflare Access header so `/admin` is reachable
under `wrangler dev`. It is an ordinary var, so it ships with a deploy — and the first
real deployment proved the consequence: with the var set and no Access policy yet in
place, every admin screen was open to anyone who found the URL, with every participant's
email and problem statement behind it.

The fallback now applies only when the request hostname is `localhost`, `127.0.0.1` or
`[::1]`. On any other host the middleware refuses and explains how to set up Access. A
deployment that has not been protected yet fails shut rather than open, which is the
right direction for a gate whose whole job is to be shut.
