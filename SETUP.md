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
summary. You never open a terminal.

After that first run it is automatic: **every push to the working branch deploys itself**,
so a change is live a couple of minutes after it is made. The typecheck and the solver
tests run first, so a broken push stops before it reaches the Worker. The Run workflow
button stays available for when you change a secret or a var in the Cloudflare dashboard
and need a redeploy without a code change.

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

## Step 2 — Lock the organizer side

This deploys **two Workers**:

| Worker | What it serves | Who can reach it |
|---|---|---|
| `builderday` | the form and the published team list | everyone — this is the link you share |
| `builderday-admin` | every organizer screen | only you, once Access is on |

They are separate for one reason. Cloudflare Access attaches to a Worker or to a domain
you own; a `workers.dev` URL is neither, so it cannot be protected by path. Protecting
`/admin` without also putting the participant form behind a login therefore means two
Workers. They share one database, so there is one copy of the data.

**Turn Access on — from a workflow, not by hand:**

1. Add two permissions to the API token you already made. Editing a token does **not**
   change its secret, so nothing needs re-pasting into GitHub.

   [dash.cloudflare.com/profile/api-tokens](https://dash.cloudflare.com/profile/api-tokens)
   → your token → **Edit** → **Permissions** → **+ Add more**:

   | | | |
   |---|---|---|
   | Account | Access: Apps and Policies | Edit |
   | Account | Access: Organizations, Identity Providers, Groups | Edit |

   The first dropdown must say **Account**, not Zone — Cloudflare has two different
   permissions with the same display name, and the Zone one does not work here.

2. **Actions** → **Protect the admin dashboard** → **Run workflow**. Type in who should
   get in (commas between addresses; `@yourcompany.com` admits a whole domain).

Open the admin URL. You get a one-time code by email, and you are in.

The workflow reads the result back from Cloudflare afterwards and fails loudly if the
application is not actually attached to the Worker, or if no Allow policy landed — so a
green run means it is genuinely protected, not just that the API returned 200. It is safe
to run again whenever the organizer list changes.

**One thing the script may not be able to do for you.** Access applications hang off a
Zero Trust *organization*, and Cloudflare wants that created through dashboard onboarding
the first time — there is a plan-selection step in the way. The script tries anyway, and
if Cloudflare refuses it prints the exact two-minute fix: open
[one.dash.cloudflare.com](https://one.dash.cloudflare.com), pick a team name, choose the
**Free** plan, re-run the workflow. That is the only dashboard step in this whole setup,
and it happens once.

**Do not put Access on the public Worker.** The form and the team list have to stay open —
participants have no accounts, and the projected team list opens on a room laptop nobody
has logged into.

Until Access is on, the admin Worker refuses every request. That is deliberate: an
unprotected deployment fails shut rather than open.

## Step 3 — Set the event details (2 minutes)

Open `wrangler.jsonc` and set these, then run `npm run deploy`:

| Var | What happens if you leave it |
|---|---|
| `EVENT_DATE` | Participants see the wrong date on the form |
| `FORM_DEADLINE` | The form closes on the placeholder date |
| `EVENT_NAME` | Says "SECC Inaugural AI Builder's Day" |
| `ORGANIZER_EMAILS` | The "contact the organizers" link has no address behind it |
| `LOCAL_UTC_OFFSET_HOURS` | Reminder timing is set for UTC+8 |

---

## Step 4 — Send the link (1 minute)

Share `https://your-worker.workers.dev` with the department. It goes straight to the
form. The same link is shown at the top of `/admin` so you can copy it from there.

### Making that link look right

The address is assembled from three parts:

```
builderday  .  your-account  .  workers.dev
└ Worker ──┘   └ account ───┘   └ Cloudflare's ┘
  wrangler.jsonc  dashboard,      fixed unless you
  "name"          once only       own a domain
```

The **Worker name** is the `name` field in `wrangler.jsonc` (and `wrangler.admin.jsonc`),
changeable any time — push, and the deploy picks it up.

The **account subdomain** is set in the Cloudflare dashboard under *Workers & Pages* →
**Change** next to *Your subdomain*. In practice you get **one** change: a second attempt
usually returns "Account already has an associated subdomain". Pick the one you want to
keep, and remember it appears in a link your whole department will see.

Two things to know after either rename:

- **The old Worker keeps running.** Renaming deploys a new one and leaves the previous
  one serving the old code at the old address. It writes to the same database, so
  nothing is lost or duplicated — but delete it from the dashboard so there is only one
  live link.
- **Access is attached to a Worker, not a hostname.** Changing the account subdomain
  keeps it; renaming the *Worker* creates a new one that Access does not cover, so re-run
  the **Protect the admin dashboard** workflow afterwards. Until you do, the new admin
  Worker refuses every request rather than opening up — it fails shut.

To drop `.workers.dev` entirely you need a domain of your own. That is also what would
let Access be scoped to `/admin` on a single Worker, collapsing these two back into one.

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
