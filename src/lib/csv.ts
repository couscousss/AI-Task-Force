/**
 * Minimal RFC 4180 CSV. Handles quoted fields, embedded commas/newlines, doubled
 * quotes, a UTF-8 BOM, and both CRLF and LF. No dependency, no streaming — invite
 * lists are a few hundred rows.
 */
export function parseCsv(input: string): string[][] {
  const text = input.replace(/^﻿/, '');
  const rows: string[][] = [];
  let row: string[] = [];
  let field = '';
  let inQuotes = false;
  let i = 0;
  let sawAnyChar = false;

  while (i < text.length) {
    const c = text[i]!;
    if (inQuotes) {
      if (c === '"') {
        if (text[i + 1] === '"') {
          field += '"';
          i += 2;
          continue;
        }
        inQuotes = false;
        i++;
        continue;
      }
      field += c;
      i++;
      continue;
    }
    if (c === '"') {
      inQuotes = true;
      sawAnyChar = true;
      i++;
      continue;
    }
    if (c === ',') {
      row.push(field);
      field = '';
      sawAnyChar = true;
      i++;
      continue;
    }
    if (c === '\r') {
      i++;
      continue;
    }
    if (c === '\n') {
      row.push(field);
      rows.push(row);
      row = [];
      field = '';
      sawAnyChar = false;
      i++;
      continue;
    }
    field += c;
    sawAnyChar = true;
    i++;
  }
  if (field !== '' || sawAnyChar || row.length > 0) {
    row.push(field);
    rows.push(row);
  }
  return rows;
}

function escapeCell(v: unknown): string {
  if (v === null || v === undefined) return '';
  const s = String(v);
  // Guard against spreadsheet formula injection — organizers open this in Excel.
  const needsGuard = /^[=+\-@\t\r]/.test(s);
  const body = needsGuard ? `'${s}` : s;
  if (/[",\r\n]/.test(body)) return `"${body.replace(/"/g, '""')}"`;
  return body;
}

export function toCsv(headers: string[], rows: unknown[][]): string {
  const lines = [headers.map(escapeCell).join(',')];
  for (const r of rows) lines.push(r.map(escapeCell).join(','));
  // BOM so Excel opens UTF-8 names correctly.
  return '﻿' + lines.join('\r\n') + '\r\n';
}
