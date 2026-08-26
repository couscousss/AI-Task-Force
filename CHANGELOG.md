# Versions

## v3.0 — 26 August 2026

**Cluster is a dropdown of the seven real clusters:** Air Ops C3, Embedded Teams / C3
CentEx, HQ, Maritime Ops, Smart Camps & Bases, WOG Ops C3, NSI.

Not only a nicer control. The solver compares this value for equality when it spreads
people across clusters, so free text meant "HQ", "hq" and "H.Q." counted as three different
clusters and the mixing degraded with nothing looking wrong. Enforced server-side as well as
in the control, because a form post can carry anything.

A value stored while the field was free text is not offered back on the participant form —
it would be rejected on save, so offering it would be a trap. The admin screen does show it,
marked "(not one of the clusters)", so editing an unrelated field cannot quietly discard a
walk-in's entry.

### Known defect at this version — not fixed

An adversarial review of "what breaks when a hundred colleagues use this" ran against v2.0
and found two paths where **one person's save silently and permanently destroys another
person's answers**. Both were confirmed by reproduction, not just by reading:

> Alice fills the form in — `Alice Tan | Finance | "month end close takes four days…"`
> Bob, in a different browser with no cookie, submits with Alice's email address.
> Alice's row becomes — `Bob Lim | Marketing | "we spend hours writing social posts…"`

Alice's name, cluster and problem statement are gone. No warning to either of them, and
nothing in the organizer dashboard shows it happened. `POST /join` calls `validateSubmission`
with `current: null`, so the duplicate-email refusal never runs; `ensureInvite` returns the
existing row and every column is overwritten, blanks included. The submitter is then handed
that person's token in a 120-day cookie.

The second path is the same damage from a shared browser: person B is redirected into person
A's remembered record, types over it, and A's email column is rewritten — leaving no row for
A at all while A's team seat shows B.

Triggered by an ordinary typo, an autofill onto a real colleague's address, or somebody
filling the form in on behalf of a colleague who already did. At a hundred people this is
likely rather than exotic. **The link should not go out until both are fixed.**

Also outstanding, lower stakes: `ORGANIZER_EMAILS` is empty, so every "Something wrong?
Contact the organizers" line has no address behind it; several pages point at an email that
cannot be sent while `RESEND_API_KEY` is unset; the broken-link 404 offers no way back to the
form; and publishing teams has no unpublish route, though `unpublishAll` exists in the code.

### So what "it works" means here

Everything a participant does on the happy path works, and has been verified on a running
Worker. The defect above is real, confirmed, and unfixed at this commit. v3.0 is a safe place
to return to for the form's *content* — it is not a version to send to a department.

```bash
git checkout v3.0
```

## v2.0 — 26 August 2026

**Ready to send to the department.** v1.0 worked; this is v1.0 after a round of real use,
the organizer's own wording, and two defects that only appear at a hundred people.

### The shared link remembers you

Reported from real use, and the most important fix here. After saving, the page said the
answers could be changed any time — but the link people keep is the one the organizer sent,
and opening that again showed a blank form asking for a name and email from scratch. Nothing
was ever lost, since email is the identity and re-submitting updates the same record, but
retyping a problem statement in order to change one checkbox is a good reason to give up
half way.

Saving now drops the participant's own token in a cookie, and the shared link hands their
answers back on the next visit from that device. A different phone or computer has no
cookie, so the confirmation page also shows their personal link for that case, and the form
carries a "Not you?" link that clears the cookie for a machine two people share.

### Two things that only break at scale

**A double-tapped Save returned a 500.** Looking the email up and inserting are two round
trips, so two requests carrying the same address could both find nothing and both try to
insert. `email` is UNIQUE, so the second lost — correctly — but the throw was unhandled and
rendered "Something went wrong" over an answer that had saved perfectly well. One person on
a slow phone tapping twice is not exotic at a hundred people. Proven fixed by firing six
simultaneous submissions of the same new address: six successes, one row.

**The form promised an email nobody could send.** The confirmation page said "We will email
you your team and your project". Sending mail is an optional secret that is not configured,
and even configured the organizer chooses when to send — so the app was promising something
only a human could deliver, to everybody who filled the form in. It now says they will get
their team and project before the day, without naming a channel.

### The organizer's wording

The eight areas replaced the starter list, as a dropdown carrying a short description each.
Five of the eight kept the machine keys they shipped with, so answers given before the
change still resolve to the right area; only `workflows`, `comms` and `opportunity` are new.
"A user-facing tool" was withdrawn but stays label-resolvable, so an answer already saved
against it still reads as a sentence rather than printing `product` into the CSV.

Also: a welcome heading, plainer cluster and email fields, "Your Name" and "Your Email",
the event named in the hopes question, and a colophon at the foot of every page.

### Honestly, at the time of tagging

A four-lens adversarial review of "what breaks when a hundred colleagues use this" was still
running when this was marked. Ten findings had survived refutation and eight had been
killed; none had been triaged yet. So v2.0 is "works, and everything found so far is fixed",
not "reviewed clean". Anything that review turns up lands after this point.

Still unexercised, as at v1.0: the live Anthropic clustering call, Resend delivery,
Turnstile, and the cron firing. None is required for the event.

### Getting back to this version

Same as v1.0 — a branch called `v2.0` on GitHub holds the commit. Pushing tags is refused by
this clone's credentials, so branches are the marker that survives.

```bash
git checkout v2.0
```

## v1.0 — 25 August 2026

**The known-good release.** Everything works end to end and it is deployed. If a later
change goes wrong, this is the point to come back to.

Live at the time of tagging:

| | |
|---|---|
| Participant form | `https://builderday.secc.workers.dev` |
| Published teams | `https://builderday.secc.workers.dev/teams` |
| Organizer dashboard | `https://builderday-admin.secc.workers.dev` |

### What is in it

**One open link for the whole department.** No invite list required, no per-person URLs to
distribute. Email address is the identity: someone returning to the same link and entering
the same address updates their answers instead of creating a second record. An invite list
can still be uploaded if you want to know who has *not* replied — that is the one thing an
open link cannot tell you.

**Organizer screens on a separate Worker, behind Cloudflare Access.** The two Workers share
one D1 database, so there is one copy of the data. The split exists because Access attaches
to a Worker or to a domain you own, and a `workers.dev` URL is neither — so protecting
`/admin` alone is not possible on this hostname. The app itself contains no authentication
code; Cloudflare does all of it.

**CSV export that works on its own.** Every answer, with the four skill scores in four
separate columns. Built before the grouping engine and independent of it, so a bad run on
the morning of the event costs convenience, not the day.

**Deterministic team building.** Same input and seed produce byte-identical teams. The
balancing runs in the organizer's browser because it needs more than the 10ms of CPU the
free Cloudflare plan allows per request — the same code, same seed, and the score was
measured matching the server to six decimal places. The model clusters problem statements
and writes team names; it never assigns anybody to a team.

**Unsatisfiable pools are reported, not fudged.** If the room cannot satisfy a constraint,
the run says so in a sentence with real numbers rather than quietly relaxing it.

### The three rules this build holds to

1. The four skill scores are never summed into one number as a solver input.
2. The model does not assign teams. Every constraint is deterministic code.
3. CSV export works before, and independently of, the grouping engine.

### Verified before tagging

10 deploys, all green · 69 tests passing · typecheck clean on both Workers ·
149 participants → 37 teams in 133ms, zero violations · a 100-person run end to end ·
browser and server solves producing identical scores · Access confirmed by reading the
policy back from Cloudflare.

### Getting back to this version

Two markers point at the same commit, `a503fe4`:

- **A branch called `v1.0` on GitHub.** Nothing is pushed to it, so it stays where it is.
- **An annotated git tag `v1.0`**, which exists only in the working clone. Pushing tags was
  refused by the credentials available at the time, so the branch is what survives on
  GitHub. To turn it into a real tag, open
  [Releases → new](https://github.com/couscousss/AI-Task-Force/releases/new), type `v1.0`,
  choose *Create new tag on publish*, target the `v1.0` branch, and publish. Nothing breaks
  if you never do — the branch already does the job.

```bash
git checkout v1.0          # look at exactly this code
git checkout -b fix v1.0   # start again from here
```

To redeploy this version, push commit `a503fe4` to the working branch — the Deploy workflow
runs on every push and takes about 40 seconds.

### Not exercised at v1.0

These need credentials that were not available while building, so the wiring is untested
even though the logic behind it is: the live Anthropic clustering call (only the offline
fallback has run), Resend email delivery, Turnstile verification, and the scheduler firing
the reminder cron. None of them is required for the event to work.
