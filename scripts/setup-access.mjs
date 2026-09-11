/**
 * Put Cloudflare Access in front of the admin Worker, from a script instead of the
 * dashboard.
 *
 *   node scripts/setup-access.mjs "you@work.com, someone@work.com, @yourcompany.com"
 *
 * Reads CLOUDFLARE_API_TOKEN and CLOUDFLARE_ACCOUNT_ID from the environment, the same two
 * the deploy uses. Emails may also come from ADMIN_EMAILS.
 *
 * Idempotent: re-running finds the application it made last time and updates it rather
 * than stacking duplicates, so it is safe to run again after adding an organizer.
 *
 * Why this exists at all: production Access cannot be declared in wrangler.jsonc. The
 * `access` key in that file has exactly one sub-key, `dev`, and it only simulates an
 * identity for `wrangler dev` — `wrangler deploy` never calls the Access API. So the
 * choice is the dashboard or this.
 *
 * ONE THING THIS SCRIPT CANNOT ALWAYS DO. Access applications hang off a Zero Trust
 * organization, and Cloudflare's own guidance is to create that through dashboard
 * onboarding — there is a plan-selection step in the way, even on the Free plan. The
 * create endpoint exists and is tried here, but if Cloudflare refuses, that is expected
 * rather than a bug, and the message below says exactly which two-minute dashboard step
 * unblocks it. Everything after that point is automated.
 */

const API = 'https://api.cloudflare.com/client/v4';

const TOKEN = process.env['CLOUDFLARE_API_TOKEN'];
const ACCOUNT = process.env['CLOUDFLARE_ACCOUNT_ID'];
const WORKER_NAME = process.env['ADMIN_WORKER_NAME'] ?? 'builderday-admin';
const APP_NAME = 'SECC Builder Day — organizer dashboard';
const POLICY_NAME = 'Organizers';
// Only used if the account has no Zero Trust organization yet. Must be globally unique
// across all of Cloudflare, so it is overridable when the obvious name is taken.
const TEAM_NAME = process.env['ZT_TEAM_NAME'] ?? 'secc-builder-day';

function die(message, detail) {
  console.error(`\n✕ ${message}\n`);
  if (detail) console.error(String(detail).replace(/^/gm, '  ') + '\n');
  process.exit(1);
}

if (!TOKEN) die('CLOUDFLARE_API_TOKEN is not set.');
if (!ACCOUNT) die('CLOUDFLARE_ACCOUNT_ID is not set.');

/** Turn Cloudflare's error array into something a human can act on. */
function describe(body, res) {
  const errors = Array.isArray(body?.errors) ? body.errors : [];
  if (errors.length === 0) return `HTTP ${res.status}`;
  return errors.map((e) => `[${e.code ?? '?'}] ${e.message ?? JSON.stringify(e)}`).join('\n');
}

function errorCodes(body) {
  return (body?.errors ?? []).map((e) => e.code);
}

function errorText(body) {
  return (body?.errors ?? []).map((e) => String(e.message ?? '')).join(' ').toLowerCase();
}

/** True when a failure is the token lacking a permission rather than a real problem. */
function looksLikePermissions(body, res) {
  if (res.status === 403) return true;
  const codes = errorCodes(body);
  // 10000 authentication error, 9109 unauthorized to access requested resource.
  return codes.includes(10000) || codes.includes(9109);
}

/**
 * True when Cloudflare is saying "this account has never turned Zero Trust on".
 * Matched loosely on purpose: the code for this has moved around, so the wording is the
 * more durable signal, and getting it wrong only changes which help text is printed.
 */
function looksLikeAccessNotEnabled(body) {
  const text = errorText(body);
  return text.includes('not_enabled') || text.includes('access is not enabled') || text.includes('not enabled');
}

const PERMISSION_HELP = `
The API token is missing a permission. Add it to the SAME token — editing a token does
not change its secret, so nothing needs re-pasting into GitHub:

  https://dash.cloudflare.com/profile/api-tokens
  -> your token -> Edit -> Permissions -> + Add more

  Account | Access: Apps and Policies                         | Edit
  Account | Access: Organizations, Identity Providers, Groups | Edit

The first dropdown must say Account, not Zone. Cloudflare has two different permissions
with the same display name and the Zone one does not work for this.
`;

const ONBOARDING_HELP = `
Zero Trust has never been switched on for this Cloudflare account, and Cloudflare will
not let a script switch it on for the first time — there is a plan-selection step in the
way. This is a one-off, and it is the ONLY dashboard step in this whole setup:

  1. https://one.dash.cloudflare.com
  2. Choose a team name (anything short — "secc" is fine). Write it down.
  3. Choose the FREE plan. It may still ask for card details; the Free plan is not
     charged, and this app only ever has a handful of organizer sign-ins.

Then re-run this workflow. It will find the organization and do everything else itself.
`;

async function cf(method, path, body) {
  let res;
  try {
    res = await fetch(`${API}${path}`, {
      method,
      headers: {
        Authorization: `Bearer ${TOKEN}`,
        'Content-Type': 'application/json',
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
  } catch (err) {
    // A raw fetch stack trace here would be the least useful thing to print, since the
    // one person who sees it is reading a CI log to find out what to click next.
    die(
      `Could not reach the Cloudflare API (${method} ${path}).`,
      `${err?.message ?? err}\n\n` +
        'Nothing was changed. If this is a transient network failure, run the workflow\n' +
        'again; the script is safe to repeat.',
    );
  }

  let parsed = null;
  const text = await res.text();
  try {
    parsed = text ? JSON.parse(text) : null;
  } catch {
    /* fall through to the raw text below */
  }

  return { ok: res.ok && parsed?.success !== false, status: res.status, body: parsed, text, res };
}

/** A call whose failure should stop everything. */
async function must(method, path, body, what) {
  const r = await cf(method, path, body);
  if (!r.ok) {
    if (looksLikeAccessNotEnabled(r.body)) {
      die(`Could not ${what} — Zero Trust is not enabled on this account.`, ONBOARDING_HELP);
    }
    if (looksLikePermissions(r.body, r.res)) {
      die(`Could not ${what} — the token is not allowed to.`, describe(r.body, r.res) + '\n' + PERMISSION_HELP);
    }
    die(`Could not ${what}.`, describe(r.body, r.res) || r.text);
  }
  return r.body?.result;
}

// ---------------------------------------------------------------------------
// 1. The Zero Trust organization. Access applications hang off it, and an account does
//    not get one automatically — this is what the dashboard calls "pick a team name".
// ---------------------------------------------------------------------------

async function ensureOrganization() {
  const probe = await cf('GET', `/accounts/${ACCOUNT}/access/organizations`);

  if (probe.ok && probe.body?.result?.auth_domain) {
    const domain = probe.body.result.auth_domain;
    console.log(`✓ Zero Trust is already set up on this account (${domain})`);
    return domain;
  }

  if (!probe.ok && looksLikePermissions(probe.body, probe.res)) {
    die(
      'Could not read the Zero Trust organization — the token is not allowed to.',
      describe(probe.body, probe.res) + '\n' + PERMISSION_HELP,
    );
  }

  if (!probe.ok && looksLikeAccessNotEnabled(probe.body)) {
    die('Zero Trust is not enabled on this Cloudflare account.', ONBOARDING_HELP);
  }

  // No organization, and nothing that says the account is barred from having one. The
  // create endpoint is documented, so it is worth one attempt — but Cloudflare's own
  // guidance is that onboarding happens in the dashboard, so a refusal here is a normal
  // outcome and not a defect.
  const authDomain = `${TEAM_NAME}.cloudflareaccess.com`;
  console.log(`· No Zero Trust organization found; trying to create one as ${authDomain}`);

  const created = await cf('POST', `/accounts/${ACCOUNT}/access/organizations`, {
    name: 'SECC Builder Day',
    auth_domain: authDomain,
  });

  if (created.ok && created.body?.result?.auth_domain) {
    console.log(`✓ Created the Zero Trust organization (${created.body.result.auth_domain})`);
    return created.body.result.auth_domain;
  }

  const detail = describe(created.body, created.res);
  const taken = errorText(created.body).includes('taken') || errorText(created.body).includes('already');

  die(
    'Zero Trust is not set up on this account yet, and it could not be set up from here.',
    (taken
      ? `The team name "${TEAM_NAME}" appears to be taken. Pick another and re-run —\n` +
        `there is a "team_name" box on the workflow's Run workflow form.\n\n`
      : '') +
      `What Cloudflare said:\n${detail.replace(/^/gm, '  ')}\n` +
      ONBOARDING_HELP,
  );
}

// ---------------------------------------------------------------------------
// 2. The Worker's immutable id. NOT the script name: the Access API wants the 32-char
//    hex id, and the older /workers/scripts list returns the name in its `id` field,
//    which would silently produce an application that protects nothing.
// ---------------------------------------------------------------------------

async function findWorkerId() {
  const r = await cf('GET', `/accounts/${ACCOUNT}/workers/workers`);

  if (!r.ok) {
    if (looksLikePermissions(r.body, r.res)) {
      die('Could not list Workers — the token is not allowed to.', describe(r.body, r.res) + '\n' + PERMISSION_HELP);
    }
    die(
      'Could not list Workers to find the admin one.',
      describe(r.body, r.res) +
        '\n\nThis uses the newer /workers/workers endpoint, which is the one that returns\n' +
        'the immutable Worker id that Access needs.',
    );
  }

  const list = Array.isArray(r.body?.result) ? r.body.result : [];
  const hit = list.find((w) => w?.name === WORKER_NAME);

  if (!hit) {
    const names = list.map((w) => w?.name).filter(Boolean);
    die(
      `No Worker called "${WORKER_NAME}" on this account.`,
      names.length
        ? `Workers found:\n${names.map((n) => `  · ${n}`).join('\n')}\n\nDeploy first, or set ADMIN_WORKER_NAME.`
        : 'No Workers at all on this account — deploy before running this.',
    );
  }

  if (!hit.id || hit.id === hit.name) {
    die(
      `The API returned "${hit.id}" as the id for ${WORKER_NAME}, which is its name rather than its immutable id.`,
      'Access would attach to nothing. Stopping rather than reporting a false success.',
    );
  }

  console.log(`✓ Found the admin Worker (${WORKER_NAME} -> ${hit.id})`);
  return hit.id;
}

// ---------------------------------------------------------------------------
// 3. Who gets in. A bare @domain entry admits everyone with an address there, which is
//    how a whole team gets in without listing them one by one.
// ---------------------------------------------------------------------------

function parseAudience(raw) {
  const parts = String(raw ?? '')
    .split(/[,;\s]+/)
    .map((s) => s.trim().toLowerCase())
    .filter(Boolean);

  const include = [];
  const described = [];

  for (const part of parts) {
    if (part.startsWith('@')) {
      const domain = part.slice(1);
      if (!domain.includes('.')) die(`"${part}" does not look like a domain.`);
      include.push({ email_domain: { domain } });
      described.push(`anyone with an address ending @${domain}`);
    } else if (part.includes('@') && part.includes('.')) {
      include.push({ email: { email: part } });
      described.push(part);
    } else {
      die(
        `"${part}" is neither an email address nor a @domain.`,
        'Pass addresses separated by commas. Use @example.com to admit a whole domain.',
      );
    }
  }

  if (include.length === 0) {
    die(
      'No organizer emails given, so nobody would be able to get in.',
      'Pass them as an argument or set ADMIN_EMAILS:\n' +
        '  node scripts/setup-access.mjs "you@work.com, @yourcompany.com"',
    );
  }

  return { include, described };
}

// ---------------------------------------------------------------------------
// 4. The application itself. The policy goes inline in the same call, which is the shape
//    Cloudflare documents for Worker-targeted applications.
// ---------------------------------------------------------------------------

function targetsWorker(app, workerId) {
  const dests = Array.isArray(app?.destinations) ? app.destinations : [];
  return dests.some((d) => d?.type === 'worker' && d?.worker_id === workerId);
}

async function ensureApplication(workerId, include) {
  const listed = await must('GET', `/accounts/${ACCOUNT}/access/apps`, undefined, 'list Access applications');
  const apps = Array.isArray(listed) ? listed : [];

  const existing = apps.find((a) => targetsWorker(a, workerId)) ?? apps.find((a) => a?.name === APP_NAME);

  const payload = {
    name: APP_NAME,
    type: 'self_hosted',
    destinations: [{ type: 'worker', worker_id: workerId }],
    session_duration: '24h',
    app_launcher_visible: false,
    policies: [{ name: POLICY_NAME, decision: 'allow', include }],
  };

  if (existing?.id) {
    console.log('· An application for this Worker already exists; updating it in place');
    const updated = await must(
      'PUT',
      `/accounts/${ACCOUNT}/access/apps/${existing.id}`,
      payload,
      'update the Access application',
    );
    return updated ?? existing;
  }

  return await must('POST', `/accounts/${ACCOUNT}/access/apps`, payload, 'create the Access application');
}

/**
 * Read back what is actually in place. The whole point of this script is that the person
 * running it cannot easily check the dashboard, so "the API returned 200" is not enough —
 * a wrong destination or a missing policy has to be caught here rather than discovered
 * when someone finds the dashboard wide open.
 */
async function verify(appId, workerId) {
  const app = await must('GET', `/accounts/${ACCOUNT}/access/apps/${appId}`, undefined, 'read the application back');

  if (!targetsWorker(app, workerId)) {
    die(
      'The application was saved but is not attached to the admin Worker.',
      `destinations: ${JSON.stringify(app?.destinations ?? [], null, 2)}\n\n` +
        'The admin Worker is still unprotected. Do not share its URL.',
    );
  }

  // Prefer the policies carried on the application itself. The separate policies
  // endpoint has shifted between legacy and reusable policies, so it is a fallback
  // rather than the source of truth.
  let policies = Array.isArray(app?.policies) ? app.policies : [];

  if (policies.length === 0) {
    const sub = await cf('GET', `/accounts/${ACCOUNT}/access/apps/${appId}/policies`);
    if (sub.ok && Array.isArray(sub.body?.result)) policies = sub.body.result;
  }

  const allow = policies.filter((p) => p?.decision === 'allow');

  if (allow.length === 0) {
    die(
      'The application exists but no Allow policy could be confirmed on it.',
      'An Access application with no Allow policy refuses everyone, so nothing is exposed —\n' +
        'but you would not be able to get in either. Re-run with the organizer emails.\n\n' +
        `What came back:\n${JSON.stringify(app?.policies ?? [], null, 2)}`,
    );
  }

  return { app, policies };
}

// ---------------------------------------------------------------------------

const raw = process.argv.slice(2).join(' ') || process.env['ADMIN_EMAILS'] || '';
const { include, described } = parseAudience(raw);

console.log(`\nPutting Cloudflare Access in front of ${WORKER_NAME}\n`);

const authDomain = await ensureOrganization();
const workerId = await findWorkerId();
const app = await ensureApplication(workerId, include);

if (!app?.id) die('Cloudflare accepted the application but did not return its id, so it cannot be verified.');

const { policies } = await verify(app.id, workerId);

console.log('\n✓ Access is on, and verified by reading it back\n');
console.log(`  Application : ${app.name}`);
console.log(`  Protecting  : the ${WORKER_NAME} Worker, all of it`);
console.log(`  Sign-in at  : ${authDomain}`);
console.log(`  Policies    : ${policies.length}`);
console.log('\n  Who can get in:');
for (const d of described) console.log(`    · ${d}`);
console.log(
  '\nOpen the admin URL. Cloudflare emails you a one-time code, you paste it, you are in.\n' +
    'The participant form is a different Worker and is untouched — it stays open.\n',
);
