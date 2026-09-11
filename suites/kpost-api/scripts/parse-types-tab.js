#!/usr/bin/env node
/**
 * Re-reads the workbook's `Types(Katchup,Kall&KDiary)` tab into `docs/excel/types.json`.
 *
 *   npm run contract:types -- "<path to .xlsx>"
 *
 * The tab is free text — one cell per module, sections separated by a heading line, entries in
 * several spellings (`0- new,`, `7 - ReScheduled`, `1; //  Reply Message`, `18 Secret Message`,
 * `4 → Primary Audio`, `RECEIVER_TYPE_TO = 1;`). This turns it into `{ section: { n: label } }` so
 * `src/api/enums/kpostTypes.ts` can be checked against it by `npm run test:unit`.
 *
 * Two traps this handles, both of which produced wrong output on the first attempt:
 *   - **Self-closing cells.** `<c r="B3" s="4"/>` must be matched on its own; a greedy
 *     `<c ...>...</c>` swallows the NEXT cell and reports its shared-string index as a value.
 *   - **Rich text.** A cell's text can be split across several `<t>` runs; they are concatenated.
 *
 * Exits non-zero if any expected section is missing or empty — a layout change in the workbook
 * must fail loudly, not silently produce a smaller enum.
 */

const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');

const SOURCE =
  process.argv[2] ||
  process.env.KPOST_WORKBOOK ||
  'C:/Users/Administrator/Downloads/KPOST API (5).xlsx';
const OUT = path.resolve(__dirname, '..', 'docs', 'excel', 'types.json');

if (!fs.existsSync(SOURCE)) {
  console.error(`[types] workbook not found: ${SOURCE}`);
  process.exit(1);
}

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'kpost-types-'));
const zip = path.join(TMP, 'workbook.zip'); // Expand-Archive insists on a .zip extension.
fs.copyFileSync(SOURCE, zip);
execFileSync('powershell', [
  '-NoProfile',
  '-Command',
  `Expand-Archive -LiteralPath '${zip}' -DestinationPath '${TMP}' -Force`,
]);

const read = (p) => fs.readFileSync(p, 'utf8');
const decode = (s) =>
  s
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&#10;/g, '\n')
    .replace(/&amp;/g, '&');
const textOf = (xml) =>
  [...xml.matchAll(/<t\b[^>]*>([\s\S]*?)<\/t>/g)].map((m) => decode(m[1])).join('');

const shared = [
  ...read(path.join(TMP, 'xl', 'sharedStrings.xml')).matchAll(/<si\b[^>]*>([\s\S]*?)<\/si>/g),
].map((m) => textOf(m[1]));
const rels = {};
for (const m of read(path.join(TMP, 'xl', '_rels', 'workbook.xml.rels')).matchAll(
  /Id="([^"]+)"[^>]*Target="([^"]+)"/g,
)) {
  rels[m[1]] = m[2];
}
const sheets = [
  ...read(path.join(TMP, 'xl', 'workbook.xml')).matchAll(
    /<sheet\b[^>]*name="([^"]+)"[^>]*r:id="([^"]+)"/g,
  ),
].map((m) => ({ name: decode(m[1]), target: rels[m[2]] }));
const sheet = sheets.find((s) => /^types/i.test(s.name));
if (!sheet) {
  console.error(`[types] no Types tab. Sheets: ${sheets.map((s) => s.name).join(' | ')}`);
  process.exit(1);
}

const cells = {};
const xml = read(path.join(TMP, 'xl', sheet.target.replace(/^\/?xl\//, '')));
for (const m of xml.matchAll(/<c\b([^>]*?)(?:\/>|>([\s\S]*?)<\/c>)/g)) {
  const ref = /\br="([A-Z]+\d+)"/.exec(m[1])?.[1];
  const type = /\bt="([^"]+)"/.exec(m[1])?.[1];
  const inner = m[2] ?? '';
  let value = '';
  if (type === 's') value = shared[Number(/<v>([\s\S]*?)<\/v>/.exec(inner)?.[1])] ?? '';
  else if (type === 'inlineStr') value = textOf(inner);
  else value = decode(/<v>([\s\S]*?)<\/v>/.exec(inner)?.[1] ?? '');
  if (ref && value.trim()) cells[ref] = value;
}

/** A heading line inside a cell, normalised to letters only, mapped to a section key. */
const HEADINGS = {
  messagetype: 'katchupMessageType',
  sharetype: 'katchupShareType',
  kalltype: 'kallType',
  kallmode: 'kallMode',
  kallrepeattype: 'kallRepeatType',
  kmailtype: 'kmailType',
  receivertype: 'kmailReceiverType',
  priority: 'kmailPriority',
  module: 'module',
  remarks: 'kdiaryRemarks',
};
/** The section a cell starts in before any heading line (the heading lives in the cell above). */
// Cell D3 repeats a subset of C3's kallStatus with identical labels — the same enum, not a
// separate one — so it is read straight into kallStatus (confirmed 2026-09-11: every D value is
// already in C, same label).
const CELL_DEFAULT = { A3: 'katchupStatus', C3: 'kallStatus', D3: 'kallStatus' };

const sections = {};
const put = (section, cell, n, label) => {
  sections[section] ??= { cell, values: {} };
  sections[section].values[String(n)] = label;
};
const cleanLabel = (s) =>
  s
    .replace(/\s+/g, ' ')
    .replace(/[\s,.;]+$/, '')
    .trim();

for (const [cell, text] of Object.entries(cells)) {
  if (cell === 'I3') {
    const tiers = [...text.matchAll(/\b(BUSINESS_[A-Z])\b/g)].map((m) => m[1]);
    sections.businessUserType = { cell, values: tiers };
    continue;
  }
  let section = CELL_DEFAULT[cell] ?? null;
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line) continue;

    const receiver = /^RECEIVER_TYPE_(\w+)\s*=\s*(\d+)/i.exec(line);
    if (receiver) {
      put('kmailReceiverType', cell, receiver[2], receiver[1].toUpperCase());
      continue;
    }
    const status = /^status\s*=\s*(\d+)\s*;?\s*(.+)$/i.exec(line);
    if (status) {
      put('katchupStatus', cell, status[1], cleanLabel(status[2]));
      continue;
    }
    const entry = /^(\d+)\s*(?:;|-|–|→|=)?\s*(?:\/\/)?\s*(.+)$/.exec(line);
    if (entry && section) {
      const label = cleanLabel(entry[2].replace(/^\/\/\s*/, ''));
      if (label) put(section, cell, entry[1], label);
      continue;
    }
    const heading = HEADINGS[line.toLowerCase().replace(/[^a-z]/g, '')];
    if (heading) section = heading;
  }
}

const EXPECTED = [
  'katchupStatus',
  'katchupMessageType',
  'katchupShareType',
  'kallStatus',
  'kallType',
  'kallMode',
  'kallRepeatType',
  'kmailType',
  'kmailReceiverType',
  'kmailPriority',
  'module',
  'kdiaryRemarks',
  'businessUserType',
];
const missing = EXPECTED.filter((k) => {
  const v = sections[k]?.values;
  return !v || (Array.isArray(v) ? v.length === 0 : Object.keys(v).length === 0);
});

const ordered = Object.fromEntries(
  EXPECTED.filter((k) => sections[k]).map((k) => [k, sections[k]]),
);
fs.mkdirSync(path.dirname(OUT), { recursive: true });
fs.writeFileSync(
  OUT,
  JSON.stringify({ source: path.basename(SOURCE), sheet: sheet.name, sections: ordered }, null, 2) +
    '\n',
);

console.log(`\n[types] ${sheet.name} -> ${path.relative(process.cwd(), OUT)}\n`);
for (const [k, s] of Object.entries(ordered)) {
  const v = s.values;
  const shown = Array.isArray(v)
    ? v.join(', ')
    : Object.entries(v)
        .map(([n, l]) => `${n}=${l}`)
        .join(' · ');
  console.log(`  ${k.padEnd(20)} ${s.cell.padEnd(4)} ${shown}`);
}
if (missing.length) {
  console.error(`\n[types] FAIL — sections missing or empty: ${missing.join(', ')}`);
  process.exit(1);
}
console.log('\n[types] PASS');
