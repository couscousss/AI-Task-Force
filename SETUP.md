# Getting this live

Read the first section before you start. It decides how the next three hours go.

---

## The one thing that can blow your deadline

Everything here takes about twenty minutes **except sending email from your own
domain**, which needs DNS records to propagate and is outside your control.

The app is built so that email is optional. Without it:

- Personal links are on every row of **Participants**, and in the **CSV export**.
- You hand them out by mail-merge, by pasting into your own mail client, or over Slack.
- Everything else — the form, grouping, the review board, the projected team list —
  works exactly the same.

**So: deploy first, decide about email second.** Do not let a DNS record hold up the
rest.

---

## Step 1 — Deploy (about 10 minutes)

```bash
git clone https://github.com/couscousss/AI-Task-Force.git
cd AI-Task-Force
git checkout claude/web-application-k0lv8g
./scripts/setup.sh
```

The script logs you into Cloudflare (a browser window opens), creates the D1 database,
writes its id into `wrangler.jsonc`, applies the schema, deploys, and points
`PUBLIC_ORIGIN` at the URL it just got. It is safe to run again if anything fails
part-way.

**The free Cloudflare plan is enough.** A Worker on the free plan is cut off at 10ms of
CPU per request, and balancing teams needs 12ms for 40 people and 61ms for 150 — so that
one step runs in the organizer's browser instead. It is the same code with the same
seed, so the teams are identical; measured side by side, the score matches to six
decimal places. The only thing this asks of you is to keep the tab open for the few
seconds it takes, and to have JavaScript on in that browser.

At the end it prints your URL.

---

## Step 2 — Lock the admin side (about 10 minutes)

**Do this before you send anyone a link.** Until you do, `/admin` is open to anyone
who finds the URL.

1. Cloudflare dashboard → **Zero Trust** → **Access** → **Applications** → **Add an
   application** → **Self-hosted**.
2. Application domain: your worker's hostname. Path: `admin`.
3. Policy: **Allow**, Include → **Emails** → the organizers' addresses. (Or **Emails
   ending in** → your company domain.)
4. Save.

Leave `/r/*` and `/teams` **outside** Access — participants have no accounts, and the
projected team list has to open on a room laptop nobody has logged into.

Check it worked: open `/admin` in a private window. You should be asked to
authenticate.

---

## Step 3 — Set the event details (2 minutes)

Open `wrangler.jsonc` and set these, then run `npm run deploy`:

| Var | What happens if you leave it |
|---|---|
| `EVENT_DATE` | Participants see the wrong date on the form |
| `FORM_DEADLINE` | The form closes on the placeholder date |
| `EVENT_NAME` | Says "SECC AI Builder Day" |
| `ORGANIZER_EMAILS` | The "contact the organizers" link has no address behind it |
| `LOCAL_UTC_OFFSET_HOURS` | Reminder timing is set for UTC+8 |

---

## Step 4 — Load the people (5 minutes)

`/admin/invites` → upload a CSV with a name column and an email column, in either
order, with or without a header row. It reports exactly what it did, including every
line it skipped and why.

Then `/admin` shows you responses, attendance and — most importantly — the laptop
count, which is the number that decides whether the day works.

---

## Step 5 — Try it end to end before anyone else does (10 minutes)

1. **Participants** → find yourself → copy your personal link → fill the form in as if
   you were an attendee. Check it looks right on your phone.
2. **Grouping runs** → **Start a run**. Watch the progress. It takes a few seconds.
3. **Review teams** → drag someone between two teams and watch the warnings update.
4. **Publish teams** → open `/teams` on the actual projector you will use on the day,
   and print a page.

If all five of those work, the event is safe. Everything after this is refinement.

---

## Optional: the three secrets

None are required. Add the ones you want, then `npm run deploy`.

```bash
npx wrangler secret put ANTHROPIC_API_KEY      # better theme clustering
npx wrangler secret put RESEND_API_KEY         # sending email from the app
npx wrangler secret put TURNSTILE_SECRET_KEY   # bot check on the public form
```

**`ANTHROPIC_API_KEY`** — with it, problem statements are clustered into named themes by
reading what people actually wrote. Without it, grouping falls back to the "what would
you like to build?" answer. That fallback is a real, tested path, not a degraded mode —
it is what protects the event if the API is unreachable on the morning.

**`RESEND_API_KEY`** — needs a verified sending domain at resend.com, which is the DNS
step above. If you are short of time, skip it and hand out links from the participants
table. You can add it later without redoing anything.

**`TURNSTILE_SECRET_KEY`** — only worth it if the form URL will be publicly guessable.
For an internal event with tokenised links, skip it. If you do add it, also set
`TURNSTILE_SITE_KEY` in `wrangler.jsonc` — the widget only renders when that is present.

---

## If something goes wrong on the day

**Export CSV** from the participants page. Every answer anyone gave is in it, with the
four skill scores in four separate columns. You can group by hand in a spreadsheet and
you have lost nothing but convenience. It was built before the solver was, for exactly
this reason.

The full day-of runbook — no-shows, walk-ins, reprinting teams — is in `README.md`.
