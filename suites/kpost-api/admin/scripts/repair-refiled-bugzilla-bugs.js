#!/usr/bin/env node
/**
 * Repairs tickets that were closed too early and then re-filed as new ones.
 *
 * ## What went wrong
 *
 * `close-fixed-bugzilla-bugs.js` originally closed a ticket on a single run's silence. On
 * 2026-08-24 that resolved 45 tickets; the run that started two minutes later found 22 of
 * those faults again. The filer's dedup matches **open** bugs only, so it could not see the
 * ticket it had just closed and filed a fresh one. The product ends up holding two tickets per
 * fault: an older one wrongly marked RESOLVED/FIXED, and a newer open one.
 *
 * That is wrong in both directions at once — the fix rate is overstated, and the ticket count
 * is inflated by exactly the number of faults that were never fixed.
 *
 * ## What this does
 *
 * For each hash carried by more than one ticket, it keeps the **oldest** ticket as canonical
 * and folds the newer ones into it:
 *
 *   - the canonical ticket is REOPENED if it was resolved (it is still reproducing, so its
 *     RESOLVED/FIXED state is a false record), with a comment explaining why;
 *   - each newer ticket is resolved DUPLICATE pointing at the canonical one.
 *
 * The oldest ticket wins because it holds the original description, comments and repro
 * attachment, and because its alias is the one already quoted in reports and to
 * developers. Renumbering a fault that people have started referring to costs more than it
 * saves.
 *
 * ## Safety
 *
 * Bugzilla's REST API has no delete, only resolve — every write here is one-way. So:
 *
 *   - dry run is the default and prints the complete plan;
 *   - `--apply` is required to write, and refuses to run without `--yes` as well;
 *   - `--limit N` stages the rollout;
 *   - only tickets carrying a `[BUG-API-...]` tag are ever considered, and a group is skipped
 *     unless its members genuinely share one hash;
 *   - re-running is safe: a group already reduced to one open ticket is reported as clean and
 *     left alone.
 *
 * Usage:
 *   node scripts/repair-refiled-bugzilla-bugs.js                 # dry run, full plan
 *   node scripts/repair-refiled-bugzilla-bugs.js --apply --yes --limit 5
 *   node scripts/repair-refiled-bugzilla-bugs.js --apply --yes
 */

const path = require('path');

const ROOT = path.resolve(__dirname, '..');
require('dotenv').config({ path: path.join(ROOT, '.env'), quiet: true });

const LOG = '[repair-refiled]';
const TIMEOUT_MS = 20_000;

/* ------------------------------------------------------------------ arguments */

const argv = process.argv.slice(2);
const APPLY = argv.includes('--apply');
const CONFIRMED = argv.includes('--yes');
const limitArg = argv.indexOf('--limit');
const LIMIT = limitArg !== -1 ? Number(argv[limitArg + 1]) : 0;

if (APPLY && !CONFIRMED) {
  console.error(
    `${LOG} --apply also requires --yes. Bugzilla has no delete, only resolve: every write here\n` +
      `${LOG} is irreversible. Read the dry-run plan first, then re-run with both flags.`
  );
  process.exit(2);
}

const config = {
  url: (process.env.BUGZILLA_URL || '').replace(/\/+$/, ''),
  apiKey: process.env.BUGZILLA_API_KEY,
  product: process.env.BUGZILLA_PRODUCT || 'KPost Admin',
};

if (!config.url || !config.apiKey) {
  console.error(`${LOG} BUGZILLA_URL and BUGZILLA_API_KEY must both be set. Nothing done.`);
  process.exit(2);
}

/* ------------------------------------------------------------------ transport */

async function call(method, endpoint, body) {
  const separator = endpoint.includes('?') ? '&' : '?';
  const url = `${config.url}${endpoint}${separator}api_key=${encodeURIComponent(config.apiKey)}`;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
  try {
    const response = await fetch(url, {
      method,
      headers: { 'Content-Type': 'application/json' },
      body: body ? JSON.stringify(body) : undefined,
      signal: controller.signal,
    });
    const text = await response.text();
    let json;
    try {
      json = JSON.parse(text);
    } catch {
      json = undefined;
    }
    return { ok: response.ok, status: response.status, json, text: text.slice(0, 300) };
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : String(error) };
  } finally {
    clearTimeout(timer);
  }
}

const TAG = /\[(BUG-API-[0-9A-F]+)\]/i;
const CLOSED = new Set(['RESOLVED', 'VERIFIED', 'CLOSED']);

/* ------------------------------------------------------------------ main */

async function main() {
  const search = await call(
    'GET',
    `/bug?product=${encodeURIComponent(config.product)}&include_fields=id,summary,status,resolution&limit=0`
  );
  if (!search.ok) {
    console.error(`${LOG} bug search failed: ${search.error || search.status} ${search.text || ''}`);
    process.exit(1);
  }

  const bugs = (search.json && search.json.bugs) || [];

  /* ---------------------------------------------------------- group by hash */

  const groups = new Map();
  for (const bug of bugs) {
    const match = TAG.exec(bug.summary || '');
    if (!match) continue;
    const hash = match[1].toUpperCase();
    if (!groups.has(hash)) groups.set(hash, []);
    groups.get(hash).push({
      id: bug.id,
      status: bug.status,
      resolution: bug.resolution || '',
      title: (bug.summary || '').replace(TAG, '').trim(),
    });
  }

  const plans = [];
  for (const [hash, members] of groups) {
    if (members.length < 2) continue;
    members.sort((a, b) => a.id - b.id);

    const canonical = members[0];
    const rest = members.slice(1);

    // Already tidy: one open canonical and every newer member folded away.
    const untidy = rest.some((m) => m.resolution !== 'DUPLICATE') || CLOSED.has(canonical.status);
    if (!untidy) continue;

    plans.push({
      hash,
      canonical,
      duplicates: rest.filter((m) => m.resolution !== 'DUPLICATE'),
      reopen: CLOSED.has(canonical.status),
    });
  }

  plans.sort((a, b) => a.canonical.id - b.canonical.id);

  console.log('');
  console.log('='.repeat(78));
  console.log(`${LOG} tickets in "${config.product}" : ${bugs.length}`);
  console.log(`${LOG} distinct faults (hashes)      : ${groups.size}`);
  console.log(`${LOG} faults holding >1 ticket      : ${plans.length}`);
  console.log(
    `${LOG} redundant tickets to fold     : ${plans.reduce((sum, p) => sum + p.duplicates.length, 0)}`
  );
  console.log(`${LOG} canonical tickets to reopen   : ${plans.filter((p) => p.reopen).length}`);
  console.log('='.repeat(78));
  console.log('');

  const planned = LIMIT ? plans.slice(0, LIMIT) : plans;

  for (const plan of planned) {
    console.log(`${plan.hash}  ${plan.title || plan.canonical.title.slice(0, 70)}`);
    console.log(
      `   keep  bug ${plan.canonical.id} (${plan.canonical.status}${plan.canonical.resolution ? '/' + plan.canonical.resolution : ''})` +
        (plan.reopen ? '  -> REOPEN, it is still reproducing' : '  -> already open')
    );
    for (const duplicate of plan.duplicates) {
      console.log(`   fold  bug ${duplicate.id} (${duplicate.status}) -> RESOLVED/DUPLICATE of ${plan.canonical.id}`);
    }
    console.log('');
  }

  if (LIMIT && plans.length > LIMIT) {
    console.log(`… ${plans.length - LIMIT} more fault(s) not shown (--limit ${LIMIT})`);
    console.log('');
  }

  if (!APPLY) {
    console.log('='.repeat(78));
    console.log(`${LOG} DRY RUN — nothing written.`);
    console.log(`${LOG} Re-run with --apply --yes to write${LIMIT ? `, keeping --limit ${LIMIT}` : ''}.`);
    console.log('='.repeat(78));
    return;
  }

  let reopened = 0;
  let folded = 0;
  let failed = 0;

  for (const plan of planned) {
    if (plan.reopen) {
      const result = await call('PUT', `/bug/${plan.canonical.id}`, {
        status: 'CONFIRMED',
        resolution: '',
        comment: {
          body:
            'Reopened — this defect is still reproducing.\n\n' +
            'It was resolved on the strength of a single run in which it did not appear, but a ' +
            'later run observed it again and the automated filer, which can only see open ' +
            'tickets, raised a duplicate. The duplicate has been folded back into this ticket.\n\n' +
            'Reopened by scripts/repair-refiled-bugzilla-bugs.js.',
        },
      });
      if (result.ok) {
        reopened += 1;
        console.log(`${LOG}   ✓ bug ${plan.canonical.id} reopened`);
      } else {
        failed += 1;
        console.error(`${LOG}   ! bug ${plan.canonical.id} not reopened: ${result.error || result.status} ${result.text || ''}`);
        // Without a canonical to point at, folding its duplicates would orphan them.
        continue;
      }
    }

    for (const duplicate of plan.duplicates) {
      const result = await call('PUT', `/bug/${duplicate.id}`, {
        status: 'RESOLVED',
        resolution: 'DUPLICATE',
        dupe_of: plan.canonical.id,
        comment: {
          body:
            `Duplicate of bug ${plan.canonical.id}, which carries the same defect fingerprint ` +
            `(${plan.hash}).\n\n` +
            'This ticket was raised only because the original had been closed prematurely and was ' +
            'therefore invisible to the automated filer, which matches open tickets only. The ' +
            'original has been reopened and remains the record for this fault.\n\n' +
            'Folded by scripts/repair-refiled-bugzilla-bugs.js.',
        },
      });
      if (result.ok) {
        folded += 1;
        console.log(`${LOG}   ✓ bug ${duplicate.id} -> DUPLICATE of ${plan.canonical.id}`);
      } else {
        failed += 1;
        console.error(`${LOG}   ! bug ${duplicate.id} not folded: ${result.error || result.status} ${result.text || ''}`);
      }
    }
  }

  console.log('');
  console.log('='.repeat(78));
  console.log(`${LOG} done — ${reopened} reopened, ${folded} folded as duplicates, ${failed} failed.`);
  console.log('='.repeat(78));
}

main().catch((error) => {
  console.error(`${LOG} fatal:`, error);
  process.exit(1);
});
