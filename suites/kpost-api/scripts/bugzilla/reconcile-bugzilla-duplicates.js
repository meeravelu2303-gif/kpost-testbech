#!/usr/bin/env node
/**
 * Reconciles the per-test tickets already filed in Bugzilla against the new grouped defect ids.
 *
 * Why this exists. The bench used to file one ticket per *failing test*, which put 1283 open
 * bugs into a product describing roughly 565 real defects. Grouping fixes the flow of new
 * tickets; it cannot retroactively fix what is already filed. This script closes that gap:
 * for every group of old tickets that describe one defect, it keeps a canonical bug and marks
 * the rest RESOLVED/DUPLICATE pointing at it.
 *
 * **How an old ticket is mapped to a new defect id.** The old summary is
 * `[BUG-API-<oldhash>] <title>` and the old description opens with `Classification: <cls>`.
 * The new fault fingerprint is `<cls> :: <title>` — both halves are recoverable from the bug
 * itself, so no local ledger from the original run is needed and the mapping is reproducible
 * by anyone with read access to the product.
 *
 * **Safety.** Bugzilla's REST API has no delete, only resolve — every write here is one-way.
 * So:
 *   - dry run is the default and prints the complete plan;
 *   - `--apply` is required to write, and it refuses to run without `--yes` as well;
 *   - `--limit N` stages the rollout, and re-running is safe because an already-resolved
 *     duplicate is skipped rather than re-resolved;
 *   - a bug whose summary carries no `[BUG-API-…]` tag is never touched — this script only
 *     ever acts on tickets this bench filed.
 *
 * Usage:
 *   node scripts/reconcile-bugzilla-duplicates.js                  # dry run, full plan
 *   node scripts/reconcile-bugzilla-duplicates.js --limit 20       # dry run, first 20 groups
 *   node scripts/reconcile-bugzilla-duplicates.js --apply --yes --limit 20
 */

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const ROOT = require('../lib/repo-root').repoRoot(__dirname);
require('dotenv').config({ path: path.join(ROOT, '.env'), quiet: true });

const LOG = '[reconcile]';
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
  product: process.env.BUGZILLA_PRODUCT || 'KPost API',
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
    return { ok: response.ok, status: response.status, json, text };
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : String(error) };
  } finally {
    clearTimeout(timer);
  }
}

/* ------------------------------------------------------------------ mapping */

/** Must match `computeId` in `src/utils/bugTracker.ts` for grouping mode `fault`. */
function faultId(classification, title) {
  const digest = crypto.createHash('sha1').update(`${classification} :: ${title}`).digest('hex');
  return `BUG-API-${digest.slice(0, 6).toUpperCase()}`;
}

const SUMMARY_TAG = /^\[(BUG-API-[0-9A-F]{6})\]\s*(.+)$/;

/**
 * The classification the ticket was filed under.
 *
 * Both the old and new description templates open with `Classification: <value>`. A ticket
 * whose description cannot be read — restricted, or filed by something other than this bench —
 * returns null and is left untouched.
 */
function classificationOf(description) {
  const match = /^Classification:\s*(.+)$/m.exec(description || '');
  return match ? match[1].trim() : null;
}

/* ------------------------------------------------------------------ main */

async function main() {
  console.log(`${LOG} product="${config.product}" mode=${APPLY ? 'APPLY (writes)' : 'DRY RUN'}`);

  /*
   * `include_fields` keeps the payload small: a four-figure product with full descriptions is
   * tens of megabytes. The first comment carries the description, so it is fetched separately
   * and only for the bugs that matter.
   */
  const search = await call(
    'GET',
    `/bug?product=${encodeURIComponent(config.product)}&status=__open__&include_fields=id,summary,status,resolution`
  );
  if (!search.ok) {
    console.error(`${LOG} search failed: ${search.error || search.status} ${search.text || ''}`);
    process.exit(1);
  }

  const bugs = (search.json && search.json.bugs) || [];
  console.log(`${LOG} ${bugs.length} open bug(s) in the product`);

  const tagged = [];
  for (const bug of bugs) {
    const match = SUMMARY_TAG.exec(bug.summary || '');
    if (!match) continue;
    tagged.push({ id: bug.id, oldHash: match[1], title: match[2].trim() });
  }
  console.log(`${LOG} ${tagged.length} carry a [BUG-API-…] tag and are in scope`);
  if (tagged.length === 0) return;

  /*
   * The description lives in the first comment. Fetched in batches so a large product does not
   * open a thousand concurrent sockets at a Bugzilla that is usually a single Perl process.
   */
  const BATCH = 25;
  const groups = new Map();
  let unmapped = 0;

  for (let i = 0; i < tagged.length; i += BATCH) {
    const slice = tagged.slice(i, i + BATCH);
    const results = await Promise.all(
      slice.map((entry) => call('GET', `/bug/${entry.id}/comment`))
    );

    for (let j = 0; j < slice.length; j += 1) {
      const entry = slice[j];
      const result = results[j];
      const comments =
        (result.json &&
          result.json.bugs &&
          result.json.bugs[String(entry.id)] &&
          result.json.bugs[String(entry.id)].comments) ||
        [];
      const classification = classificationOf(comments[0] && comments[0].text);
      if (!classification) {
        unmapped += 1;
        continue;
      }

      const newId = faultId(classification, entry.title);
      if (!groups.has(newId)) groups.set(newId, { newId, classification, title: entry.title, bugs: [] });
      groups.get(newId).bugs.push(entry);
    }
    process.stdout.write(`\r${LOG} read ${Math.min(i + BATCH, tagged.length)}/${tagged.length} descriptions`);
  }
  process.stdout.write('\n');

  if (unmapped > 0) {
    console.log(`${LOG} ${unmapped} bug(s) had no readable Classification line — left untouched`);
  }

  const duplicateGroups = [...groups.values()]
    .filter((group) => group.bugs.length > 1)
    .sort((a, b) => b.bugs.length - a.bugs.length);

  const totalDuplicates = duplicateGroups.reduce((sum, group) => sum + group.bugs.length - 1, 0);

  console.log('');
  console.log(`${LOG} ${groups.size} distinct defect(s) behind ${tagged.length} ticket(s)`);
  console.log(`${LOG} ${duplicateGroups.length} group(s) hold duplicates; ${totalDuplicates} ticket(s) would be resolved`);
  console.log('');

  const planned = LIMIT > 0 ? duplicateGroups.slice(0, LIMIT) : duplicateGroups;
  if (LIMIT > 0) console.log(`${LOG} --limit ${LIMIT}: acting on the ${planned.length} largest group(s) only\n`);

  let resolved = 0;
  let failed = 0;

  for (const group of planned) {
    // Lowest bug id is canonical: it is the oldest, so its comment history is the longest and
    // any human discussion already attached to this defect is most likely to be on it.
    const ordered = [...group.bugs].sort((a, b) => a.id - b.id);
    const canonical = ordered[0];
    const duplicates = ordered.slice(1);

    console.log(
      `${LOG} ${group.newId} — ${duplicates.length} duplicate(s) → keep #${canonical.id}  "${group.title.slice(0, 70)}"`
    );

    if (!APPLY) continue;

    for (const duplicate of duplicates) {
      const result = await call('PUT', `/bug/${duplicate.id}`, {
        ids: [duplicate.id],
        status: 'RESOLVED',
        resolution: 'DUPLICATE',
        dupe_of: canonical.id,
        comment: {
          body:
            `Resolved as a duplicate of bug ${canonical.id} by the KPOST bench reconciliation pass.\n\n` +
            `This ticket and ${duplicates.length} other(s) describe one defect (${group.newId}): ` +
            `"${group.title}". They were filed separately because the bench previously assigned ` +
            `one ticket per failing test rather than one per defect. Bug ${canonical.id} carries ` +
            `the full affected-endpoint list.`,
        },
      });

      if (result.ok) {
        resolved += 1;
      } else {
        failed += 1;
        console.error(
          `${LOG}   ! bug ${duplicate.id} not resolved: ${result.error || result.status} ${(result.text || '').slice(0, 160)}`
        );
      }
    }
  }

  console.log('');
  if (APPLY) {
    console.log(`${LOG} done — ${resolved} resolved as duplicate, ${failed} failed`);
  } else {
    console.log(`${LOG} DRY RUN — nothing was written.`);
    console.log(`${LOG} Re-run with --apply --yes to execute, ideally with --limit first.`);
  }
}

main().catch((error) => {
  console.error(`${LOG} unexpected failure:`, error);
  process.exit(1);
});
