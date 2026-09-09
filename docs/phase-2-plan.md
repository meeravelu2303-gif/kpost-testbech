# Phase 2 — shared-package extraction & hardening (execution plan)

Phase 1 (the monorepo migration) is done and verified. Phase 2 removes the remaining duplication
and closes the maturity gaps. It is written as a plan rather than executed in one pass because the
biggest item — the reporting dedup — **cannot be verified without a live reporting run**, and the
target backend is currently degraded (see `context/kmail-alignment.md`). Do each step **only when
you can verify it**, in the order below.

## The golden rule (read before touching reporting)

**Never change what feeds a defect's content-hash id.** On the API bench, `computeId` hashes
`classification + title` (or an explicit `dedupeKey`); those ids are the Bugzilla dedup tags. A
subtly different "shared" implementation silently changes **every id** and re-files **every ticket**
on the next run. So every reporting change must be validated by a **dry-run id diff**:

```bash
# before the change
BUGZILLA_DRY_RUN=true npm run test:api   # capture reports/.../BUG_REPORT.json ids
# after the change
BUGZILLA_DRY_RUN=true npm run test:api   # ids MUST be byte-identical
```

If a single id changes and you did not intend it, stop and revert.

## 2.1 `packages/reporting` — the big dedup (do incrementally, verify each step)

The API bench (`suites/kpost-api/reporters/` + `src/reporters/bugReporter.ts` + `src/utils/
bugTracker.ts`) and the UI bench (`suites/kpost-ui/src/reporting/`) each implement the same
pipeline "to the same schema" (~2,800 LOC). They are **independently written**, so this is a
_reconciliation_, not a copy — that is what makes it risky. Extract from **low-risk/pure** to
**high-risk/integrated**:

1. **Taxonomy (pure, safest).** Severity bands, priority mapping, category derivation. Extract to
   `packages/reporting/taxonomy.ts` **only after confirming both benches' tables are identical**;
   otherwise unifying them changes grading. Verify: dry-run id diff unchanged on both benches.
2. **Content-hash id (pure, but load-bearing).** Extract `computeId` **byte-for-byte** — same hash
   inputs, same algorithm. Verify: dry-run id diff is empty on both benches. If it isn't, the two
   benches computed ids differently and you must **not** unify without a deliberate migration.
3. **Bugzilla REST client (I/O).** The HTTP layer (create/search/comment/resolve), parameterized by
   product name. Verify against Bugzilla with `BUGZILLA_DRY_RUN=true` first, then one real file.
4. **Dashboard ingest client (I/O).** The POST-to-dashboard layer, parameterized by app slug.
5. **Leave the run-model/orchestration bench-specific** at first — the API bench's 4-tier reporter
   and the UI bench's single reporter are wired into different fixtures/telemetry; unifying them is
   the last and largest step, worth doing only once 1–4 are stable.

Per-suite config stays per-suite: Bugzilla product (`KPost API` / `KMail API` / `KPost Admin` /
`KPost UI`) and dashboard slug are inputs to the shared package, not baked in.

## 2.2 `packages/config` — shared typed-env helpers (low risk, low value)

Both benches define near-identical `required` / `optional` / `optionalNumber` / `optionalBool`
helpers. Extract them to `packages/config`. Keep each bench's own `env.*.ts` (the variables differ);
only the four helpers move. Wire the package so **both** tsconfig setups resolve it — the API bench
uses TS 7 + `moduleResolution: bundler`, the UI bench TS 5.7 + node; test with `npm run typecheck`
across all suites before and after. Skip if the plumbing costs more than the ~40 lines it saves.

## 2.3 Dependency alignment — BLOCKED, document only

Do **not** force-align the shared dev-deps. The API bench requires **TypeScript 7 + faker 10 ESM**
(its `CLAUDE.md` documents the `module: preserve` / `moduleResolution: bundler` requirement); the UI
bench uses TS 5.7 + faker 9 + Playwright 1.49 (API is 1.62). npm workspaces installs both. Revisit
only when both benches can move to the same major versions without breaking.

## 2.4 UI maturity gaps (need a working app)

- **Visual regression** — add `toHaveScreenshot` baselines for key screens. Needs a stable,
  working app to capture trustworthy baselines (the backend is degraded today).
- **Test-account pool** — KPost allows one active session per account, so the UI suite cannot
  parallelize safely on a shared account. Provision a pool of accounts and a checkout mechanism.
  Blocked until account creation works on the target host (`192.168.1.38` DB schema is broken —
  see `context/qa-accounts-949.md` / `context/monorepo-migration.md`).
- **Kill the dead API-seed scaffold** (`suites/kpost-ui/src/utils/api-helpers.ts` points at a fake
  `/posts` endpoint) — delete it, or wire real KPost seed endpoints once the backend is healthy.

## What NOT to share (settled)

- **Auth** — the UI bench needs a browser `storageState` (+ encrypted redux-persist blob); the API
  bench needs a bearer token. Mechanically different; keep separate.
- **API payloads** — the UI bench correctly does not re-declare the API bench's Excel-aligned
  builders. Keep it that way.
