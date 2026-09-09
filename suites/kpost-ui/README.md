# KPost UI Automation Framework

Production-grade UI test automation for the **KPost** ReactJS application
(`http://localhost:3000`), built with **Playwright + TypeScript**.

It is designed to live alongside your existing Playwright **API** automation in
the same ecosystem, sharing tooling, conventions, and CI while remaining an
independent, cleanly-layered UI suite.

---

## Table of contents

1. [Highlights](#highlights)
2. [Architecture & folder structure](#architecture--folder-structure)
3. [Prerequisites](#prerequisites)
4. [Getting started](#getting-started)
5. [Running tests](#running-tests)
6. [Reports & delivery](#reports--delivery)
7. [Core design patterns](#core-design-patterns)
8. [Handling React-specific UI challenges](#handling-react-specific-ui-challenges)
9. [Test data management](#test-data-management)
10. [Writing a new test — quickstart](#writing-a-new-test--quickstart)
11. [CI/CD](#cicd)
12. [Flaky-test prevention playbook](#flaky-test-prevention-playbook)
13. [Conventions & standards](#conventions--standards)

> **Operating the bench day to day** — every command, every report, how to deliver
> results to developers, and what a truncated run looks like: **`OPERATIONS.md`**.

---

## Highlights

- **Page Object Model** with a rich, resilient `BasePage` foundation.
- **Custom fixtures** for page-object injection and session/auth state.
- **Shared authenticated session** via `globalSetup` (login once, reuse everywhere).
- **Cross-browser**: Chromium, Firefox, WebKit (+ mobile emulation).
- **React-aware helpers**: re-render waits, custom dropdowns, virtualized lists, toasts.
- **Deterministic data** via a Factory pattern (unique per test → true parallelism).
- **Network interception/mocking** for empty/error/edge states without seed data.
- **Full diagnostics**: trace, screenshot, and video retained on failure.
- **CI-ready**: sharded GitHub Actions matrix, artifact upload, secrets-based creds.
- **Quality gates**: TypeScript strict mode, ESLint (with Playwright rules), Prettier.

---

## Architecture & folder structure

```text
KPOST-UI-AUTOMATION/
├── .github/
│   └── workflows/
│       └── playwright.yml          # CI: cross-browser matrix, artifacts, secrets
├── src/
│   ├── config/
│   │   ├── env.ts                  # Type-safe, frozen environment config (single source of truth)
│   │   └── global-setup.ts         # One-time UI login → persisted storageState
│   ├── pages/
│   │   ├── BasePage.ts             # Abstract base: safe click/fill, waits, dynamic assertions
│   │   ├── AppShellPage.ts         # KPost chrome: Quick Access launcher, icon rail, logout
│   │   ├── LoginPage.ts            # POM for the two-step auth screen
│   │   ├── HomePage.ts             # POM for the /home pane (Recents/Contacts, KNews, KEcommerce)
│   │   ├── KMailPage.ts            # POM for the mail module (Compose · Inbox · Recents)
│   │   ├── KDirectoryPage.ts       # POM for the directory module (search · list · setup wizard)
│   │   ├── KatchupPage.ts          # POM for the chats module (Recents/Contacts · search · threads)
│   │   ├── SettingsPage.ts         # POM for the settings module (sections · profile · language)
│   │   ├── KEcommercePage.ts       # POM for the marketplace module (merchant catalog)
│   │   ├── KNewsPage.ts            # POM for the news module (feed · ticker · categories)
│   │   └── KPayPage.ts             # POM pinning the not-implemented KPay contract
│   ├── fixtures/
│   │   └── fixtures.ts             # Custom test/expect: injects page objects + session state
│   ├── reporting/
│   │   ├── run-model.ts            # ONE model of a finished run — every report is a projection of it
│   │   ├── bug-report.ts           # Writes BUG_REPORT.json / BUG_REPORT.md (the developer deliverable)
│   │   ├── dev-digest.ts           # Writes DEV_DIGEST.md / .json (one-screen triage)
│   │   └── dashboard-reporter.ts   # Builds the model, writes the files, POSTs to the QA Dashboard
│   ├── utils/
│   │   ├── environment.ts          # Environment LABEL (Local/QA/Staging/Production) — shared with the API bench
│   │   ├── known-defects.ts        # Registry of confirmed app defects (documents, never suppresses)
│   │   ├── logger.ts               # Lightweight leveled logger (report-friendly)
│   │   └── react-helpers.ts        # Re-render/virtualized-list/dropdown/toast helpers
│   ├── data/
│   │   ├── users.json              # Static: invalid-login data-driven scenarios
│   │   ├── posts.json              # Static: canonical post + boundary constants
│   │   └── factories/
│   │       ├── userFactory.ts      # Unique, registrable users (Faker-backed)
│   │       └── postFactory.ts      # Unique posts per test (no collisions in parallel)
│   └── types/
│       └── index.ts                # Shared domain models (User, Post, Toast, …)
├── tests/                             # 64 specs × 4 browser projects = 256 tests
│   ├── auth/
│   │   ├── login.spec.ts           # Valid/invalid/validation (data-driven), runs logged-out
│   │   └── logout.spec.ts          # Logout + protected-route redirect
│   ├── home/home.spec.ts           # Shell, Recents/Contacts tabs, module panels
│   ├── kmail/kmail.spec.ts         # Tabs, counters, and the Write Mail compose/send E2E
│   ├── kdirectory/kdirectory.spec.ts  # Setup wizard + the specs gated on an onboarded account
│   ├── katchup/katchup.spec.ts     # Chats & contacts module
│   ├── settings/settings.spec.ts   # Sections, profile, language picker
│   ├── kecommerce/kecommerce.spec.ts  # Merchant catalog
│   ├── knews/knews.spec.ts         # Feed, ticker, categories, search
│   └── kpay/kpay.spec.ts           # Pins the not-implemented contract (fails the day KPay ships)
├── scripts/
│   └── print-digest.js             # `npm run digest` — prints DEV_DIGEST.md
├── docs/archive/                   # Point-in-time analyses kept for reference
├── OPERATIONS.md                   # Operations manual: commands, reports, delivery, troubleshooting
├── CLAUDE.md                       # Repo working contract (conventions, how to add tests/POMs)
├── BUG_REPORT.md / .json           # (gitignored, generated) the developer deliverable
├── DEV_DIGEST.md / .json           # (gitignored, generated) one-screen triage summary
├── .auth/                          # (gitignored) persisted storageState from globalSetup
├── playwright-report/              # (gitignored) HTML report + traces
├── test-results/                   # (gitignored) traces, videos, screenshots, JSON/JUnit
├── .env.example                    # Template for local secrets (copy → .env)
├── .gitignore
├── .eslintrc.cjs                   # ESLint + @typescript-eslint + eslint-plugin-playwright
├── .prettierrc.json
├── playwright.config.ts            # Central Playwright config (browsers, retries, reporters…)
├── tsconfig.json                   # Strict TS, path aliases (@pages/*, @utils/*, …)
├── package.json
└── README.md
```

### Layering (dependency direction)

```text
tests/  ──uses──▶  fixtures/  ──injects──▶  pages/  ──extends──▶  BasePage
   │                                           │                     │
   └──uses──▶ data/ (factories + json)         └──uses──▶ utils/ (react-helpers, logger)
                                               config/env is imported anywhere it's needed
```

Tests never touch `process.env`, raw selectors, or `page.goto` details directly
— those concerns live in `config`, `pages`, and `fixtures`.

---

## Prerequisites

- **Node.js ≥ 18** (CI uses 20).
- The **KPost app running at `http://localhost:3000`** with seeded test users
  matching your `.env` (or provide equivalents).
- npm (or pnpm/yarn — scripts assume npm).

---

## Getting started

```bash
# 1. Install dependencies
npm install

# 2. Install Playwright browsers (first run only)
npx playwright install

# 3. Configure environment
cp .env.example .env
#    → edit .env with real (non-production) test-user credentials

# 4. Make sure the KPost app is up at http://localhost:3000

# 5. Run the suite
npm test
```

> **Origin note — read this before changing `BASE_URL`.** KPost initialises a
> service worker without checking one exists, so it only runs in a **secure
> context**. `http://localhost:3000` qualifies (browsers treat localhost as
> secure) and so does any `https://` origin. A plain-HTTP LAN address such as
> `http://192.168.0.50:3000` does **not**: `navigator.serviceWorker` is
> `undefined`, the app throws before its first paint, and every test fails
> against a blank page that still answers HTTP 200. Verified 2026-08-27.
>
> When the dev server *is* started with `HTTPS=true` it uses a self-signed
> certificate; `ignoreHTTPSErrors: true` is set globally in
> `playwright.config.ts` and in `global-setup.ts`, so cert warnings won't break
> the run.

---

## Running tests

| Command | What it does |
| --- | --- |
| `npm test` | Full suite, all projects, parallel |
| `npm run test:headed` | Headed mode |
| `npm run test:ui` | Playwright UI mode (time-travel debugging) |
| `npm run test:debug` | Inspector / step debugging |
| `npm run test:chromium` | Chromium only (also `:firefox`, `:webkit`, `:mobile`) |
| `npm run test:smoke` | Tests tagged `@smoke` |
| `npm run test:regression` | Tests tagged `@regression` |
| `npm run test:serial` | `--workers=1` — **required** for app-dependent runs |
| `npm run test:auth` | Only `tests/auth` (also `:home`, `:kmail`, `:kdirectory`, `:katchup`, `:settings`, `:kecommerce`, `:knews`, `:kpay`) |
| `npm run test:list` | Enumerate the 256 tests without executing (reports nothing) |
| `npm run report` | Open the last HTML report (traces, video) |
| `npm run digest` | Print `DEV_DIGEST.md` — the fastest read on a run |
| `npm run codegen` | Record selectors against the app |
| `npm run ci` | typecheck → lint → test (the full gate) |

Tests are **tagged** (`@smoke`, `@regression`, plus an area tag such as `@kmail`)
so CI can run fast smoke checks on every PR and full regression nightly.

> **Run app-dependent suites serially.** KPost allows roughly one active session
> per account, so parallel workers on the shared test user fight each other. Use
> `npm run test:serial` until per-worker accounts exist.

---

## Reports & delivery

Every run produces four things, all projected from **one** run model
(`src/reporting/run-model.ts`) so they cannot disagree:

| Artifact | What it is |
| --- | --- |
| `BUG_REPORT.md` / `.json` | The application defects this run observed, ticket-ready. The deliverable you hand a developer. Same schema as the API bench's. |
| `DEV_DIGEST.md` / `.json` | One screen: verdict, execution table, defects seen. `npm run digest`. |
| `playwright-report/` | Playwright's own HTML report — traces, video, screenshots. `npm run report`. |
| QA Dashboard row | POSTed automatically under application slug **`kpost-ui`**. |

All four are **generated and gitignored** — each run rewrites them whole, so the
repo never carries a stale report. Deliver them per run (see `OPERATIONS.md`).

The dashboard push is fail-safe by construction: unset `DASHBOARD_INGEST_URL` /
`DASHBOARD_API_KEY` → clean no-op; 15-second timeout; an outage warns and never
fails the run; a listing run posts nothing.

**Truncated runs are reported as truncated.** `totalTests` is always what
Playwright *planned* (256), never what happened to finish. If a degraded app kills
a run after ten tests, the payload says `totalTests: 256` with ten accounted for —
the terminal prints a `⚠ run INCOMPLETE` warning, both file reports open with an
INCOMPLETE banner, and the dashboard flags the run. Counts are never rescaled to
close the gap. See `OPERATIONS.md` → *When a run comes back incomplete*.

**Known app defects** are registered in `src/utils/known-defects.ts` and attached
with `noteKnownDefect()`. The annotated test **still fails** — the registry
documents a defect, it never suppresses one.

---

## Core design patterns

### 1. `BasePage` — resilient interaction layer

Every page object extends `BasePage`, which wraps Playwright's auto-waiting with
intent-revealing, hardened methods:

- `click()` / `doubleClick()` — visible + scrolled-into-view + optional nav wait.
- `fill()` / `type()` — clears, fills, and **verifies the committed value** so
  controlled React inputs that revert on re-render fail loudly.
- `isVisible()` (non-throwing) vs `waitForVisible()` / `waitForHidden()`.
- `clickAndWaitForResponse()` — race-free "action + matching API response".
- Thin dynamic assertions (`expectVisible`, `expectText`, `expectCount`, …) that
  delegate to Playwright's **auto-retrying web-first assertions**.

No `waitForTimeout`/hard sleeps anywhere — every wait is condition-based.

### 2. Custom fixtures — injection + session state

`src/fixtures/fixtures.ts` extends Playwright's `test` to:

- Inject ready-to-use page objects (`loginPage`, `homePage`, `kmailPage`, `kdirectoryPage`).
- Apply the **shared authenticated `storageState`** by default, so most tests
  start logged in (fast, and login is off the critical path).
- Provide an **`anonymousPage`** (fresh, logged-out context) and let auth specs
  opt out of shared auth with `test.use({ storageState: { cookies: [], origins: [] } })`.
- Expose seeded `standardUser` / `adminUser` credentials.

Import `test`/`expect` **from the fixtures file**, not from `@playwright/test`.

### 3. Session strategy — `globalSetup`

`global-setup.ts` logs in **once** through the real UI and saves cookies +
localStorage to `.auth/standard.json`. This shares auth *state*, not runtime, so
tests stay independent while avoiding dozens of redundant logins.

---

## Handling React-specific UI challenges

All in `src/utils/react-helpers.ts`, consumed by the page objects:

| Challenge | Helper | Approach |
| --- | --- | --- |
| Re-renders / async state | `waitForAppReady` | `networkidle` + a `requestAnimationFrame` commit tick |
| Controlled inputs reverting | `fillReactInput` / `BasePage.fill` | fill, verify committed value, fall back to sequential typing |
| Custom portalled dropdowns | `selectCustomOption` | open trigger → wait `role=listbox` → click `role=option` → assert close |
| Virtualized/windowed lists | `scrollVirtualizedListToItem` | incrementally scroll viewport until the row mounts |
| Toast notifications | `expectToast` | assert `role=status/alert` text, then wait for auto-dismiss so it can't leak |

> Prefer Playwright's web-first assertions in tests; the coarse `waitForAppReady`
> gate is only for post-navigation "app has settled" moments.

---

## Test data management

Two complementary mechanisms:

1. **Static JSON fixtures** (`src/data/*.json`) — canonical examples, boundary
   constants, and **data-driven scenario tables** (e.g. invalid-login matrix).
2. **Factory pattern** (`src/data/factories/*`) — `buildPost()` / `buildUser()`
   generate **unique, realistic** records per test (timestamp + sequence + Faker).
   Uniqueness is what makes the suite safe to run **fully in parallel** against a
   shared backend — no two tests fight over the same title/email.

Rule of thumb: **read** constants/scenarios from JSON; **create** per-test
mutable instances from factories. Never generate credentials for accounts that
must pre-exist (those come from `env`).

---

## Writing a new test — quickstart

```ts
import { test, expect } from '../../src/fixtures/fixtures';

test('opens the directory module @smoke @kdirectory', async ({ homePage, kdirectoryPage }) => {
  await homePage.open();                    // starts authenticated (shared state)
  await homePage.expectLoaded();

  await kdirectoryPage.openFromLauncher();  // Quick Access — the accessible nav path
  await kdirectoryPage.expectLoaded();      // POM encapsulates all locators
});
```

Checklist for every test: **atomic**, **independent**, **unique data**,
**accessible locators**, **no hard sleeps**, **web-first assertions**.

---

## CI/CD

`.github/workflows/playwright.yml`:

- Triggers on push/PR to `main`/`develop` and manual dispatch.
- **Matrix-shards** the run across `chromium` / `firefox` / `webkit` (parallel
  jobs, `fail-fast: false` for isolated, readable failures).
- `npm ci` + `playwright install --with-deps <project>`.
- Pulls credentials from **GitHub Secrets** (`STANDARD_USER_EMAIL`, etc.).
- Uploads the **HTML report** always, and **traces/videos on failure**.
- Includes a clearly-marked placeholder step to provision the KPost app —
  replace it with your container/`docker compose`/`wait-on` startup.

Retries and worker counts auto-tune for CI via `env.isCI` in the config.

---

## Flaky-test prevention playbook

- ✅ **Web-first assertions** (`expect(locator).toBeVisible()`) — auto-retry.
- ✅ **Action + response** coupling via `clickAndWaitForResponse` — no "clicked
  before request fired" races.
- ✅ **No `waitForTimeout`** in tests (lint-flagged). Only bounded polling inside
  the virtualized-list helper.
- ✅ **Unique data per test** → no cross-test interference.
- ✅ **Deterministic states via mocking** for empty/error/edge feeds.
- ✅ **Auto-dismiss toasts waited out** so notifications don't leak.
- ✅ **Retries on CI only** (2×) so flakiness is visible locally but doesn't fail
  the build on transient blips; `trace: retain-on-failure` makes every failure
  debuggable via `npm run trace`.
- ✅ **Pinned `locale`/`timezoneId`** (en-US/UTC) for stable date/number rendering.
- ✅ **Clean teardown**: `anonymousPage` closes its own context; fixtures scope
  everything per test so nothing leaks between tests.

---

## Conventions & standards

- **Locators:** prefer `getByRole` → `getByLabel` → `getByText` → `getByTestId`.
  Reserve CSS/XPath for genuine last resorts.
- **TypeScript:** `strict` mode, no `any` (lint-warned), path aliases (`@pages/*`).
- **Lint/format:** ESLint (`@typescript-eslint` + `eslint-plugin-playwright`) and
  Prettier. Run `npm run ci` before pushing.
- **Naming:** page objects `*Page.ts`, specs `*.spec.ts`, one journey per describe.
- **Assertions live in tests** (and thin POM assert helpers); page objects model
  behavior, not test intent.

---

### Adapting to the real KPost DOM

The locators here target conventional, accessible KPost markup (roles, labels,
a few `data-testid`s). When wiring against the real app, run
`npm run codegen`, confirm the accessible names/roles, and adjust the locator
declarations at the top of each page object — the tests and helpers won't need
to change.
