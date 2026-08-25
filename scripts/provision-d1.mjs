/**
 * Find or create the D1 database and write its id into wrangler.jsonc.
 *
 * Shared by scripts/setup.sh (running on someone's laptop) and the GitHub Actions
 * deploy (running on a machine nobody owns), so the two cannot drift.
 *
 *   node scripts/provision-d1.mjs [database-name]
 *
 * Idempotent: an existing database of that name is reused rather than duplicated, and
 * re-running with the same id rewrites nothing.
 */

import { execFileSync } from 'node:child_process';
import { readFileSync, writeFileSync } from 'node:fs';

const DB_NAME = process.argv[2] ?? 'secc-builder-day';
const CONFIG = 'wrangler.jsonc';

function wrangler(args) {
  return execFileSync('npx', ['wrangler', ...args], {
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  });
}

/** Whatever wrangler actually said, so a failure is diagnosable from the log alone. */
function explain(err) {
  const parts = [err?.stderr, err?.stdout, err?.message]
    .filter((s) => typeof s === 'string' && s.trim() !== '')
    .map((s) => s.trim());
  return parts.length > 0 ? parts.join('\n') : String(err);
}

let lastError = null;

function findDatabase() {
  let raw;
  try {
    raw = wrangler(['d1', 'list', '--json']);
  } catch (err) {
    lastError = explain(err);
    return null;
  }
  // Wrangler prints banners around the JSON, so take the first array in the output.
  const match = raw.match(/\[[\s\S]*\]/);
  if (!match) return null;
  try {
    const list = JSON.parse(match[0]);
    const hit = list.find((d) => d?.name === DB_NAME);
    return hit ? (hit.uuid ?? hit.id ?? null) : null;
  } catch {
    return null;
  }
}

let id = findDatabase();

if (id) {
  console.log(`Reusing existing database ${DB_NAME} (${id})`);
} else {
  console.log(`Creating database ${DB_NAME}`);
  try {
    wrangler(['d1', 'create', DB_NAME]);
  } catch (err) {
    // A concurrent run may have created it between our list and our create, so this is
    // not fatal on its own — but keep what wrangler said in case it turns out to be.
    lastError = explain(err);
    console.log('Create did not succeed; checking whether the database exists anyway.');
  }
  id = findDatabase();
  if (!id) {
    console.error(`\nCould not create or find the D1 database "${DB_NAME}".`);
    if (lastError) {
      console.error('\nWhat wrangler said:\n');
      console.error(lastError.replace(/^/gm, '  '));
    }
    console.error(
      '\nUsual causes:\n' +
        '  · CLOUDFLARE_API_TOKEN is missing the "D1: Edit" permission\n' +
        '  · CLOUDFLARE_ACCOUNT_ID is wrong, or belongs to a different account than the token\n' +
        '  · the token was revoked or has expired\n',
    );
    process.exit(1);
  }
  console.log(`Created database ${DB_NAME} (${id})`);
}

const before = readFileSync(CONFIG, 'utf8');
const after = before.replace(/("database_id":\s*")[^"]*(")/, `$1${id}$2`);
if (after === before && !before.includes(id)) {
  console.error(`Could not find a database_id field to update in ${CONFIG}`);
  process.exit(1);
}
if (after !== before) {
  writeFileSync(CONFIG, after);
  console.log(`Wrote the database id into ${CONFIG}`);
} else {
  console.log(`${CONFIG} already had the right database id`);
}
