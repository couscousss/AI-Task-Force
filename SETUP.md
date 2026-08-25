# Getting this live

## The short version

Deploy once, then send your department **one link**. That is the whole flow.

There are two ways to deploy. Pick one.

### Option A — from the browser, nothing installed (easiest)

One-time setup, all point-and-click:

1. **Cloudflare** → *My Profile* → *API Tokens* → *Create Token* → use the
   **Edit Cloudflare Workers** template, and add the **D1: Edit** permission as well.
   Copy the token.
2. **This repo on GitHub** → *Settings* → *Secrets and variables* → *Actions* →
   *New repository secret*. Add two:
   - `CLOUDFLARE_API_TOKEN` — the token you just copied
   - `CLOUDFLARE_ACCOUNT_ID` — the Account ID in your Cloudflare dashboard sidebar
3. **Actions** tab → **Deploy** → **Run workflow**.

It creates the database, applies the schema, deploys, and prints your URL in the run
summary. Every later run redeploys. You never open a terminal.

### Option B — from your own machine

Needs Node 20+ installed (`brew install node`, or the LTS installer from nodejs.org —
then open a **new** terminal window).

```bash
git clone https://github.com/couscousss/AI-Task-Force.git
cd AI-Task-Force && git checkout claude/web-application-k0lv8g
./scripts/setup.sh
```

Both routes run the same provisioning script, so they produce the same result.

Share the URL it prints. Anyone who opens it fills the form in — no invite list, no
personal links, no email needed. The rest of this file is detail you can read while it
runs.

---

## You do not need email, and you do not need an invite list

The link works for everybody. Someone's email address is their identity: if they come
back to the same link later and enter the same address, it updates their answers instead
of adding them twice.

An invite list is still worth uploading **if you want to know who has not replied yet** —
that is the one thing an open link cannot tell you. Both work together; people who were
invited and then use the open link are matched to their existing record, not duplicated.

Email is entirely optional. Every participant's personal edit link is on their row under
**Participants** and in the **CSV export**, so you can hand them out by hand if you ever
need to. Sending from your own domain needs DNS records to propagate, which is the only
step here with a delay outside your control — so leave it until last, or skip it.

---

## Step 1 — Deploy

Whichever option you picked above. Both create the database, apply the schema and deploy,
and both are safe to run again if anything fails part-way.

You do not need to set a public URL anywhere: every link the app shows is built from the
address the page was opened on, so a fresh deploy hands out correct links with no
configuration. (`PUBLIC_ORIGIN` only matters if you send email, because the reminder cron
has no request to read an address from.)

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

## Step 4 — Send the link (1 minute)

Share `https://your-worker.workers.dev` with the department. It goes straight to the
form. The same link is shown at the top of `/admin` so you can copy it from there.

**Optional:** if you also want to track who has *not* replied, upload an invite list at
`/admin/invites` — a CSV with a name column and an email column, in either order, with or
without a header row. It reports exactly what it did, including every line it skipped and
why. People who were invited and then use the open link are matched to their existing
record rather than duplicated.

`/admin` then shows responses, attendance and — most importantly — the laptop count,
which is the number that decides whether the day works.

---

## Step 5 — Try it end to end before anyone else does (10 minutes)

1. Open your own URL on your phone and fill the form in as if you were an attendee.
   Check you appear under **Participants** afterwards.
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
