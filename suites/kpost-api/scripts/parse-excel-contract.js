#!/usr/bin/env node
/**
 * Parses the KPOST API workbook into `docs/excel/endpoints.json`.
 *
 * Usage: node scripts/parse-excel-contract.js "<path to .xlsx>" [outfile]
 *
 * ## Per-tab column layout — the reason this is not a heuristic
 *
 * The three tabs do not share a shape, and guessing costs correctness both ways:
 *
 *   KatchupAPI   B=module  J=name  K=url          L=request   N=response
 *   KMAILAPI     B=module  C=verb  D=path         F=request   J=response
 *   KDIARY       B=module  C=verb  D=path         F=request   J=response
 *
 * A "first URL-shaped cell" rule picks column **A** on KatchupAPI, which holds free-text notes
 * that often quote a URL. A "longest JSON cell" rule picks the **response** sample, so a
 * conformance gate fed by it would demand response fields in request payloads. Both were observed.
 *
 * ## Yellow = superseded
 *
 * A `#FFFF00` fill on the endpoint cell marks an endpoint the product no longer uses. The fill is
 * in `styles.xml`, reached through the cell's style index — never on the cell itself.
 *
 * ## Two OOXML details that break naive parsing
 *
 * 1. Self-closing cells (`<c r="B4" s="2"/>`) need their own alternative in the pattern, matched
 *    BEFORE the open/close form. A single greedy pattern consumes the `/` and runs on to a later
 *    `</c>`, swallowing the cells between and shifting every subsequent column.
 * 2. Cell text is an index into `sharedStrings.xml`, not a literal.
 */
'use strict';

const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');

const SOURCE = process.argv[2];
const OUT = process.argv[3] || path.join(__dirname, '..', 'docs', 'excel', 'endpoints.json');

if (!SOURCE || !fs.existsSync(SOURCE)) {
  console.error('usage: node scripts/parse-excel-contract.js "<path to KPOST API.xlsx>" [outfile]');
  process.exit(2);
}

/** column letter -> 1-based index */
const colIndex = (c) => c.split('').reduce((n, ch) => n * 26 + (ch.charCodeAt(0) - 64), 0);

const LAYOUTS = {
  KatchupAPI: { module: 'B', name: 'J', url: 'K', request: 'L' },
  KMAILAPI: { module: 'B', method: 'C', url: 'D', request: 'F' },
  KDIARY: { module: 'B', method: 'C', url: 'D', request: 'F' },
};


/**
 * Top-level balanced `{…}` blocks in a cell, in order.
 *
 * Brace-counting rather than a regex: the documented bodies nest objects and arrays, and a lazy
 * pattern stops at the first inner `}`.
 */
function extractJsonBlocks(text) {
  const blocks = [];
  let depth = 0;
  let start = -1;
  for (let i = 0; i < text.length; i += 1) {
    if (text[i] === '{') {
      if (depth === 0) start = i;
      depth += 1;
    } else if (text[i] === '}') {
      depth -= 1;
      if (depth === 0 && start >= 0) {
        blocks.push(text.slice(start, i + 1));
        start = -1;
      }
      if (depth < 0) depth = 0;
    }
  }
  return blocks;
}

const TMP = path.join(process.env.TEMP || '/tmp', `xlsx-${Date.now()}`);
fs.mkdirSync(TMP, { recursive: true });

// Expand-Archive insists on a .zip extension.
const zip = path.join(TMP, 'workbook.zip');
fs.copyFileSync(SOURCE, zip);
execFileSync(
  'powershell',
  ['-NoProfile', '-Command', `Expand-Archive -LiteralPath '${zip}' -DestinationPath '${TMP}' -Force`],
  { stdio: 'ignore' }
);

const read = (p) => (fs.existsSync(p) ? fs.readFileSync(p, 'utf8') : '');
const decode = (s) =>
  s
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'");

const shared = [...read(path.join(TMP, 'xl', 'sharedStrings.xml')).matchAll(/<si\b[^>]*>([\s\S]*?)<\/si>/g)].map(
  (m) => decode([...m[1].matchAll(/<t\b[^>]*>([\s\S]*?)<\/t>/g)].map((t) => t[1]).join(''))
);

const stylesXml = read(path.join(TMP, 'xl', 'styles.xml'));
const fills = [...(/<fills\b[^>]*>([\s\S]*?)<\/fills>/.exec(stylesXml)?.[1] ?? '').matchAll(/<fill>([\s\S]*?)<\/fill>/g)].map(
  (m) => /FFFF00/i.test(m[1])
);
const xfFillIds = [...(/<cellXfs\b[^>]*>([\s\S]*?)<\/cellXfs>/.exec(stylesXml)?.[1] ?? '').matchAll(/<xf\b([^>]*?)\/?>/g)].map(
  (m) => Number(/fillId="(\d+)"/.exec(m[1])?.[1] ?? 0)
);
const isYellow = (styleIndex) => Boolean(fills[xfFillIds[Number(styleIndex) || 0]]);

const relTarget = {};
for (const m of read(path.join(TMP, 'xl', '_rels', 'workbook.xml.rels')).matchAll(/Id="([^"]+)"[^>]*Target="([^"]+)"/g)) {
  relTarget[m[1]] = m[2];
}
const sheets = [...read(path.join(TMP, 'xl', 'workbook.xml')).matchAll(/<sheet\b[^>]*name="([^"]+)"[^>]*r:id="([^"]+)"/g)].map(
  (m) => ({ name: m[1], file: path.join(TMP, 'xl', relTarget[m[2]].replace(/^\/?xl\//, '')) })
);

const records = [];
const skippedTabs = [];

for (const sheet of sheets) {
  const layout = LAYOUTS[sheet.name];
  if (!layout) {
    skippedTabs.push(sheet.name);
    continue;
  }
  const xml = read(sheet.file);

  for (const rowMatch of xml.matchAll(/<row\b([^>]*)>([\s\S]*?)<\/row>/g)) {
    const rowNum = Number(/r="(\d+)"/.exec(rowMatch[1])?.[1] ?? 0);
    const cells = {};
    const styles = {};

    for (const c of rowMatch[2].matchAll(/<c\b([^>]*?)\/>|<c\b([^>]*?)>([\s\S]*?)<\/c>/g)) {
      const attrs = c[1] ?? c[2] ?? '';
      const inner = c[3] ?? '';
      const ref = /r="([A-Z]+\d+)"/.exec(attrs)?.[1];
      if (!ref) continue;
      const col = /^([A-Z]+)/.exec(ref)[1];
      const type = /t="([^"]+)"/.exec(attrs)?.[1];
      const raw = /<v>([\s\S]*?)<\/v>/.exec(inner)?.[1];
      const inline = [...inner.matchAll(/<t\b[^>]*>([\s\S]*?)<\/t>/g)].map((t) => t[1]).join('');

      if (type === 's' && raw !== undefined) cells[col] = shared[Number(raw)] ?? '';
      else if (inline) cells[col] = decode(inline);
      else if (raw !== undefined) cells[col] = raw;
      styles[col] = /s="(\d+)"/.exec(attrs)?.[1];
    }

    /*
     * The layout column is authoritative, with two documented exceptions found by diffing a
     * re-parse against the previous contract — both of which silently dropped real endpoints:
     *
     *  - KatchupAPI R66 has junk (" z") in K and the real URL in A. So when the layout column
     *    does not look like a URL or a path, fall back to any column that does.
     *  - KMAILAPI R33 holds `sentMail/getMailCredentials/` with NO leading slash. Requiring one
     *    discarded the row.
     */
    const looksLikeEndpoint = (v) => /^https?:\/\/|^\/?[a-zA-Z][\w-]*\//.test(String(v).trim());

    let urlValue = String(cells[layout.url] ?? '').trim();
    if (!looksLikeEndpoint(urlValue)) {
      urlValue =
        Object.keys(cells)
          .sort((a, b) => colIndex(a) - colIndex(b))
          .map((c) => String(cells[c]).trim())
          .find((v) => /^https?:\/\//.test(v)) ?? '';
    }
    if (!urlValue) continue;

    /*
     * SOME ROWS DOCUMENT TWO ENDPOINTS.
     *
     * KatchupAPI R7 is `forgotPasswordUpdate` AND `changePassword`; R8 is `sendOTP` AND
     * `validateOTP`. The url cell holds both URLs and the request cell holds both bodies, each
     * behind a label. Keeping only the first URL and the whole request cell made the second
     * endpoint's fields look like missing fields on the first — which reported `otp`/`sendDate`
     * as absent from `sendOTP`, where they do not belong.
     *
     * So a row emits one record per URL, paired positionally with the balanced `{…}` blocks in
     * the request cell. When the counts disagree the request is left EMPTY rather than guessed:
     * a row the parser cannot split should contribute no field demands at all.
     */
    const urls = urlValue.split(/\s+/).filter((u) => /^https?:\/\/|^\//.test(u));
    const bodies = extractJsonBlocks(String(cells[layout.request] ?? ''));

    for (const [index, rawUrl] of urls.entries()) {
      let pathValue = rawUrl.startsWith('http')
        ? '/' + rawUrl.replace(/^https?:\/\/[^/]+\/?/, '')
        : rawUrl;
      if (!pathValue.startsWith('/')) pathValue = `/${pathValue}`;
      // Collapse the accidental double slash on R4 (`//v2/signupLogin/userLogin/`).
      pathValue = pathValue.replace(/^\/{2,}/, '/');
      if (!/^\/[a-zA-Z]/.test(pathValue)) continue;

      const request =
        urls.length === 1
          ? String(cells[layout.request] ?? '')
          : bodies.length === urls.length
            ? bodies[index]
            : '';

      records.push({
        tab: sheet.name,
        row: rowNum,
        module: String(cells[layout.module] ?? '').trim() || undefined,
        name: layout.name
          ? String(cells[layout.name] ?? '').trim().split(/\s+/)[index] || undefined
          : undefined,
        method: layout.method
          ? String(cells[layout.method] ?? '').trim().toUpperCase() || undefined
          : undefined,
        url: rawUrl,
        path: pathValue,
        request,
        yellow: isYellow(styles[layout.url]),
      });
    }
    continue;
  }
}

records.sort((a, b) => a.tab.localeCompare(b.tab) || a.row - b.row);
fs.mkdirSync(path.dirname(OUT), { recursive: true });
fs.writeFileSync(OUT, JSON.stringify(records, null, 2) + '\n');

const yellow = records.filter((r) => r.yellow).length;
console.log(`\nparsed ${records.length} endpoint rows -> ${path.relative(process.cwd(), OUT)}`);
console.log(`  mandatory : ${records.length - yellow}`);
console.log(`  yellow    : ${yellow} (superseded, excluded from every gate)`);
for (const tab of [...new Set(records.map((r) => r.tab))]) {
  const rows = records.filter((r) => r.tab === tab);
  const withBody = rows.filter((r) => /"[A-Za-z_]+"\s*:/.test(r.request)).length;
  console.log(`  ${tab.padEnd(14)} ${String(rows.length).padStart(3)} rows, ${withBody} documenting a request body`);
}
if (skippedTabs.length) {
  console.log(`\n  tabs without a declared layout (not parsed): ${skippedTabs.join(', ')}`);
  console.log('  Add one to LAYOUTS above if a tab should contribute endpoints.');
}

fs.rmSync(TMP, { recursive: true, force: true });
