#!/usr/bin/env node
/**
 * Generates `src/api/registry/tokenDerived.generated.ts` from `data/kpostID_attribute_usages.xlsx`.
 *
 * ## What the spreadsheet is
 *
 * A search of the backend source for `(String) request.getAttribute("kpostID")` — the line a
 * KPOST controller uses to take the caller's identity from the verified bearer token and write
 * it onto the request DTO, discarding whatever the client sent. The workbook lists every live
 * occurrence (346 across 25 controllers) plus a second tab of commented-out ones, which are
 * excluded here because they never execute.
 *
 * ## Why the bench needs it
 *
 * On those routes an identity field in the payload is *decorative*: the server overwrites it.
 * So `sender: null` being "accepted with HTTP 200" is not a validation gap — it is the
 * documented contract, and swagger says so outright: "Overwritten from the bearer token on
 * most authenticated routes."
 *
 * Verified directly against `/v2/dashboard/katchupDashboardMsg` and `/v2/dashboard/homeDashboardMsgs`
 * on 2026-08-24: `sender` omitted, null, or set to a foreign account all returned HTTP 200 with
 * the *caller's own* data and never the foreign identifier. That is the server behaving
 * correctly — and it produced five false-positive tickets, three of them Critical.
 *
 * ## The field-level rule, and why the endpoint list alone is not enough
 *
 * The workbook records which endpoints read the token, not which DTO field they assign. Applying
 * it per-endpoint would over-suppress: `/v2/katchup/messageCountBetweenSenderAndReceiver` is on
 * the list, but only `sender` comes from the token — `receiver` is the *other* party and a token
 * cannot supply it. Confirmed the same day: `receiver: null` returns `messageCount: 0` and
 * SUCCESS, which is a genuine finding and must stay filed.
 *
 * So suppression needs both halves: the endpoint must be on this list **and** the field must be
 * one the caller's own identity can populate. `CALLER_IDENTITY_FIELDS` in the emitted module
 * carries that second half; `groupKpostID`, `receiver` and `contactID` are deliberately absent.
 *
 * Usage:  node scripts/generate/generateTokenDerived.js
 */

const fs = require('fs');
const path = require('path');
const zlib = require('zlib');

const ROOT = require('../lib/repo-root').repoRoot(__dirname);
const WORKBOOK = path.join(ROOT, 'data', 'kpostID_attribute_usages.xlsx');
const OUT = path.join(ROOT, 'src', 'api', 'registry', 'tokenDerived.generated.ts');

/** Minimal xlsx reader: the workbook is a zip of XML, and only two parts are needed. */
function unzip(buffer) {
  const files = {};
  for (let i = 0; i < buffer.length - 4; i += 1) {
    if (buffer.readUInt32LE(i) !== 0x04034b50) continue;
    const method = buffer.readUInt16LE(i + 8);
    const nameLength = buffer.readUInt16LE(i + 26);
    const extraLength = buffer.readUInt16LE(i + 28);
    let compressedSize = buffer.readUInt32LE(i + 18);
    const name = buffer.toString('utf8', i + 30, i + 30 + nameLength);
    const start = i + 30 + nameLength + extraLength;
    if (compressedSize === 0) {
      // Streamed entry: the size lives in a trailing data descriptor, so scan for it.
      let end = start;
      while (end < buffer.length - 4 && buffer.readUInt32LE(end) !== 0x08074b50) end += 1;
      compressedSize = end - start;
    }
    const raw = buffer.slice(start, start + compressedSize);
    try {
      files[name] = method === 8 ? zlib.inflateRawSync(raw).toString('utf8') : raw.toString('utf8');
    } catch {
      /* a part we do not need failed to inflate; ignore it */
    }
  }
  return files;
}

const decode = (s) =>
  s
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&amp;/g, '&');

function readRows(sheetXml) {
  const rows = [];
  for (const row of sheetXml.matchAll(/<row[^>]*r="(\d+)"[^>]*>([\s\S]*?)<\/row>/g)) {
    const cells = {};
    for (const cell of row[2].matchAll(/<c[^>]*r="([A-Z]+)\d+"[^>]*>([\s\S]*?)<\/c>/g)) {
      const inline = /<is>[\s\S]*?<t[^>]*>([\s\S]*?)<\/t>/.exec(cell[2]);
      const value = /<v>([\s\S]*?)<\/v>/.exec(cell[2]);
      cells[cell[1]] = decode(inline ? inline[1] : value ? value[1] : '');
    }
    rows.push({ index: Number(row[1]), cells });
  }
  return rows;
}

function main() {
  if (!fs.existsSync(WORKBOOK)) {
    console.error(`[token-derived] ${path.basename(WORKBOOK)} not found at the repo root. Nothing generated.`);
    process.exit(2);
  }

  const files = unzip(fs.readFileSync(WORKBOOK));
  const workbook = files['xl/workbook.xml'] ?? '';
  const sheetNames = [...workbook.matchAll(/<sheet[^>]*name="([^"]+)"/g)].map((m) => m[1]);

  // Sheet 1 is the live-code tab; sheet 2 ("Commented Out") is deliberately not read.
  const rows = readRows(files['xl/worksheets/sheet1.xml'] ?? '');

  // A handful of rows record an occurrence the search could not resolve to a route and write
  // "?" for the method or the path. Suppressing a finding needs an exact match, so anything
  // that is not a real verb on a concrete path is dropped rather than guessed at.
  const VERBS = new Set(['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'HEAD', 'OPTIONS']);

  const endpoints = new Set();
  const controllers = new Set();
  const unresolved = [];
  for (const { cells } of rows) {
    const method = (cells.B ?? '').trim().toUpperCase();
    const endpointPath = (cells.C ?? '').trim();
    if (!endpointPath.startsWith('/') || endpointPath.includes('?') || !VERBS.has(method)) {
      if (endpointPath || method) unresolved.push(`${method || '?'} ${endpointPath || '?'}`);
      continue;
    }
    endpoints.add(`${method} ${endpointPath}`);
    if (cells.A) controllers.add(cells.A);
  }
  if (unresolved.length) {
    console.log(`[token-derived] skipped ${unresolved.length} unresolved row(s): ${unresolved.slice(0, 5).join(', ')}`);
  }

  const sorted = [...endpoints].sort();

  const banner = `/**
 * GENERATED by scripts/generate/generateTokenDerived.js — do not edit.
 * Source: kpostID_attribute_usages.xlsx (tab "${sheetNames[0] ?? 'All Endpoints'}")
 *
 * Endpoints whose controller calls \`(String) request.getAttribute("kpostID")\` — it takes the
 * caller's identity from the verified bearer token and overwrites whatever the payload carried.
 *
 * On these routes an identity field in the request body cannot influence the outcome, so
 * "invalid input accepted" is the documented contract rather than a validation gap. Swagger says
 * the same: "Overwritten from the bearer token on most authenticated routes."
 *
 * ${sorted.length} endpoints across ${controllers.size} controllers.
 */`;

  const body = `${banner}
export const TOKEN_DERIVED_ENDPOINTS: ReadonlySet<string> = new Set([
${sorted.map((e) => `  '${e}',`).join('\n')}
]);

/**
 * Payload fields the caller's **own** identity can populate.
 *
 * The token yields one thing: who is calling. So it can stand in for \`sender\` or \`kpostID\`,
 * and never for a second party or an unrelated entity. \`receiver\`, \`groupKpostID\` and
 * \`contactID\` are absent on purpose — verified on 2026-08-24, \`receiver: null\` against
 * \`/v2/katchup/messageCountBetweenSenderAndReceiver\` returns \`messageCount: 0\` with SUCCESS,
 * which is a real finding that must keep being filed.
 */
export const CALLER_IDENTITY_FIELDS: ReadonlySet<string> = new Set([
  'kpostid',
  'sender',
  'owner',
  'createdby',
  'userid',
  'senderkpostid',
]);

/** True when this endpoint takes the caller's identity from the token. */
export function isTokenDerivedEndpoint(method: string, endpointPath: string): boolean {
  return TOKEN_DERIVED_ENDPOINTS.has(\`\${method.toUpperCase()} \${endpointPath}\`);
}
`;

  fs.mkdirSync(path.dirname(OUT), { recursive: true });
  fs.writeFileSync(OUT, body, 'utf-8');
  console.log(`[token-derived] ${sorted.length} endpoints across ${controllers.size} controllers`);
  console.log(`[token-derived] wrote ${path.relative(ROOT, OUT)}`);
}

main();
