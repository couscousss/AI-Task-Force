# Versions

## Since v1.0

**The shared link now remembers you.** Reported from real use: after saving, the page says
the answers can be changed any time — but the link people keep is the one the organizer
sent, and opening that again showed a blank form asking for a name and email from scratch.
Nothing was ever lost, since email is the identity and re-submitting updates the same
record, but retyping a problem statement in order to change one checkbox is a good reason
to give up half way.

Saving now drops the participant's own token in a cookie, and the shared link hands their
answers back on the next visit from that device. A different phone or computer has no
cookie, so the confirmation page also shows their personal link for that case, and the
form carries a "Not you?" link that clears the cookie for a machine two people share.

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
