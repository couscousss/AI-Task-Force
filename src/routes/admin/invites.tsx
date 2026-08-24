import { Hono } from 'hono';
import type { FC } from 'hono/jsx';
import type { AppBindings } from '../../env';
import { AdminPage, Callout, Card } from '../../ui/layout';
import { ensureInvite, type InviteResult } from '../../db/participants';
import { parseCsv } from '../../lib/csv';
import { isValidEmail, normalizeEmail, squish } from '../../lib/validation';
import { originLooksSane } from '../../lib/auth';

export const inviteRoutes = new Hono<AppBindings>();

/** Comfortably larger than any real invite list; small enough that a wrong file is caught. */
const MAX_UPLOAD_BYTES = 1_000_000;
/** One D1 round trip or two per row, so refuse a list that would time the request out. */
const MAX_ROWS = 600;

/* ------------------------------------------------------------------ parsing */

interface Candidate {
  line: number;
  name: string | null;
  email: string | null;
  raw: string;
}

function isBlank(row: string[]): boolean {
  return row.every((cell) => cell.trim() === '');
}

/**
 * Accepts a header row naming the columns in any order and any case, or a headerless
 * file where we work out which column holds the email by looking for the "@".
 */
function extractCandidates(rows: string[][]): Candidate[] {
  let headerLine = -1;
  let emailIdx = -1;
  let nameIdx = -1;

  for (let i = 0; i < rows.length; i++) {
    const row = rows[i]!;
    if (isBlank(row)) continue;
    // A header never contains an address, which keeps "ada@gmail.com" from looking
    // like a column called "mail".
    if (!row.some((cell) => cell.includes('@'))) {
      const cells = row.map((cell) => cell.trim().toLowerCase());
      const e = cells.findIndex((cell) => cell.includes('mail'));
      const n = cells.findIndex((cell, idx) => idx !== e && cell.includes('name'));
      if (e >= 0 || n >= 0) {
        headerLine = i;
        emailIdx = e;
        nameIdx = n;
      }
    }
    break; // only the first non-blank row can be the header
  }

  const out: Candidate[] = [];
  for (let i = 0; i < rows.length; i++) {
    if (i === headerLine) continue;
    const row = rows[i]!;
    if (isBlank(row)) continue;
    const raw = row.map((cell) => cell.trim()).filter((cell) => cell !== '').join(', ');

    let email: string | null = null;
    let name: string | null = null;

    if (emailIdx >= 0) {
      email = (row[emailIdx] ?? '').trim() || null;
      name = nameIdx >= 0 ? (row[nameIdx] ?? '').trim() || null : null;
    } else {
      const at = row.findIndex((cell) => cell.includes('@'));
      if (at >= 0) {
        email = (row[at] ?? '').trim() || null;
        const other = nameIdx >= 0 && nameIdx !== at
          ? nameIdx
          : row.findIndex((cell, idx) => idx !== at && cell.trim() !== '');
        name = other >= 0 ? (row[other] ?? '').trim() || null : null;
      } else {
        // No "@" anywhere: assume "name, email" order and let validation report it.
        email = (row[1] ?? row[0] ?? '').trim() || null;
        name = row.length > 1 ? (row[0] ?? '').trim() || null : null;
      }
    }
    out.push({ line: i + 1, name, email, raw });
  }
  return out;
}

async function applyCandidates(db: D1Database, candidates: Candidate[]): Promise<InviteResult> {
  const result: InviteResult = { added: 0, existed: 0, skipped: [] };
  const seen = new Map<string, number>();

  for (const cand of candidates) {
    if (!cand.email) {
      result.skipped.push({ line: cand.line, value: cand.raw, reason: 'no email address in this row' });
      continue;
    }
    if (!isValidEmail(cand.email)) {
      result.skipped.push({ line: cand.line, value: cand.email, reason: 'not a valid email address' });
      continue;
    }
    const email = normalizeEmail(cand.email);
    const first = seen.get(email);
    if (first !== undefined) {
      result.skipped.push({
        line: cand.line,
        value: email,
        reason: `the same email is already on line ${first} of this file`,
      });
      continue;
    }
    seen.set(email, cand.line);
    const { created } = await ensureInvite(db, { name: squish(cand.name) || null, email });
    if (created) result.added++;
    else result.existed++;
  }
  return result;
}

function summarySentence(r: InviteResult): string {
  const base = `${r.added} added, ${r.existed} already existed, ${r.skipped.length} skipped`;
  const only = r.skipped.length === 1 ? r.skipped[0] : undefined;
  return only ? `${base} (${only.reason} on line ${only.line}).` : `${base}.`;
}

/* ------------------------------------------------------------------ page */

const UploadPage: FC<{
  email: string;
  error?: string;
  result?: InviteResult;
}> = ({ email, error, result }) => (
  <AdminPage
    title="Invite list"
    active="invites"
    email={email}
    heading="Invite list"
    lede="Everyone you upload here gets a record and their own unguessable link. Uploading the same list twice is safe — existing people are left alone."
    actions={
      <a class="btn btn-secondary" href="/admin/participants">
        See all participants
      </a>
    }
  >
    {error ? (
      <Callout tone="bad" title="Nothing was uploaded">
        {error}
      </Callout>
    ) : null}

    {result ? (
      <>
        <Callout
          tone={result.skipped.length > 0 ? 'warn' : 'good'}
          title={result.skipped.length > 0 ? 'Uploaded, with skips' : 'Invite list updated'}
        >
          {summarySentence(result)}
        </Callout>
        {result.skipped.length > 0 ? (
          <Card
            title={`${result.skipped.length} rows skipped`}
            sub="Fix these in your file and upload it again, or add them one at a time as walk-ins. Nothing else was affected."
          >
            <div class="table-scroll">
              <table>
                <thead>
                  <tr>
                    <th scope="col" class="num">
                      Line
                    </th>
                    <th scope="col">What was in the file</th>
                    <th scope="col">Why it was skipped</th>
                  </tr>
                </thead>
                <tbody>
                  {result.skipped.map((s) => (
                    <tr>
                      <td class="num">{s.line}</td>
                      <td class="mono">{s.value || '(empty)'}</td>
                      <td>{s.reason}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </Card>
        ) : null}
        {result.added > 0 ? (
          <Card>
            <p>
              Next: send them their personal links from <a href="/admin/email">Email</a>, or copy an
              individual link from <a href="/admin/participants">Participants</a>.
            </p>
          </Card>
        ) : null}
      </>
    ) : null}

    <Card title={result ? 'Upload another list' : 'Upload a CSV'}>
      <p class="hint">
        A header row with a <span class="mono">name</span> and an <span class="mono">email</span>{' '}
        column, in any order and any capitalisation. A two-column file with no header works too —
        whichever column has the <span class="mono">@</span> is treated as the email. Blank lines are
        ignored.
      </p>
      <form method="post" action="/admin/invites" enctype="multipart/form-data">
        <div class="field">
          <label for="file">CSV file</label>
          <p class="hint">Up to 1 MB, which is thousands of rows more than you will need.</p>
          <input type="file" id="file" name="file" accept=".csv,.txt,text/csv,text/plain" />
        </div>
        <div class="field">
          <label for="pasted">Or paste the rows</label>
          <p class="hint">
            One person per line, name then email separated by a comma. Used only when no file is
            chosen.
          </p>
          <textarea id="pasted" name="pasted" rows={6} placeholder="Ada Lovelace, ada@example.org">
            {'\n'}
          </textarea>
        </div>
        <div class="btn-row">
          <button class="btn" type="submit">
            Add to invite list
          </button>
        </div>
      </form>
    </Card>
  </AdminPage>
);

inviteRoutes.get('/', (c) => c.html(<UploadPage email={c.get('adminEmail')} />));

inviteRoutes.post('/', async (c) => {
  if (!originLooksSane(c)) {
    return c.text('That request did not come from this site. Reload the page and try again.', 403);
  }
  const email = c.get('adminEmail');
  const body = (await c.req.parseBody()) as Record<string, unknown>;
  const file = body['file'];
  const pasted = typeof body['pasted'] === 'string' ? body['pasted'] : '';

  let text = '';
  if (file instanceof File && file.size > 0) {
    if (file.size > MAX_UPLOAD_BYTES) {
      const mb = (file.size / 1_000_000).toFixed(1);
      return c.html(
        <UploadPage
          email={email}
          error={`That file is ${mb} MB. An invite list of names and emails is a few kilobytes — check you picked the right file, or paste the rows into the box instead.`}
        />,
        400,
      );
    }
    text = await file.text();
  } else if (pasted.trim() !== '') {
    if (pasted.length > MAX_UPLOAD_BYTES) {
      return c.html(
        <UploadPage
          email={email}
          error="That is more text than the box can take. Save it as a CSV file and upload the file instead."
        />,
        400,
      );
    }
    text = pasted;
  } else {
    return c.html(
      <UploadPage
        email={email}
        error="No file was chosen and the paste box was empty. Pick a CSV file, or paste one person per line as name, email."
      />,
      400,
    );
  }

  const candidates = extractCandidates(parseCsv(text));
  if (candidates.length === 0) {
    return c.html(
      <UploadPage
        email={email}
        error="No rows were found. Each line needs a name and an email address, separated by a comma."
      />,
      400,
    );
  }
  if (candidates.length > MAX_ROWS) {
    return c.html(
      <UploadPage
        email={email}
        error={`That file has ${candidates.length} rows and this tool handles ${MAX_ROWS} at a time. Split it into two files and upload them one after the other.`}
      />,
      400,
    );
  }

  const result = await applyCandidates(c.env.DB, candidates);
  return c.html(<UploadPage email={email} result={result} />);
});
