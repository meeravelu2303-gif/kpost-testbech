/**
 * Excel ↔ bench payload conformance gate.
 *
 * The Excel workbook is the **authoritative contract for request payloads** (see the root
 * CLAUDE.md — where Excel and swagger disagree, Excel wins). This gate holds the suite to it: for
 * every MANDATORY endpoint that documents a JSON body, every field in that documented body must
 * actually be sent by the tests for THAT endpoint.
 *
 * ## What counts as "sent"
 *
 * The endpoint's own `test.describe` block, plus the bodies of every `build*` payload builder it
 * calls, followed transitively. That line is deliberate:
 *
 *  - stricter than "the field name appears somewhere in the suite" — a field sent to a different
 *    endpoint proves nothing about this one;
 *  - looser than "the builder literally declares it" — a field supplied as an inline override
 *    inside the describe genuinely reaches the endpoint, and demanding it live in the builder
 *    would flag correct code.
 *
 * ## Yellow rows are skipped
 *
 * A yellow (`#FFFF00`) fill on the endpoint cell marks a superseded endpoint the product no
 * longer uses. Those are out of scope by instruction and are not counted either way.
 *
 * ## The contract file
 *
 * `docs/excel/endpoints.json` is the machine-readable form of the workbook, checked in so this
 * gate runs in CI without the .xlsx and so a contract change shows up as a reviewable diff. See
 * `docs/excel/README.md` for how it is regenerated.
 *
 * Usage:  node scripts/excel-conformance.js [--threshold 95] [--json]
 * Exit:   0 when conformance >= threshold, 1 otherwise.
 */
'use strict';

const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const CONTRACT = path.join(ROOT, 'docs', 'excel', 'endpoints.json');

const argv = process.argv.slice(2);
const asJson = argv.includes('--json');
const thresholdArg = argv.indexOf('--threshold');
const THRESHOLD = thresholdArg >= 0 ? Number(argv[thresholdArg + 1]) : 95;

/* ============================================================================================
 * Source parsing
 * ========================================================================================= */

/**
 * Every function in the payload files, with its body text.
 *
 * Local (non-exported) helpers count. `kmailSetting.payload.ts` composes its signature builders
 * from `personalDataFields()` / `graphicsFields()` / `socialMediaFields()`, which are neither
 * exported nor `build*`-named — parsing only exported builders made twelve fully-sent fields
 * (lastName, photoUrl, the five social links…) look absent.
 */
function parseBuilders(roots) {
  const files = [];
  const walk = (dir) => {
    if (!fs.existsSync(dir)) return;
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        if (!/node_modules/.test(full)) walk(full);
      } else if (/\.payload\.ts$/.test(full)) {
        files.push(full);
      }
    }
  };
  roots.forEach((r) => walk(path.join(ROOT, r)));

  const fns = [];
  for (const file of files) {
    const txt = fs.readFileSync(file, 'utf8');
    const re = /(?:export\s+)?function (\w+)\s*\(/g;
    let m;
    while ((m = re.exec(txt))) {
      // Walk the parameter list to its closing paren.
      let i = re.lastIndex - 1;
      let depth = 0;
      for (; i < txt.length; i++) {
        if (txt[i] === '(') depth++;
        else if (txt[i] === ')') {
          depth--;
          if (!depth) {
            i++;
            break;
          }
        }
      }
      // Skip any return-type annotation to the body's opening brace.
      let j = i;
      let angle = 0;
      for (; j < txt.length; j++) {
        const c = txt[j];
        if (c === '<') angle++;
        else if (c === '>') angle--;
        else if (c === '{' && angle <= 0) break;
      }
      // Take the balanced body.
      let k = j;
      let braces = 0;
      for (; k < txt.length; k++) {
        if (txt[k] === '{') braces++;
        else if (txt[k] === '}') {
          braces--;
          if (!braces) break;
        }
      }
      fns.push({ name: m[1], file, body: txt.slice(j, k + 1) });
      re.lastIndex = k + 1;
    }
  }
  return fns;
}

const stripComments = (src) =>
  src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '');

/*
 * Identifiers that are `key:`-shaped in TypeScript source but are not request fields — type
 * annotations, control keywords, faker options (`{ length: 8, casing: 'lower' }`) and request
 * options (`{ token, headers }`). Without this filter a builder's own type signature would be
 * counted as payload it sends.
 *
 * Keep this list MINIMAL. `type` was on it and should not have been: it is a genuine Excel field
 * on `/dairySchedule/createEvent`, which the kdiary builder does send — so the filter reported a
 * conformance gap that did not exist. A name only belongs here when no endpoint in the workbook
 * documents a field of that name.
 */
const NOISE = new Set([
  'string', 'number', 'boolean', 'Record', 'Partial', 'unknown', 'any', 'return', 'if', 'else',
  'const', 'let', 'overrides', 'options', 'void', 'null', 'undefined', 'Promise',
  'Array', 'readonly', 'min', 'max', 'length', 'casing', 'token', 'headers',
]);

const keysIn = (src) => {
  const keys = [...src.matchAll(/(?:^|[{,\s])["']?([A-Za-z_][A-Za-z0-9_]*)["']?\s*:/gm)].map(
    (m) => m[1]
  );
  /*
   * ES6 shorthand properties too. `buildAdminRegistrationPayload` sends `uniqueName` as
   * `{ uniqueName, ... }` and `buildSaluationIdPayload` sends `buildSaluationPayload({
   * saluationID, ...overrides })` — no colon in either — and a `key:`-only match reported those
   * as fields the suite never sends, sending a reader to look for bugs that did not exist.
   *
   * Two forms are matched: the identifier alone on its line, and an identifier sitting directly
   * after `{` or `,` and directly before `,` or `}`. The second is the looser one, and a false
   * match there is worse than a missed field — it would report conformance the suite does not
   * have. It is safe here because the only construct it could confuse is a destructuring
   * declaration (`const { a } = x`), and the payload files contain none: verified zero matches
   * for `(const|let|var)\s*\{` across both benches' payload trees. Re-check that if this ever
   * scans a wider set of files.
   */
  keys.push(...[...src.matchAll(/^\s*([A-Za-z_][A-Za-z0-9_]*)\s*,\s*$/gm)].map((m) => m[1]));
  keys.push(
    ...[...src.matchAll(/[{,]\s*([A-Za-z_][A-Za-z0-9_]*)\s*(?=[,}])/g)].map((m) => m[1])
  );
  return new Set(keys.filter((k) => !NOISE.has(k)));
};

/* ============================================================================================
 * Endpoint → fields the suite sends it
 * ========================================================================================= */

/*
 * Builders are resolved PER SUITE, not from one flat name→builder map.
 *
 * Nine builder names exist in both benches — `buildUnsubscriberPayload`, `buildForwardPayload`,
 * `buildDesignationLookupPayload`, `syntheticReceiver` and friends. A single map keyed by bare
 * name lets whichever file is walked last silently win, so this gate was resolving KMail's
 * `buildUnsubscriberPayload` while judging KPost's `/v2/common/saveUnsubscriberDetails` and
 * reporting `createdBy` as never sent when the KPost builder sends it. Keeping the two maps
 * apart, and picking the one that matches the spec file under judgement, removes a whole class
 * of phantom findings.
 */
const BUILDERS = {
  kpost: new Map(
    parseBuilders(['src/api']).map((f) => [f.name, { ...f, body: stripComments(f.body) }])
  ),
  kmail: new Map(
    parseBuilders(['kmail/src/api']).map((f) => [f.name, { ...f, body: stripComments(f.body) }])
  ),
};

function builderFields(suite, name, seen = new Set()) {
  if (seen.has(name)) return new Set();
  seen.add(name);
  // Fall back to the sibling suite: a few specs legitimately import a shared helper.
  const fn = BUILDERS[suite].get(name) ?? BUILDERS[suite === 'kpost' ? 'kmail' : 'kpost'].get(name);
  if (!fn) return new Set();
  const out = keysIn(fn.body);
  // Follow every call that resolves to a known payload function — `build*` builders and the local
  // field-helpers alike. Calls that resolve to nothing (faker, Date, JSON) return an empty set.
  for (const call of fn.body.matchAll(/\b([A-Za-z_][A-Za-z0-9_]*)\s*\(/g)) {
    for (const key of builderFields(suite, call[1], seen)) out.add(key);
  }
  return out;
}

/*
 * Route constants: `PATH_KEY -> '/the/path'`, harvested from every client's `*_PATHS` object.
 *
 * Not every describe is titled "<VERB> /path". The KMail settings specs group by theme — "Mail
 * signature writes", "Letterhead", "Canned instant replies" — which is the more readable
 * organisation and should not be penalised. Those blocks still name their endpoint, just as
 * `KMAIL_SETTING_PATHS.saveOrUpdateMailSignature` rather than in the title. Resolving constants
 * lets the gate judge them too: without this, 34 fully-tested endpoints were reported as having
 * no coverage at all.
 */
const ROUTE_CONSTANTS = new Map();
(function harvestRoutes(dirs) {
  const walk = (dir) => {
    if (!fs.existsSync(dir)) return;
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) walk(full);
      // KPost declares its paths in the clients; KMail keeps them in `*.routes.ts`. Read both.
      else if (/\.(client|routes)\.ts$/.test(full)) {
        const txt = fs.readFileSync(full, 'utf8');
        for (const m of txt.matchAll(/^\s*(\w+):\s*'(\/[^']*)'/gm)) {
          ROUTE_CONSTANTS.set(m[1], m[2]);
        }
      }
    }
  };
  dirs.forEach((d) => walk(path.join(ROOT, d)));
})(['src/api', 'kmail/src/api']);

/** Each spec carries the suite it belongs to, so its builders resolve from the right tree. */
const specFiles = [];
(function collect(dirs) {
  const walk = (dir, suite) => {
    if (!fs.existsSync(dir)) return;
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) walk(full, suite);
      else if (/\.spec\.ts$/.test(full)) specFiles.push({ file: full, suite });
    }
  };
  dirs.forEach(({ dir, suite }) => walk(path.join(ROOT, dir), suite));
})([
  { dir: 'tests', suite: 'kpost' },
  { dir: 'kmail/tests', suite: 'kmail' },
]);

const normPath = (p) =>
  String(p).replace(/\{[^}]*\}/g, '{}').replace(/\/+$/, '').replace(/\/{2,}/g, '/').toLowerCase();

/*
 * Describe titles are NOT uniformly "<VERB> <path>". The suite also uses "<Module> - <VERB>
 * <path>" ("Auth - POST /v2/signupLogin/userLogin"). An earlier version of this gate anchored the
 * verb to the start of the title and silently missed every module-prefixed describe, reporting
 * those endpoints as uncovered when they were fully covered. Match the verb+path ANYWHERE in the
 * title instead.
 */
const DESCRIBE_RE =
  /test\.describe\(\s*['"`]([^'"`]*?)['"`]([\s\S]*?)(?=\ntest\.describe\(|$)/g;
const VERB_PATH_RE = /\b(GET|POST|PUT|DELETE|PATCH)\s+(\/[^\s'"`]+)/;

/** normalised path -> { fields, builders } union over every describe naming that path. */
const byPath = new Map();
for (const { file, suite } of specFiles) {
  const txt = fs.readFileSync(file, 'utf8');
  let m;
  DESCRIBE_RE.lastIndex = 0;
  while ((m = DESCRIBE_RE.exec(txt))) {
    const block = stripComments(m[2]);

    /*
     * A block is attributed to every endpoint it names — in its title ("POST /v2/..."), and via
     * any `*_PATHS.<key>` route constant it references. Theme-titled describes reach their
     * endpoint only through the second route.
     */
    const keys = new Set();
    const titled = VERB_PATH_RE.exec(m[1]);
    if (titled) keys.add(normPath(titled[2]));
    for (const ref of block.matchAll(/\b[A-Z][A-Z0-9_]*_PATHS\.(\w+)/g)) {
      const resolved = ROUTE_CONSTANTS.get(ref[1]);
      if (resolved) keys.add(normPath(resolved));
    }
    if (!keys.size) continue;

    const fields = keysIn(block);
    const called = [...block.matchAll(/\b(build[A-Za-z0-9_]+)\s*\(/g)].map((b) => b[1]);

    for (const key of keys) {
      if (!key) continue;
      if (!byPath.has(key)) byPath.set(key, { fields: new Set(), builders: new Set(), suite });
      const entry = byPath.get(key);
      for (const k of fields) entry.fields.add(k);
      for (const b of called) entry.builders.add(b);
    }
  }
}

/* ============================================================================================
 * The check
 * ========================================================================================= */

/**
 * Documented fields the suite deliberately does NOT send, each with the reason.
 *
 * An exemption is a judgement that sending the field would make the tests worse, not a place to
 * park work. Every entry needs a reason a reviewer can disagree with — "hard to do" is not one.
 * Keyed by `<tab>:<row>`, matching `docs/excel/endpoints.json`.
 */
const EXEMPTIONS = {
  'KatchupAPI:45': {
    createdBy:
      'The server derives the acting user from the bearer token. Sending an explicit createdBy ' +
      'would mask the group-creation spoofing cases, which exist to prove a caller cannot forge ' +
      'authorship — the field being absent is what makes those tests meaningful.',
  },
  'KatchupAPI:46': {
    createdBy:
      'Same as createUserGroup (row 45): the actor comes from the token, and supplying one here ' +
      'would defeat the spoofing cases on this route.',
  },
  'KatchupAPI:141': {
    deviceIdentity_Primary:
      'Casing. The suite sends `deviceIdentity_primary` (lower-case p), the spelling the login ' +
      'endpoint requires and which is proven to work — every QA session authenticates with it. ' +
      'The workbook shows `deviceIdentity_Primary` on this row alone; a live probe could not ' +
      'settle it (both spellings answered 401), and Java field binding is case-sensitive, so the ' +
      'suite keeps the spelling it can demonstrate reaches the server.',
    logouttime:
      'Casing, as above: the suite sends `logoutTime`. Flagged here so the discrepancy stays ' +
      'visible rather than being silently normalised away.',
  },
};

const excelKeys = (body) =>
  new Set([...body.matchAll(/"([A-Za-z_][A-Za-z0-9_]*)"s*:/g)].map((m) => m[1]));

const records = JSON.parse(fs.readFileSync(CONTRACT, 'utf8'));
const rows = [];

for (const record of records) {
  if (record.yellow) continue; // superseded — out of scope by instruction
  const request = String(record.request || '').trim();
  if (!/"[A-Za-z_]+"\s*:/.test(request)) continue; // documents no JSON body

  const key = normPath(record.path);
  const entry =
    byPath.get(key) || [...byPath.entries()].find(([k]) => k.endsWith(key) || key.endsWith(k))?.[1];

  if (!entry) {
    rows.push({ record, status: 'NO-DESCRIBE' });
    continue;
  }

  const sent = new Set(entry.fields);
  for (const b of entry.builders) for (const k of builderFields(entry.suite, b)) sent.add(k);

  const exempt = EXEMPTIONS[`${record.tab}:${record.row}`] ?? {};
  const absent = [...excelKeys(request)].filter((k) => !sent.has(k));
  const missing = absent.filter((k) => !(k in exempt));
  const exempted = absent.filter((k) => k in exempt);
  rows.push({
    record,
    status: missing.length ? 'MISSING' : 'CONFORMS',
    missing,
    exempted,
  });
}

const conforms = rows.filter((r) => r.status === 'CONFORMS');
const missing = rows.filter((r) => r.status === 'MISSING');
const noDescribe = rows.filter((r) => r.status === 'NO-DESCRIBE');
const judged = rows.length - noDescribe.length;
const pct = judged ? (conforms.length / judged) * 100 : 100;

if (asJson) {
  console.log(
    JSON.stringify(
      {
        total: rows.length,
        conforms: conforms.length,
        missing: missing.length,
        noDescribe: noDescribe.length,
        conformance: Number(pct.toFixed(2)),
        threshold: THRESHOLD,
        pass: pct >= THRESHOLD,
        details: missing.map((r) => ({
          tab: r.record.tab,
          row: r.record.row,
          path: r.record.path,
          missing: r.missing,
        })),
      },
      null,
      2
    )
  );
} else {
  console.log('\nKPOST Excel ↔ payload conformance\n');
  console.log(`  mandatory endpoints documenting a JSON body : ${rows.length}`);
  console.log(`  every documented field is sent              : ${conforms.length}`);
  console.log(`  at least one documented field never sent    : ${missing.length}`);
  console.log(`  no per-endpoint describe block found        : ${noDescribe.length}`);
  console.log(`\n  CONFORMANCE : ${pct.toFixed(2)}%   (threshold ${THRESHOLD}%)\n`);

  if (missing.length) {
    console.log('=== documented fields never sent to that endpoint ===');
    for (const r of missing) {
      console.log(`  ${r.record.tab} R${r.record.row} ${r.record.path}`);
      console.log(`      ${r.missing.join(', ')}`);
    }
    console.log('');
  }
  if (noDescribe.length) {
    console.log('=== no per-endpoint describe block (not judged) ===');
    for (const r of noDescribe) console.log(`  ${r.record.tab} R${r.record.row} ${r.record.path}`);
    console.log('');
  }
  console.log(pct >= THRESHOLD ? '[excel] PASS\n' : '[excel] FAIL\n');
}

process.exit(pct >= THRESHOLD ? 0 : 1);
