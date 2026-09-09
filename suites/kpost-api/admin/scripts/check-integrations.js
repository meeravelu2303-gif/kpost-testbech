#!/usr/bin/env node
/**
 * Preflight for the two external systems this bench publishes to: the QA Dashboard and
 * Bugzilla. Read-only — it creates no run, files no ticket and changes nothing.
 *
 * ## Why a preflight exists at all
 *
 * Both publishers are fail-safe by design: they print one line and return rather than failing
 * the run, because an unreachable dashboard must never change a test result. The cost of that
 * choice is that a misconfiguration is *quiet*. A wrong API key, a product that was never
 * created, a component whose name does not match the Swagger tag — each of those produces a
 * single skipped/failed line buried in a few thousand lines of run output, and the operator's
 * next signal is "the dashboard has no runs" a week later.
 *
 * So the diagnosis is pulled out into a command that can be run in five seconds, before a
 * nine-minute suite, and that says exactly which half is wrong.
 *
 * ## What it checks
 *
 * **QA Dashboard.** Posts a deliberately invalid payload to `DASHBOARD_INGEST_URL`. The
 * dashboard authenticates first and validates second, so the response separates the two
 * failure modes exactly: `401` means the API key is wrong, `422` means the key was accepted
 * and only the (intentionally bogus) body was rejected. A 422 is therefore the *success*
 * case here, and nothing is stored — `processIngest` never runs.
 *
 * **Bugzilla.** Reads `/version`, then an authenticated search, then the product's component
 * list, and diffs that list against every module in `moduleOwnership.generated.ts`. A module
 * with no matching component is the failure that silently mis-routes tickets: the filer
 * substitutes `BUGZILLA_FALLBACK_COMPONENT` and the ticket lands on the wrong team's queue.
 * Naming the missing components is the whole point — they are an admin action in Bugzilla,
 * and nothing in this repository can create them.
 *
 * Usage:
 *   npm run check:integrations
 *   node scripts/check-integrations.js --json
 */

const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
require('dotenv').config({ path: path.join(ROOT, '.env'), quiet: true });

const TIMEOUT_MS = 15_000;
const JSON_OUT = process.argv.includes('--json');

/* ------------------------------------------------------------------ helpers */

/** One HTTP call with a hard timeout. Never throws; every failure comes back as a value. */
async function call(url, options = {}) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
  try {
    const response = await fetch(url, { ...options, signal: controller.signal });
    const text = await response.text().catch(() => '');
    let json;
    try {
      json = text ? JSON.parse(text) : undefined;
    } catch {
      json = undefined;
    }
    return { ok: response.ok, status: response.status, json, text };
  } catch (error) {
    const reason =
      error instanceof Error && error.name === 'AbortError'
        ? `no response within ${TIMEOUT_MS / 1000}s`
        : error instanceof Error
          ? error.message
          : String(error);
    return { ok: false, error: reason };
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Every module name the ownership registry can produce, read out of the generated TypeScript
 * without compiling it.
 *
 * The file is generated, so its shape is fixed: one object literal assigned to
 * `MODULE_BY_PATH`. Slicing that literal out and parsing it as JSON is cheaper and more
 * robust than adding a build step to a preflight whose whole value is being fast.
 */
function registryModules() {
  const file = path.join(ROOT, 'src', 'api', 'registry', 'moduleOwnership.generated.ts');
  const source = fs.readFileSync(file, 'utf-8');
  const start = source.indexOf('{', source.indexOf('MODULE_BY_PATH'));
  const end = source.lastIndexOf('};');
  const map = JSON.parse(source.slice(start, end + 1));

  const modules = new Map();
  for (const ownership of Object.values(map)) {
    modules.set(ownership.module, (modules.get(ownership.module) ?? 0) + 1);
  }
  return modules;
}

/* ------------------------------------------------------------------ QA Dashboard */

async function checkDashboard() {
  const url = process.env.DASHBOARD_INGEST_URL;
  const apiKey = process.env.DASHBOARD_API_KEY;

  if (!url || !apiKey) {
    const missing = !url ? 'DASHBOARD_INGEST_URL' : 'DASHBOARD_API_KEY';
    return { name: 'QA Dashboard', state: 'not-configured', detail: `${missing} is unset` };
  }

  /*
   * Deliberately invalid: `generatedAt` is not a datetime and `run` is missing entirely, so
   * the dashboard's Zod schema rejects it. Auth runs before validation, which is what makes
   * the two answers distinguishable — and because validation fails, no run row is written.
   */
  const probe = await call(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${apiKey}` },
    body: JSON.stringify({ __preflight: true, generatedAt: 'not-a-date', environment: '' }),
  });

  if (probe.error) {
    return { name: 'QA Dashboard', state: 'unreachable', detail: probe.error, url };
  }
  if (probe.status === 401) {
    return {
      name: 'QA Dashboard',
      state: 'auth-failed',
      detail: 'the ingest endpoint answered 401 - DASHBOARD_API_KEY is wrong, or the application is inactive',
      url,
    };
  }
  if (probe.status === 422) {
    return {
      name: 'QA Dashboard',
      state: 'ok',
      detail: 'reachable and the API key was accepted (the probe payload was rejected on purpose; nothing was stored)',
      url,
    };
  }
  if (probe.status === 404) {
    return {
      name: 'QA Dashboard',
      state: 'wrong-url',
      detail: 'HTTP 404 - DASHBOARD_INGEST_URL does not point at the ingest route (it should end in /api/ingest)',
      url,
    };
  }
  return {
    name: 'QA Dashboard',
    state: 'unexpected',
    detail: `HTTP ${probe.status} - expected 422 from the invalid probe payload`,
    url,
  };
}

/* ------------------------------------------------------------------ Bugzilla */

async function checkBugzilla() {
  const raw = process.env.BUGZILLA_URL;
  const apiKey = process.env.BUGZILLA_API_KEY;
  const product = process.env.BUGZILLA_PRODUCT || 'KPost Admin';
  const fallback = process.env.BUGZILLA_FALLBACK_COMPONENT || 'admin-module-application';
  const dryRun = process.env.BUGZILLA_DRY_RUN === 'true';

  if (!raw || !apiKey) {
    const missing = !raw ? 'BUGZILLA_URL' : 'BUGZILLA_API_KEY';
    return { name: 'Bugzilla', state: 'not-configured', detail: `${missing} is unset` };
  }
  const url = raw.replace(/\/+$/, '');

  const version = await call(`${url}/version`);
  if (version.error) {
    return { name: 'Bugzilla', state: 'unreachable', detail: version.error, url };
  }
  if (!version.ok || !version.json?.version) {
    return {
      name: 'Bugzilla',
      state: 'wrong-url',
      detail: `GET /version answered HTTP ${version.status} without a version - BUGZILLA_URL should end in /rest`,
      url,
    };
  }

  /*
   * Bugzilla reports an application error as HTTP 200 carrying `{"error": true}`, so the
   * envelope has to be inspected rather than the status. That is the same fault class this
   * suite hunts on KPOST, and it is why an unauthenticated search here reads as a success.
   */
  const search = await call(
    `${url}/bug?limit=1&include_fields=id&api_key=${encodeURIComponent(apiKey)}`
  );
  if (search.error || !search.ok || search.json?.error === true) {
    return {
      name: 'Bugzilla',
      state: 'auth-failed',
      detail: search.json?.message
        ? String(search.json.message).split('\n')[0].trim()
        : search.error ?? `HTTP ${search.status}`,
      url,
      version: version.json.version,
    };
  }

  const products = await call(
    `${url}/product?names=${encodeURIComponent(product)}&include_fields=components.name&api_key=${encodeURIComponent(apiKey)}`
  );
  const found = products.json?.products?.[0];
  if (!found) {
    return {
      name: 'Bugzilla',
      state: 'missing-product',
      detail: `no product named "${product}" is visible to this API key - create it in Bugzilla, or set BUGZILLA_PRODUCT`,
      url,
      version: version.json.version,
      product,
      dryRun,
    };
  }

  const components = new Set((found.components ?? []).map((c) => c.name).filter(Boolean));
  const modules = registryModules();
  const missing = [...modules.entries()]
    .filter(([name]) => !components.has(name))
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
    .map(([name, endpoints]) => ({ name, endpoints }));

  return {
    name: 'Bugzilla',
    state: missing.length === 0 ? 'ok' : 'components-missing',
    detail:
      missing.length === 0
        ? `product "${product}" has a component for all ${modules.size} modules`
        : `${missing.length} of ${modules.size} modules have no component in "${product}" - their tickets will be filed under "${fallback}" and routed to the wrong team`,
    url,
    version: version.json.version,
    product,
    dryRun,
    fallbackComponent: fallback,
    fallbackExists: components.has(fallback),
    missingComponents: missing,
  };
}

/* ------------------------------------------------------------------ output */

const SYMBOL = {
  ok: 'OK  ',
  'not-configured': 'SKIP',
  unreachable: 'FAIL',
  'auth-failed': 'FAIL',
  'wrong-url': 'FAIL',
  'missing-product': 'FAIL',
  'components-missing': 'WARN',
  unexpected: 'WARN',
};

/** Only a genuine misconfiguration fails the command; "not configured" is a decision. */
const FAILING = new Set(['unreachable', 'auth-failed', 'wrong-url', 'missing-product']);

function print(result) {
  console.log(`[${SYMBOL[result.state] ?? '????'}] ${result.name} - ${result.detail}`);
  if (result.url) console.log(`       url        ${result.url}`);
  if (result.version) console.log(`       version    ${result.version}`);
  if (result.product) console.log(`       product    ${result.product}`);
  if (result.dryRun !== undefined) {
    console.log(
      `       dry run    ${result.dryRun ? 'true - no ticket will actually be filed' : 'false - defects WILL be filed'}`
    );
  }
  if (result.fallbackComponent && result.fallbackExists === false) {
    console.log(
      `       fallback   "${result.fallbackComponent}" does not exist either - an unmapped module's create will be refused outright`
    );
  }
  for (const component of result.missingComponents ?? []) {
    console.log(`       missing    ${component.name}  (${component.endpoints} endpoint(s))`);
  }
}

async function main() {
  const results = [await checkDashboard(), await checkBugzilla()];

  if (JSON_OUT) {
    console.log(JSON.stringify({ checkedAt: new Date().toISOString(), results }, null, 2));
  } else {
    console.log('');
    for (const result of results) {
      print(result);
      console.log('');
    }
  }

  if (results.some((result) => FAILING.has(result.state))) process.exitCode = 1;
}

void main();
