---
name: monorepo-migration
description: "The kpost-testbech monorepo — structure, what was migrated, verification, and the Phase 2 roadmap"
metadata: 
  node_type: memory
  type: project
  originSessionId: b67c8dde-d115-46a2-b4d6-3797ba8e08c1
  modified: 2026-09-09T18:13:52.144Z
---

**A monorepo `D:\TEST-BENCH-AUTOMATIONS\kpost-testbech` now co-locates the API and UI benches**
(user decision, 2026-09-09). Note the folder is spelled **testbech** (missing 'n'); the npm package
name is `kpost-testbench`. It is a fresh git repo (do NOT commit/push — user does that).

### Structure (npm workspaces, `workspaces: ["suites/*"]`)
```
kpost-testbech/
  package.json          root — delegating scripts (test:api|kmail|admin|ui, typecheck:*)
  .gitignore            unified (ignores node_modules, .env, reports, .auth, .bug-cache,
                        BUG_REPORT/DEV_DIGEST, *-build caches, .claude, *.lnk, *.7z)
  README.md             monorepo overview + test-pyramid rule + Phase 2 roadmap
  suites/
    kpost-api/          = old KPOST-AUTOMATION-v1 (source only), kmail/ + admin/ still NESTED inside it
    kpost-ui/           = old KPOST-UI-AUTOMATION (source only)
  packages/             empty placeholder + README for Phase 2 shared packages
  docs/
```

### Phase 1 (DONE + VERIFIED 2026-09-09) — safe lift-and-shift
- Migrated via robocopy, **excluding all artifacts** (node_modules, reports, test-results, .auth,
  .bug-cache, playwright-report, .git, .vscode) → 364 API + 73 UI real source files.
- **Removed unwanted files**: *.lnk shortcut, BUG_REPORT.*/DEV_DIGEST.* (generated), .audit/.dashboard/
  .testbench build caches, .claude, suite-level package-lock.json.
- kmail/admin kept NESTED inside kpost-api (they are self-contained — own src/tests/reporters/config —
  and only share root node_modules via Node upward lookup; splitting them to siblings would ripple into
  root scripts + repo-root.js walk-up, so it was NOT done — lower risk, still works).
- Suite package names renamed → `kpost-api`, `kpost-ui` for clean `-w` workspace targeting.
- **Verified**: `npm install --ignore-scripts` (246 pkgs, wiring OK); typecheck CLEAN for ALL FOUR
  (api, kmail, admin, ui); Playwright configs load with 0 load errors — kmail lists 929 tests, ui
  lists 324 (×4 browsers), api loads clean (~4,600). Suites still run standalone (`cd suites/kpost-api`).
- **Kept separate deliberately** (divergent major versions — DON'T force-align yet): API uses TS 7 +
  faker 10 ESM (its CLAUDE.md requires module:preserve/moduleResolution:bundler); UI uses TS 5.7 +
  faker 9 + Playwright 1.49 (API is 1.62). npm workspaces installs both (nests conflicts). Each suite
  keeps its OWN tsconfig.

### Phase 2 (NOT done — roadmap, documented in root README + packages/README)
1. `packages/reporting` — extract the run-model→BUG_REPORT/DEV_DIGEST→Bugzilla→dashboard pipeline
   (API `reporters/`+`src/reporters/` and UI `src/reporting/` re-implement it "same schema", ~2,800 LOC
   duplicated). Both suites consume one package; Bugzilla product + dashboard slug stay per-suite config.
2. `packages/config` — one typed env loader.
3. Dependency alignment (Playwright/faker/TS/@types/node) where each suite allows.
4. UI gaps: visual-regression baselines + a POOL of test accounts (KPost allows 1 session/account, so
   the UI suite can't parallelize safely on a shared account today).
NOT shared: auth (UI needs browser storageState + encrypted redux blob; API needs bearer token) and
API payloads (UI correctly doesn't re-declare the Excel-aligned builders).

### Self-documenting for a fresh Claude session (added 2026-09-09)
So a new Claude Code session in kpost-testbech starts with full context:
- **Root `kpost-testbech/CLAUDE.md`** (auto-loaded) — monorepo structure, how-to-work, test-pyramid,
  working constraints, reporting, and the CURRENT environment/backend state (hosts incl. 192.168.1.38,
  QA accounts, known blockers: postMail mail-provisioning gap, undeployed 404 endpoints, new-host DB
  schema issue). Points to suite CLAUDE.md files + docs/context/.
- **`kpost-testbech/docs/context/`** — the 8 memory files COPIED into the repo (working-constraints,
  qa-accounts-949, kmail-alignment, excel-alignment-task, excel-dumps-location, bugzilla-tracker-state,
  suite-audit-findings, monorepo-migration) + a README index. This is the committed knowledge base.
- **Banner added to each suite CLAUDE.md** (kpost-api, admin, kpost-ui) pointing to root CLAUDE.md +
  docs/context. KMail conventions live in the kpost-api CLAUDE.md (kmail has no own CLAUDE.md).
All doc cross-links verified to resolve.

### Honest status
Phase 1 = production-grade FOUNDATION, migrated + cleaned + verified. "100% production-grade" is
reached structurally; the shared-package dedup (Phase 2) + UI visual/parallelism gaps remain, and a full
`npm install` (with browser download) + a real suite run against a working backend is the last
end-to-end verification. Source repos KPOST-AUTOMATION-v1 / KPOST-UI-AUTOMATION are untouched (+ .7z
backups exist) so the migration is reversible. See [[working-constraints]] [[kmail-alignment]].
