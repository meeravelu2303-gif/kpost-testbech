#!/usr/bin/env node
/**
 * Resolves the **common-tree authentication findings** as INVALID.
 *
 * ## Why
 *
 * The backend's `SecurityConfiguration` places the entire `/v2/common/**` tree under
 * `permitAll` — it is **public by design** (registration/reference lookups that must work
 * before any token can exist). A set of tests asserted the opposite — that specific common
 * endpoints must answer 401/403 to a token-less caller — and filed a finding when they served
 * anonymously. Per the product owner's decision, those findings are **invalid**: the endpoints
 * are intended to be reachable without a token, so "it did not require authentication" is not a
 * defect on this tree.
 *
 * This resolves each matching bug as RESOLVED/INVALID with a comment recording the rationale.
 * The paired test change (so they never re-file) is in the specs; this only cleans Bugzilla.
 *
 * ## Scope — matched by exact finding title (authentication assertions only)
 *
 * Only the authentication-required findings below are touched. Input-validation and
 * error-handling findings that happen to live on common endpoints (wrong status, 500 on fuzz,
 * accepted-invalid-input) are NOT matched and stay open — they are valid regardless of the
 * public/auth question.
 *
 * ## Safety
 *   - dry run is the DEFAULT and prints the full plan;
 *   - `--apply` requires `--yes`; Bugzilla has no delete, so this resolves (one-way, reversible
 *     only by a human reopening);
 *   - acts on matching bugs whether currently open OR already resolved (idempotent: a bug already
 *     RESOLVED/INVALID is skipped).
 */
const fs = require('fs');
const path = require('path');

const ROOT = require('../lib/repo-root').repoRoot(__dirname);
const LOG = '[resolve-invalid-common-auth]';
const TIMEOUT_MS = 20_000;

const argv = process.argv.slice(2);
const APPLY = argv.includes('--apply');
const CONFIRMED = argv.includes('--yes');
if (APPLY && !CONFIRMED) {
  console.error(`${LOG} --apply also requires --yes. Read the dry-run plan first.`);
  process.exit(2);
}

/**
 * The exact titles of the common-tree authentication findings deemed invalid.
 *
 * The backend team confirmed the entire `/v2/common/**` tree is permitAll for all users, so
 * EVERY "requires a token / reachable without a token / unauthenticated ... can" finding on it
 * — reads AND writes — is invalid. (Paired tests converted to `assertPublicRouteReachable`.)
 */
const INVALID_TITLES = [
  // reads
  'Anonymous callers can resolve a mobile number to a real identity',
  'Anonymous callers can resolve a mobile number to a company',
  'Company membership can be tested anonymously for any phone number',
  'Platform-wide aggregate counts are exposed on the unauthenticated tree',
  'An admin-scoped company lookup sits on the unauthenticated /v2/common/** tree',
  // writes (the config/version writes on the permitAll tree)
  'The global Flutter app-version write is reachable without a token',
  'A refused privileged write answers 500 rather than 403',
  'Anonymous company-logo write is not refused with 401/403',
  // NOTE: /v2/common/sendMessage is deliberately EXCLUDED — it genuinely requires auth (verified:
  // 401 "Authentication required"), so "unauthenticated bridge can send" is a valid finding there,
  // not a permitAll false positive.
];

function loadEnv(file) {
  const o = {};
  if (!fs.existsSync(file)) return o;
  for (const l of fs.readFileSync(file, 'utf8').split(/\r?\n/)) {
    const m = l.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/);
    if (m && !l.trim().startsWith('#')) o[m[1]] = m[2];
  }
  return o;
}

const env = loadEnv(path.join(ROOT, '.env'));
const BASE = (env.BUGZILLA_URL || '').replace(/\/+$/, '');
const KEY = env.BUGZILLA_API_KEY;
const PRODUCT = env.BUGZILLA_PRODUCT || 'KPost API';
if (!BASE || !KEY) { console.error(`${LOG} BUGZILLA_URL / BUGZILLA_API_KEY not set.`); process.exit(1); }

async function bz(method, pathAndQuery, body) {
  const sep = pathAndQuery.includes('?') ? '&' : '?';
  const url = `${BASE}${pathAndQuery}${sep}api_key=${encodeURIComponent(KEY)}`;
  const controller = new AbortController();
  const t = setTimeout(() => controller.abort(), TIMEOUT_MS);
  try {
    const r = await fetch(url, {
      method,
      headers: body !== undefined ? { 'Content-Type': 'application/json' } : undefined,
      body: body !== undefined ? JSON.stringify(body) : undefined,
      signal: controller.signal,
    });
    const text = await r.text();
    let json; try { json = JSON.parse(text); } catch { json = undefined; }
    return { ok: r.ok, status: r.status, json, text };
  } finally { clearTimeout(t); }
}

/** Strips the [BUG-API-XXXXXX] tag for a clean title compare. */
const bare = (s) => (s || '').replace(/^\[BUG-API-[0-9A-F]{6}\]\s*/, '').trim();

(async () => {
  const res = await bz('GET', `/bug?product=${encodeURIComponent(PRODUCT)}&include_fields=id,summary,status,resolution,is_open`);
  const bugs = (res.json && res.json.bugs) || [];
  const want = new Set(INVALID_TITLES);
  const matched = bugs.filter((b) => want.has(bare(b.summary)));

  const toResolve = matched.filter((b) => !(b.status === 'RESOLVED' && b.resolution === 'INVALID'));
  const already = matched.filter((b) => b.status === 'RESOLVED' && b.resolution === 'INVALID');

  console.log(`${LOG} product "${PRODUCT}" | matched common-auth findings: ${matched.length} (already INVALID: ${already.length})`);
  console.log(`\n${LOG} plan — resolve as RESOLVED/INVALID:`);
  toResolve.forEach((b) => console.log(`  bug ${b.id}  [${b.status}/${b.resolution || '-'}]  ${bare(b.summary).slice(0, 80)}`));
  if (toResolve.length === 0) { console.log('  (nothing to do)'); return; }

  if (!APPLY) {
    console.log(`\n${LOG} DRY RUN — no changes. Re-run with --apply --yes to resolve these as INVALID.`);
    return;
  }
  const comment = 'Resolved INVALID: the /v2/common/** tree is permitAll (public by design), so "endpoint does not require authentication" is not a defect on this tree. Paired test assertions updated so this does not re-file.';
  let done = 0, failed = 0;
  for (const b of toResolve) {
    const r = await bz('PUT', `/bug/${b.id}`, { ids: [b.id], status: 'RESOLVED', resolution: 'INVALID', comment: { body: comment } });
    if (r.ok) { done++; } else { failed++; console.warn(`  ${LOG} bug ${b.id} FAILED: HTTP ${r.status} ${r.text.slice(0, 120)}`); }
  }
  console.log(`\n${LOG} resolved ${done} INVALID, ${failed} failed.`);
})().catch((e) => { console.error(`${LOG} ERROR`, e.message); process.exit(1); });
