# CLAUDE.md — KPost Test Bench (monorepo)

Guidance for Claude Code (and any engineer) working anywhere in this repository. **Read this
file first.** Then read the `CLAUDE.md` of the specific suite you are touching — it holds the
deep, per-suite conventions this file does not repeat. For the story behind any decision
(accounts, hosts, known backend issues, past work), read [`docs/context/`](docs/context/).

## What this is

A **monorepo** for the KPost platform's test automation. It exists so the tooling, conventions,
reporting and defect tracking that the benches share live in one place instead of drifting
across separate repositories.

```
kpost-testbench/
├─ package.json           npm workspaces root (delegating scripts)
├─ suites/
│  ├─ kpost-api/          KPost API bench (Playwright + TS) — has its own CLAUDE.md
│  │  ├─ kmail/           KMail API bench   (sister suite — own CLAUDE.md, config, Bugzilla product)
│  │  └─ admin/           KPost Admin bench (sister suite — own CLAUDE.md, config, Bugzilla product)
│  └─ kpost-ui/           KPost UI bench (Playwright + TS, cross-browser + a11y) — own CLAUDE.md
├─ packages/              shared internal packages (Phase 2 — see README)
└─ docs/context/          accumulated operational knowledge & history (READ THIS)
```

Each **suite** is an independent Playwright project with its own `playwright.config.ts`, source
tree, `.env`, and Bugzilla product. They are separate on purpose: a Playwright *project* means a
**Swagger tag** in the API bench and a **browser** in the UI bench, and their auth artifacts are
not interchangeable. The monorepo co-locates them so they can share plumbing without duplicating
it.

## How to work here

1. **Read the suite's own `CLAUDE.md`** before editing that suite — it carries the load-bearing
   conventions (assertion helpers, payload rules, reporting engine, known API behaviours).
2. **Read [`docs/context/`](docs/context/)** for operational state a fresh session cannot infer:
   which accounts exist, which host is live, what's broken on the backend, what was already
   decided. Start with [`working-constraints.md`](docs/context/working-constraints.md).
3. **Verify before you trust.** The environment moves — hosts change, developers reset the test
   database. A note that names a host, account or endpoint may be stale; check it lives.

## Install & run

One install at the root sets up every suite (npm workspaces):

```bash
npm install                 # then, for the UI bench's browsers: npx playwright install
```

| Command (from root) | Runs |
| --- | --- |
| `npm run test:api` | KPost API suite (~4,600 cases) |
| `npm run test:kmail` | KMail sister suite |
| `npm run test:admin` | KPost Admin sister suite |
| `npm run test:ui` | KPost UI suite (cross-browser) |
| `npm run typecheck` | type-check every suite (`:api` / `:kmail` / `:admin` / `:ui` for one) |

Any suite also runs standalone (`cd suites/kpost-api && npm test`). The suites pin **different
major versions** of shared dev-deps (the API bench requires **TypeScript 7 + faker 10 ESM**, hence
`module: preserve` / `moduleResolution: bundler`; the UI bench uses TS 5.7 + faker 9) — this is
deliberate, npm workspaces installs both, do **not** force-align them.

## The test pyramid — the one rule that governs coverage

The bulk of coverage lives at the **API layer** (fast, stable, cheap): contracts, payloads,
security, business rules, edge cases. The **UI layer is deliberately thin** — only what the
browser can prove that the API cannot: rendering, navigation, forms, client-side session
behaviour, accessibility, cross-browser crashes. ~4,600 API cases sit under ~80 UI cases and that
ratio is correct. **Never re-test API business logic through the UI.**

## Non-negotiable working constraints

From [`docs/context/working-constraints.md`](docs/context/working-constraints.md) — these OVERRIDE
default behaviour:

- **Do NOT commit or push.** The user commits manually. Make the changes only.
- **The Excel workbooks are authoritative for request payloads, not swagger.** When they
  disagree, match the Excel. Swagger gives paths and *documented* behaviour, which frequently
  diverges from actual behaviour. Excel dump locations: [`excel-dumps-location.md`](docs/context/excel-dumps-location.md).
- **Never test with real OTP.** Builders are pinned to `TEST_MOBILE`/`TEST_EMAIL`. **Mock OTP
  `123456` (+ `000000` fallback) is an intentional dev bypass — tests must accept it, never file
  it as a bug, never fail on it.** Only a genuinely un-issued *non-mock* OTP being accepted is a
  finding.
- **Never aim destructive calls at the shared session** — use synthetic / disposable identities.
- **One defect per fault, not per failing test.** Severity is graded deliberately
  (`Critical|Major|Minor|Trivial`) — a report where everything is Critical is a report nobody
  reads. Details in each suite's `CLAUDE.md`.
- **Record what you change** in `docs/context/` (or the session memory) so the next session
  understands the "why" without re-reading the diff. Keep comments concise: trim prose, keep
  safety facts, Excel/API-behaviour facts, and non-obvious "why".

## Reporting & defect tracking

Every suite produces the same artifact family — `BUG_REPORT.md`/`.json`, `DEV_DIGEST.md`/`.json`
(all gitignored, generated per run) — files one ticket per fault into its own Bugzilla product
(`KPost API`, `KMail API`, `KPost Admin`, `KPost UI`) on the shared instance, and pushes to the
shared QA Dashboard under its own app slug. Bugzilla/DB/dashboard secrets live in each suite's
gitignored `.env` (template in `.env.example`) — **never commit them.**

## Current environment & known backend blockers (READ before a run)

*Verify these are still true — they change.* Full detail in
[`docs/context/qa-accounts-949.md`](docs/context/qa-accounts-949.md) and
[`docs/context/kmail-alignment.md`](docs/context/kmail-alignment.md).

- **Target host moves.** Recent hosts: `192.168.0.66`, then the developers' new env
  `192.168.1.38` (both `:8989` KPost auth, `:9081` KMail). Each `.env` sets `BASE_URL` /
  `KMAIL_BASE_URL` / `KPOST_AUTH_BASE_URL`. The DB that a host uses is that host's DB.
- **QA accounts:** `meera949/950/951` (personal) + `meera@m949s/m/m/l.kpost.in` (business
  S/M/L, member caps 10/250/2000). Shared password in `.env`. All authenticate into KPost and
  (token-trust is fixed) open KMail.
- **Known backend issues to REPORT to developers (not "our" bugs; handle in tests):**
  - **`postMail` 500s** — the QA accounts have no mail-server credentials
    (`getMailCredentials` returns all-null). It is a **provisioning gap**, not a payload bug (our
    payloads are Excel-aligned and DTO-accepted). Mail creds are set in developer code/config +
    the mail server, not a DB table we can edit.
  - **Mail read degraded** — `getKmailDashboardMsg` returns "No Data Found" despite non-zero
    counts.
  - **Undeployed endpoints (404 with a valid token):** `generate-presigned-url`,
    `updateMailCountDaysLimit`, `getMailCountDaysLimit`.
  - **No recall endpoint** despite the `recall` field in the contract.
  - **New-host DB schema issues** (`192.168.1.38`): signup rolls back, `adminRegistration` throws
    `SQLGrammarException` — blocks fresh account creation until developers fix the migration.

## Migration status

This monorepo is **Phase 1**: every suite migrated, cleaned of artifacts, and verified
(all four typecheck clean; configs load). **Phase 2** removes the remaining duplication — a shared
`packages/reporting` (the ~2,800-LOC reporting pipeline both benches re-implement "same schema"),
a shared `packages/config`, dependency alignment, and the UI gaps (visual regression + a
test-account pool). See [`docs/context/monorepo-migration.md`](docs/context/monorepo-migration.md)
and the root `README.md`. Auth and API payloads are **not** shared (different mechanics, and the
UI bench correctly does not re-declare the API's Excel-aligned payloads).
