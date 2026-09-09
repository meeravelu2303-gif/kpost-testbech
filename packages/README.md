# Shared packages

Internal packages consumed by the suites under `../suites/`. Populated in **Phase 2** of the
monorepo migration (see the root `README.md` Roadmap).

Planned:

- **`reporting/`** — the run-model → `BUG_REPORT`/`DEV_DIGEST` → Bugzilla → QA-Dashboard
  pipeline, extracted once and consumed by every suite. Today the KPost API bench
  (`suites/kpost-api/reporters/` + `src/reporters/`) and the KPost UI bench
  (`suites/kpost-ui/src/reporting/`) each re-implement this "to the same schema" — ~2,800 LOC
  of parallel maintenance and the one real duplication the monorepo exists to remove. The
  per-suite Bugzilla product name and dashboard slug remain per-suite configuration.

- **`config/`** — one typed environment-config loader shared by all suites (each suite
  currently has its own near-identical implementation).

**Not** shared: authentication (the UI bench needs a browser `storageState` + encrypted
redux-persist blob; the API bench needs a bearer token — mechanically different) and API
payloads (the UI bench correctly does not re-declare the API bench's Excel-aligned builders).
