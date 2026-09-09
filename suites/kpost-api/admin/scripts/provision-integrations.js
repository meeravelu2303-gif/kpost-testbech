#!/usr/bin/env node
/**
 * Creates this bench's home in the two external systems it publishes to.
 *
 * Both systems are shared across benches and neither is provisioned for the Admin Module yet.
 * Verified against the live instances on 2026-08-24:
 *
 *   Bugzilla 5.2 (192.168.0.50)   products: TestProduct, KPost API, KPost UI  — no KPost Admin
 *   QA Dashboard (192.168.0.50:8081)  applications: kpost-api, kpost-ui       — no kpost-admin
 *
 * Until they are, the publishers are correct and useless: the dashboard answers 401 to every
 * push and Bugzilla refuses every create with *"There is no component named 'Departments' in
 * the 'KPost Admin' product."* Both failures are one log line at the end of a nine-minute run,
 * which is why this is a command rather than a paragraph in a runbook.
 *
 * ## What it creates
 *
 * **Bugzilla** — the product `BUGZILLA_PRODUCT`, then one component per Swagger tag in
 * `moduleOwnership.generated.ts`, plus the `BUGZILLA_FALLBACK_COMPONENT` catch-all. Component
 * names must match the tag *exactly*, because `MODULE_BY_PATH` routes a defect by tag and the
 * filer passes that string straight through as `component`.
 *
 * **QA Dashboard** — the application `kpost-admin`, kind `api`, ticket prefix `KAD`. The API
 * key is displayed **once** and never stored by the dashboard; paste it into `.env` as
 * `DASHBOARD_API_KEY` immediately or create the application again.
 *
 * ## Safety
 *
 * Creating a product in a shared tracker is close to irreversible — Bugzilla's REST API has no
 * delete for products or components. So:
 *
 *   - dry run is the default and prints the complete plan;
 *   - `--apply` is required to write, and refuses without `--yes`;
 *   - each half is opt-in (`--bugzilla`, `--dashboard`); with neither, both are planned;
 *   - re-running is safe: anything that already exists is reported and skipped, never
 *     recreated, so this doubles as a repair step for a half-finished provision.
 *
 * Bugzilla needs an account with `editcomponents`; `BUGZILLA_ADMIN_API_KEY` is used when set,
 * otherwise `BUGZILLA_API_KEY`. The dashboard needs an admin login, from
 * `DASHBOARD_ADMIN_EMAIL` / `DASHBOARD_ADMIN_PASSWORD`.
 *
 * Usage:
 *   node scripts/provision-integrations.js                          # plan both
 *   node scripts/provision-integrations.js --bugzilla               # plan Bugzilla only
 *   node scripts/provision-integrations.js --bugzilla --apply --yes
 *   node scripts/provision-integrations.js --dashboard --apply --yes
 */

const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
require('dotenv').config({ path: path.join(ROOT, '.env'), quiet: true });

const LOG = '[provision]';
const TIMEOUT_MS = 20_000;

const argv = process.argv.slice(2);
const APPLY = argv.includes('--apply');
const CONFIRMED = argv.includes('--yes');
const ONLY_BUGZILLA = argv.includes('--bugzilla');
const ONLY_DASHBOARD = argv.includes('--dashboard');
const DO_BUGZILLA = ONLY_BUGZILLA || !ONLY_DASHBOARD;
const DO_DASHBOARD = ONLY_DASHBOARD || !ONLY_BUGZILLA;

if (APPLY && !CONFIRMED) {
  console.error(`${LOG} --apply also requires --yes. Creating a product in a shared tracker cannot be undone over REST.`);
  process.exit(2);
}

/* ------------------------------------------------------------------ transport */

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
    // Bugzilla reports application errors as HTTP 200 with `{"error": true}`, so the envelope
    // is checked alongside the status — the same fault class this suite hunts on KPOST.
    const failed = !response.ok || json?.error === true;
    return { ok: !failed, status: response.status, json, text, headers: response.headers };
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

function why(result) {
  if (result.error) return result.error;
  const message = result.json?.message;
  if (message) return String(message).split('\n')[0].trim().slice(0, 300);
  return `HTTP ${result.status}${result.text ? ` - ${result.text.slice(0, 200)}` : ''}`;
}

/** Every module name the ownership registry can produce, read without a compile step. */
function registryModules() {
  const file = path.join(ROOT, 'src', 'api', 'registry', 'moduleOwnership.generated.ts');
  const source = fs.readFileSync(file, 'utf-8');
  const start = source.indexOf('{', source.indexOf('MODULE_BY_PATH'));
  const map = JSON.parse(source.slice(start, source.lastIndexOf('};') + 1));

  const modules = new Map();
  for (const [endpointPath, ownership] of Object.entries(map)) {
    const entry = modules.get(ownership.module) ?? { team: ownership.team, endpoints: [] };
    entry.endpoints.push(endpointPath);
    modules.set(ownership.module, entry);
  }
  return modules;
}

/* ------------------------------------------------------------------ Bugzilla */

async function provisionBugzilla() {
  const raw = process.env.BUGZILLA_URL;
  const apiKey = process.env.BUGZILLA_ADMIN_API_KEY || process.env.BUGZILLA_API_KEY;
  const product = process.env.BUGZILLA_PRODUCT || 'KPost Admin';
  const fallback = process.env.BUGZILLA_FALLBACK_COMPONENT || 'admin-module-application';
  const version = process.env.BUGZILLA_VERSION || 'unspecified';

  console.log(`\n${LOG} ===== Bugzilla =====`);
  if (!raw || !apiKey) {
    console.log(`${LOG} skipped - ${!raw ? 'BUGZILLA_URL' : 'BUGZILLA_API_KEY'} is unset`);
    return;
  }
  const url = raw.replace(/\/+$/, '');
  const auth = `api_key=${encodeURIComponent(apiKey)}`;

  const existing = await call(`${url}/product?names=${encodeURIComponent(product)}&include_fields=id,name,components.name&${auth}`);
  if (!existing.ok) {
    console.log(`${LOG} cannot read products - ${why(existing)}`);
    return;
  }

  const found = existing.json?.products?.[0];
  const components = new Set((found?.components ?? []).map((c) => c.name).filter(Boolean));

  const modules = registryModules();
  /*
   * The fallback is created alongside the real components rather than assumed. It is what an
   * endpoint outside `MODULE_BY_PATH` files under, and a fallback that does not itself exist
   * turns a mis-routed ticket into a lost one.
   *
   * It is appended only when it is not already a tag. `admin-module-application` — the default
   * — *is* a Swagger tag on this module (Springfox's controller-derived name for the routes
   * with no explicit tag), so appending it unconditionally planned the same component twice.
   */
  const wanted = [...modules.entries()].map(([name, info]) => ({
    name,
    description: `${info.team} team — ${info.endpoints.length} endpoint(s) in the KPOST Admin Module. Filed automatically by kpost-admin-testbench.`,
  }));
  if (!modules.has(fallback)) {
    wanted.push({
      name: fallback,
      description:
        'Catch-all for endpoints with no owning Swagger tag. A ticket here means the ownership registry needs regenerating (npm run generate), not that this component owns the defect.',
    });
  }
  const missing = wanted.filter((component) => !components.has(component.name));

  console.log(`${LOG} product   "${product}" ${found ? `exists (id ${found.id})` : 'DOES NOT EXIST - will be created'}`);
  console.log(`${LOG} components ${components.size} present, ${missing.length} to create (of ${wanted.length})`);
  for (const component of missing) console.log(`${LOG}   + ${component.name}`);

  if (!APPLY) {
    console.log(`${LOG} DRY RUN - nothing was created. Re-run with --apply --yes to write.`);
    return;
  }

  let productId = found?.id;
  if (!productId) {
    /*
     * `has_unconfirmed: false` keeps the workflow to the two states this bench and the
     * BUGZILLA-UI front end understand. A default milestone and version must be supplied at
     * creation; `unspecified` matches BUGZILLA_VERSION, which the filer sends on every bug.
     */
    const created = await call(`${url}/product?${auth}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        name: product,
        description: 'KPOST Admin Module (tenant administration API). Defects filed automatically by kpost-admin-testbench.',
        version,
        has_unconfirmed: false,
        is_open: true,
      }),
    });
    if (!created.ok) {
      console.log(`${LOG} product create FAILED - ${why(created)}`);
      return;
    }
    productId = created.json?.id;
    console.log(`${LOG} product created - id ${productId}`);
  }

  let made = 0;
  let failed = 0;
  for (const component of missing) {
    const result = await call(`${url}/component?${auth}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        product,
        name: component.name,
        description: component.description,
        // Bugzilla requires a default assignee on a component. The account that owns the API
        // key is used, so triage can reassign from a real inbox rather than a dead one.
        default_assignee: process.env.BUGZILLA_DEFAULT_ASSIGNEE || undefined,
      }),
    });
    if (result.ok) {
      made += 1;
      console.log(`${LOG}   created component "${component.name}"`);
    } else {
      failed += 1;
      console.log(`${LOG}   component "${component.name}" FAILED - ${why(result)}`);
    }
  }
  console.log(`${LOG} components created ${made}, failed ${failed}`);
  if (failed > 0) {
    console.log(
      `${LOG} a "default assignee" error means BUGZILLA_DEFAULT_ASSIGNEE must be set to a real Bugzilla login.`
    );
  }
}

/* ------------------------------------------------------------------ QA Dashboard */

const APPLICATION = { slug: 'kpost-admin', displayName: 'KPOST-ADMIN', ticketPrefix: 'KAD', kind: 'api' };

async function provisionDashboard() {
  const ingest = process.env.DASHBOARD_INGEST_URL;
  const email = process.env.DASHBOARD_ADMIN_EMAIL;
  const password = process.env.DASHBOARD_ADMIN_PASSWORD;

  console.log(`\n${LOG} ===== QA Dashboard =====`);
  if (!ingest) {
    console.log(`${LOG} skipped - DASHBOARD_INGEST_URL is unset (the API base is derived from it)`);
    return;
  }
  // The ingest URL is the only dashboard address this bench is configured with; the admin API
  // lives alongside it under the same origin.
  const base = ingest.replace(/\/api\/ingest\/?$/, '').replace(/\/+$/, '');

  console.log(`${LOG} application "${APPLICATION.slug}" (${APPLICATION.displayName}, kind ${APPLICATION.kind}, prefix ${APPLICATION.ticketPrefix})`);
  console.log(`${LOG} api base    ${base}`);

  if (!APPLY) {
    console.log(`${LOG} DRY RUN - nothing was created. Re-run with --apply --yes to write.`);
    console.log(`${LOG} needs DASHBOARD_ADMIN_EMAIL / DASHBOARD_ADMIN_PASSWORD, or create it in the Applications page by hand.`);
    return;
  }
  if (!email || !password) {
    console.log(`${LOG} cannot create - DASHBOARD_ADMIN_EMAIL / DASHBOARD_ADMIN_PASSWORD are unset.`);
    console.log(`${LOG} create it in the dashboard's Applications page instead, then paste the key into .env.`);
    return;
  }

  const login = await call(`${base}/api/auth/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email, password }),
  });
  if (!login.ok) {
    console.log(`${LOG} admin login FAILED - ${why(login)}`);
    return;
  }
  // The dashboard authenticates the admin API with a session cookie, not a bearer token.
  const cookie = (login.headers?.getSetCookie?.() ?? [])
    .map((value) => value.split(';')[0])
    .join('; ');
  if (!cookie) {
    console.log(`${LOG} admin login returned no session cookie - cannot call the admin API`);
    return;
  }

  const created = await call(`${base}/api/applications`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Cookie: cookie },
    body: JSON.stringify(APPLICATION),
  });

  if (created.status === 409) {
    console.log(`${LOG} application already exists - nothing to do. Reissue its key from the Applications page if needed.`);
    return;
  }
  if (!created.ok) {
    console.log(`${LOG} application create FAILED - ${why(created)}`);
    return;
  }

  console.log(`${LOG} application created - id ${created.json?.id}`);
  console.log('');
  console.log('  ================================================================');
  console.log('   The dashboard shows this API key ONCE and stores only its hash.');
  console.log('   Paste it into .env now as DASHBOARD_API_KEY:');
  console.log('');
  console.log(`   DASHBOARD_API_KEY=${created.json?.apiKey}`);
  console.log('  ================================================================');
}

/* ------------------------------------------------------------------ main */

async function main() {
  if (!APPLY) console.log(`${LOG} DRY RUN - planning only. Add --apply --yes to write.`);
  if (DO_BUGZILLA) await provisionBugzilla();
  if (DO_DASHBOARD) await provisionDashboard();
  console.log(`\n${LOG} done. Verify with: npm run check:integrations`);
}

void main();
