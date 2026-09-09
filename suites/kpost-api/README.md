# KPOST Test Automation

Playwright + TypeScript **API** test automation for the KPOST Communication Platform.
No UI or browser code — every test drives `APIRequestContext` directly.

Its purpose is not regression-guarding a healthy API; it is **adversarial bug-hunting** against
a live backend. Every confirmed defect lands in a ticket-ready `BUG_REPORT.md` with a `curl` and
a Playwright reproduction attached, and is filed into Bugzilla.

## Three suites, one repository

This repo hosts **three independent test suites** that share one framework and one `node_modules`.
They target different backend services, authenticate through KPOST identity, and file to
**separate Bugzilla products** so their defects route to different developers.

| Suite | Location | Target service | Bugzilla product | Run |
| --- | --- | --- | --- | --- |
| **KPost API** | repo root (`src/`, `tests/`) | `BASE_URL` | `KPost API` | `npm test` |
| **KMail API** | [`kmail/`](kmail/) | `KMAIL_BASE_URL` | `KMail API` | `npm run test:kmail` |
| **KPost Admin** | [`admin/`](admin/) | admin `BASE_URL` | `KPost Admin` | `npm run test:adminmodule` |

The KMail and admin suites are self-contained Playwright projects under `kmail/` and `admin/`;
they resolve their dependencies from the root `node_modules` (identical versions) via Node's
upward resolution, so there is nothing separate to install. KMail logs in against
`KPOST_AUTH_BASE_URL` (a KPOST account — users are shared) and presents that token to the KMail
service. The **admin module** (112 endpoints: org hierarchy, employees, departments, role
postings, licensing) mints its **own** HS256 token from `ADMIN_JWT_SECRET` (its login returns
identity only, not a bearer token) — see [`admin/CLAUDE.md`](admin/CLAUDE.md). Against a
production admin target, run refusal-path/read-only only (`npm run test:no-onboarding` from
inside `admin/`).

## Repository layout

```
.                        ── KPost API suite (the root project)
├── src/                 framework: fixtures, clients, payloads, schemas, reporters, utils
├── tests/               one Playwright project per Swagger tag (hand-written specs)
├── reporters/           the tier 2–4 reporting engine + dispatchers
├── scripts/             grouped by purpose:
│   ├── generate/          swagger.json / data → generated registries
│   ├── bugzilla/          close-fixed, reconcile-duplicates, verify-open, repair-refiled
│   ├── report/            print-digest, print-executive-path
│   ├── auth/  auth-check/ login diagnosis + the pre-run credential check
│   ├── sql/               one-off DBA repairs (run by hand, never by the suite)
│   └── lib/               repo-root resolver (find root by swagger.json, not __dirname)
├── data/                checked-in generator inputs (not run artifacts)
├── docs/                reference docs + archive
├── swagger.json         the KPost API contract (stays at root — scripts locate root by it)
│
└── kmail/               ── KMail API suite (self-contained sub-project)
    ├── src/  tests/  reporters/
    ├── kmail.swagger.json
    └── playwright.config.ts
```

Generated/transient output (`reports/`, `test-results/`, `.auth/`, `DEV_DIGEST.*`, the
`.*-build/` dirs) is git-ignored and removed by `npm run clean`. `BUG_REPORT.md`,
`BUG_REPORT.json` and `SUITE_SCORECARD.md` are **committed deliverables** — generated, never
edited by hand.

## Start here

```bash
npm install
cp .env.example .env         # KPost API: BASE_URL, TEST_ENV, QA_* credentials
npm run auth:check           # confirm the QA account authenticates before a full run
npm run test:common          # smallest useful KPost run, ~1.5 min
```

For KMail, configure `kmail/.env` (`KMAIL_BASE_URL`, `KPOST_AUTH_BASE_URL`, `BUGZILLA_PRODUCT=KMail API`)
then:

```bash
npm run test:kmail:list      # collect the KMail suite without running
npm run test:kmail           # run it (files to the KMail API product)
```

**→ [OPERATIONS.md](OPERATIONS.md) is the manual** for the KPost suite: every command, every
report, how to deliver them, and troubleshooting. Read it before the full run.

Two things worth knowing before your first KPost run:

- `npm test` hits a **live, stateful** backend — tests create real rows.
- `npm run test:no-signup` skips registration specs for environments that must not receive new
  accounts. It also skips the coverage gate, so run `npm run audit:vectors` yourself.

## Common commands

| | KPost API | KMail API |
| --- | --- | --- |
| Full run | `npm test` | `npm run test:kmail` |
| List only | `npm run test:list` | `npm run test:kmail:list` |
| Type-check | `npm run typecheck` | `npm run typecheck:kmail` |
| Close fixed tickets | `npm run bugzilla:close-fixed` | (run from `kmail/`) |
| Verify open tickets | `npm run verify:open` | (run from `kmail/`) |

## Documentation

| Doc | For |
| --- | --- |
| **[OPERATIONS.md](OPERATIONS.md)** | Running, reporting, delivery, troubleshooting (KPost) |
| [CLAUDE.md](CLAUDE.md) | Architecture, conventions, severity grading, known API behaviours |
| [kmail/README.md](kmail/README.md) | The KMail suite's own guide |
| [admin/CLAUDE.md](admin/CLAUDE.md) | The KPost Admin Module suite — its JWT-mint auth model and conventions |
| [docs/V1_DECOMMISSION_RISK.md](docs/V1_DECOMMISSION_RISK.md) | **Open risk** — deprecated V1 routes still mounted |
| [docs/api.json](docs/api.json) | QA tracker export: real request/response bodies |
