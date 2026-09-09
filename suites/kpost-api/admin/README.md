# KPOST Admin Module — API Test Bench

Playwright + TypeScript **API** test automation for the **KPOST Admin Module** — the tenant
(company) administration backend that owns organisation set-up, workplace and HR hierarchies,
employee master data, role postings, product licensing and user onboarding.

No UI or browser code — every test drives `APIRequestContext` directly. The backend is
Java/Spring Boot, which changes nothing: this is black-box HTTP testing from outside.

Its purpose is not regression-guarding a healthy API; it is **adversarial bug-hunting** against
a live backend. Every confirmed defect lands in `BUG_REPORT.md` in a fixed, ticket-ready schema
with a `curl` and a Playwright reproduction attached.

**1,561 tests across 11 Playwright projects**, covering **all 112 operations and 24 functional
tags** in `api.json` — one `test.describe` block per documented endpoint.

## Architecture

```
  tests ──▶ gate ──▶ reports ──▶ dispatch ──▶ publish
    11      run       BUG_REPORT    email      POST BUG_REPORT.json ─▶ QA Dashboard
 projects  validity   DEV_DIGEST    webhook    REST Bug.create      ─▶ Bugzilla
                      executive     tracker
                      traces
```

Everything after `tests` happens automatically in the reporters' `onEnd`, in that order. This
repo **stores nothing and serves no UI**: trends, multi-project rollups, users and roles live in
the separate QA Dashboard, which owns its own database; tickets live in Bugzilla. This bench
holds no database driver — it makes one HTTP POST to each and forgets.

The **run-validity gate** sits in the middle of that: a run that executed nothing (a spec that failed
to load, a crashed worker, `--list`) is rejected, and nothing downstream of it runs. A bench
that cannot run must be loud, never clean — see `reporters/run-validity.ts`.

## Start here

```bash
npm install
cp .env.example .env         # set BASE_URL, TEST_ENV and ADMIN_JWT_SECRET
npm run check:integrations   # ~5s: is the QA Dashboard reachable? is Bugzilla?
npm run test:holidays        # smallest real run, 34 tests
```

**→ [OPERATIONS.md](OPERATIONS.md) is the manual**: every command, every report, how to deliver
them to developers, and troubleshooting. Read it before running the full suite.

Six things worth knowing before your first run:

- **Both publishing targets are provisioned** — the `KPost Admin` Bugzilla product with a
  component per Swagger tag, and the `kpost-admin` QA Dashboard application. Adding a Swagger
  tag means adding a component: `npm run check:integrations` names any that are missing and
  `npm run provision:integrations` creates them (dry run unless given `-- --apply --yes`).
- **`BUGZILLA_DRY_RUN` ships as `true`.** Filing is irreversible — Bugzilla's REST API has no
  delete, only resolve — so real filing is an explicit opt-in, and `BUGZILLA_MAX_FILE` exists to
  stage the first pass.
- **`ADMIN_JWT_SECRET` must match the server's signing key.** This module's login returns no
  token, so the framework mints an HS256 JWT locally. A mismatched secret silently drops the run
  to unauthenticated — which looks like an improvement (fewer defects) and is the opposite.
  Check `DEV_DIGEST.md` does not say `Authentication | NONE`.
- **`npm test` hits a live, stateful backend** — tests create real MongoDB rows, and a full run
  dispatches **3 real SMS** to `TEST_MOBILE` from the `sendOTP` cases.
- **`npm run test:no-onboarding`** skips every account-creating and message-sending spec, for
  environments that must not receive new accounts. It also bypasses the coverage gate, so run
  `npm run audit:vectors` yourself afterwards.
- **`npm test` runs the vector gate first** and refuses to start below 98% mandatory coverage.

## Coverage

| Project | Endpoints | Tests |
| --- | ---: | ---: |
| `workplaceHierarchy` | 25 | 316 |
| `hrHierarchy` | 19 | 243 |
| `users` | 13 | 201 |
| `productLicensing` | 12 | 187 |
| `rolePostings` | 12 | 181 |
| `workplaceLocations` | 7 | 106 |
| `referenceData` | 7 | 78 |
| `designations` | 5 | 76 |
| `employeeMaster` | 5 | 74 |
| `departments` | 5 | 65 |
| `holidayCalendar` | 2 | 34 |
| **Total** | **112** | **1,561** |

Four projects bundle related Swagger tags that share an owning subsystem. Bundling groups only
test *execution* — bug ownership still resolves per path through `MODULE_BY_PATH`, so each tag
routes to its own team.

## Documentation

| Doc | For |
| --- | --- |
| **[OPERATIONS.md](OPERATIONS.md)** | Running, reporting, delivery, troubleshooting |
| [CLAUDE.md](CLAUDE.md) | Architecture, conventions, severity grading, known API behaviours |
| `api.json` | The API contract. Stays at the root — two scripts locate the repo root by it |

`BUG_REPORT.md` and `BUG_REPORT.json` are committed deliverables and are **generated — never
edit them by hand.** `SUITE_SCORECARD.md` is generated on demand by `npm run scorecard`.
