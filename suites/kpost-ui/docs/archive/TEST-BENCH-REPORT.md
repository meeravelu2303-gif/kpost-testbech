# KPost UI Automation — Test Bench Analysis Report

**Repository:** `d:\KPOST-PROJECTS\KPOST-UI-AUTOMATION`
**Branch:** `claude/kpost-ui-automation-framework-v1kyw2`
**Report date:** 2026-08-12
**Application under test:** KPost React SPA — `https://localhost:3000`

---

## 0. Update — post-remediation (same day, later)

The analysis below was written from a static read of the repository. The
framework has since been **remediated against the live running app**, which
changed several conclusions. Read this section first; where the two disagree,
this one wins.

**What was done**

- Deleted the four speculative blog page objects (`DashboardPage`,
  `PostCreationPage`, `PostDetailPage`, `ProfilePage`) and the `tests/posts/`,
  `tests/dashboard/`, `tests/profile/` specs — 10 files, 19 fictional tests.
- Added `AppShellPage` (KPost chrome), `KMailPage`, and `KDirectoryPage`, plus
  `tests/kmail/` and `tests/kdirectory/`. Every page-object method is wrapped in
  `test.step()`.
- Rewrote `HomePage` and `LoginPage` against observed DOM, and rewrote
  `tests/home/home.spec.ts`, which had been asserting a UI that does not exist.
- Hardened `env.required()` (no fallbacks) and promoted
  `playwright/no-wait-for-timeout` + `playwright/no-skipped-test` to `error`.

**What live discovery proved — corrections to §4.1**

The fidelity gap was worse than reported: `HomePage` was *also* wrong. It
navigated by clicking sidebar **text**, but KPost's left rail is icon-only
(`div.icon-KP_03-KMail`) with no text, `aria-label`, or `title`. Real navigation
goes through a **Quick Access** ARIA dialog (top bar or `Ctrl+K`) whose entries
have proper accessible names. The top-bar Global Search ships **disabled**.

**Four defects the bench found once it was pointed at the real app**

1. **KMail is unusable** — launching it fires four calls to
   `kmail5.kpostindia.com/kmail5/v2/common/*` that all return **401**, and the
   SPA force-logs-out with "Your session has expired."
2. **An undismissable overlay covers the login Submit button** — typing "@" pops
   `ul.login__domain-list` over it. It swallows pointer events, isn't clickable,
   and ignores Escape and blur. `{ force: true }` does not help. Fixed in-suite
   by keyboard activation; it remains a product UX/accessibility defect.
3. **The icon rail exposes no accessible names at all** — an accessibility
   defect, and the sole reason a CSS selector survives anywhere in the codebase.
4. **`waitForAppReady` was broken for this app** — it gated on `networkidle`,
   which KPost never reaches (it polls news/Firebase/websockets forever). This
   failed *every* navigating test. Removed.

**Framework bugs fixed as a result:** the `networkidle` gate (and the matching
`expectNavigation` option on `BasePage.click`), a 30s navigation budget too tight
for an app whose first paint approaches it, and a global setup that duplicated
the login flow without the overlay workaround.

**Verified run status** (chromium, serial): **10 of 12 smoke tests passed.** The
two failures were the KMail 401 above (correct signal) and one slow-first-paint
flake, since fixed with a dedicated 45s shell-render budget.

**Two new constraints discovered**

- **Parallelism is broken by the shared account.** Full-parallel: 6/12 failed.
  Serial: 8/12 — same code. KPost appears to allow one active session per
  account. Use `--workers=1` until per-worker accounts exist.
- **KDirectory's contact search and directory list are gated** behind a
  first-run setup wizard (Country / Language / vertical). Completing it
  permanently onboards the account, so it was deliberately not done.

**Blocked at time of writing:** the KPost dev server does not compile —
`SyntaxError: D:\KPOST-PROJECTS\KPOST_REACTJS_2023_V1\src\Services\ServiceURL.js:
Identifier 'EndPoint' has already been declared.` The server returns 200 but
serves a webpack error overlay, so no further live runs were possible. That file
is in the application repo, not this one.

---

## 1. Executive summary

The test bench is a **Playwright + TypeScript UI automation framework** built on Page
Object Model + custom fixtures. It is architecturally complete and clean: the static
quality gate (`tsc --noEmit` + `eslint`) passes with **zero errors and zero warnings**,
and **30 tests across 9 spec files** are discovered and parseable on every browser
project.

The gap is not in the framework — it is in **application fidelity**. Only the Auth and
Home surfaces have been modelled against the real KPost app (verified via `codegen` in
commits `563a359` and `8e54efe`). The remaining page objects — Dashboard, Post Creation,
Post Detail, Profile — still model a generic blog/social app (`/dashboard`, `/posts/new`,
`/posts/:id`, `/profile`) rather than the KPost modular super-app that the codebase's own
`KPostModule` type describes (KMail, KDirectory, KEcommerce, KNews, KPay, …).

**Bottom line:** roughly **11 of 30 tests (37%)** target verified application surfaces;
**19 of 30 (63%)** target routes and locators that are conventional guesses and will fail
against the live app until re-modelled. The CI pipeline currently only enforces the static
gate — the E2E jobs are gated off and never run.

| Dimension | Status |
| --- | --- |
| Framework architecture | ✅ Complete, layered, idiomatic |
| Static quality gate (typecheck + lint) | ✅ Passing, clean |
| Test discovery | ✅ 30 tests × 4 projects = 120 executions |
| Locator fidelity to real app | ⚠️ Auth + Home only (~37%) |
| CI end-to-end signal | ❌ Gated off — static stage only |
| Live green-run evidence | ❌ None (no `test-results/`, empty `.auth/`) |

---

## 2. Inventory — what the bench actually contains

### 2.1 Scale

| Metric | Value |
| --- | --- |
| Tracked files | 40 |
| TypeScript source + spec lines | 2,066 |
| Page objects | 7 (`BasePage` + 6 screens) |
| Spec files | 9 |
| Test cases | 30 |
| Browser projects | 4 (chromium, firefox, webkit, mobile-chrome) |
| Total test executions per full run | 120 |
| Runtime dependencies | 0 (all 13 packages are devDependencies) |
| Node target | 20 (`.nvmrc`), engines `>=18` |

### 2.2 Directory map

```
KPOST-UI-AUTOMATION/
├── .github/workflows/playwright.yml   3-stage CI: static → smoke → cross-browser E2E
├── playwright.config.ts               timeouts, 4 projects, 4 reporters, diagnostics
├── src/
│   ├── config/
│   │   ├── env.ts                     frozen, type-safe env object (single source of truth)
│   │   └── global-setup.ts            one-time login → .auth/standard.json storage state
│   ├── pages/
│   │   ├── BasePage.ts        (204)   nav, resilient interactions, assertions, net coupling
│   │   ├── LoginPage.ts       (102)   ✅ verified two-step KPost login
│   │   ├── HomePage.ts         (94)   ✅ verified super-app shell + sidebar
│   │   ├── DashboardPage.ts   (112)   ⚠️ speculative /dashboard feed
│   │   ├── PostCreationPage.ts(114)   ⚠️ speculative /posts/new editor
│   │   ├── PostDetailPage.ts   (76)   ⚠️ speculative /posts/:id
│   │   └── ProfilePage.ts      (65)   ⚠️ speculative /profile
│   ├── fixtures/fixtures.ts   (133)   composition root: POM injection, auth, seedPost
│   ├── utils/
│   │   ├── react-helpers.ts   (134)   app-ready, controlled inputs, portals, virtual lists, toasts
│   │   ├── api-helpers.ts     (107)   API login + post seed/delete (fast arrange)
│   │   └── logger.ts           (41)   LOG_LEVEL-gated structured console logger
│   ├── data/
│   │   ├── factories/postFactory.ts   unique + boundary + batch post builders
│   │   ├── factories/userFactory.ts   unique registrable users
│   │   ├── posts.json                 canonical post + boundary constants
│   │   └── users.json                 invalid-ID scenarios (data-driven)
│   └── types/index.ts          (49)   User, Post, PostVisibility, KPostModule, Toast
└── tests/  auth/ · home/ · dashboard/ · posts/ · profile/
```

### 2.3 Test catalogue (30 tests)

| Spec | Tests | Tags | Fidelity |
| --- | --- | --- | --- |
| `tests/auth/login.spec.ts` | 5 | `@smoke @auth`, `@regression @auth` | ✅ verified |
| `tests/auth/logout.spec.ts` | 2 | `@regression @auth` | ✅ verified |
| `tests/home/home.spec.ts` | 4 | `@smoke @home`, `@regression @home` | ✅ verified |
| `tests/dashboard/dashboard.spec.ts` | 4 | `@smoke`, `@regression` (**no area tag**) | ⚠️ speculative |
| `tests/dashboard/feed-search.spec.ts` | 2 | `@regression @dashboard` | ⚠️ speculative |
| `tests/posts/post-creation.spec.ts` | 5 | `@smoke @posts`, `@regression @posts` | ⚠️ speculative |
| `tests/posts/post-management.spec.ts` | 3 | `@regression @posts` | ⚠️ speculative |
| `tests/posts/post-lifecycle.spec.ts` | 2 | `@regression @posts` | ⚠️ speculative + needs live API |
| `tests/profile/profile.spec.ts` | 3 | `@regression @profile` | ⚠️ speculative |

**Tag distribution:** `@smoke` 7 · `@regression` 23 · `@auth` 7 · `@home` 4 ·
`@posts` 10 · `@profile` 3 · `@dashboard` 2 (4 dashboard tests carry no area tag).

### 2.4 Coverage by test technique

| Technique | Where it's used |
| --- | --- |
| Real end-to-end (app + API) | login happy path, logout, home shell/nav, post-lifecycle |
| Route interception / mocking | dashboard feed states, feed search & pagination, post management, post-creation error, profile update |
| Data-driven iteration | `login.spec.ts` loops `users.json → invalidIds` |
| Boundary-value | max-length title (`posts.json → boundaries.maxTitleLength = 120`) |
| Negative / error-state | wrong password, invalid IDs, 500 on feed, 500 on create, empty-field validation |
| API-shortcut arrange | `seedPost` fixture (create via API, auto-delete in teardown) |

---

## 3. Architecture assessment

### 3.1 Layering — clean and correctly directed

```
tests/  →  fixtures/  →  pages/  →  BasePage  →  utils/  →  config/env
                   ↘  data/factories        ↘  utils/api-helpers
```

No layer reaches upward. Specs never import `@playwright/test` directly (all 9 import
from `src/fixtures/fixtures.ts`), so the auth/POM injection contract holds everywhere.

### 3.2 Strengths

1. **`BasePage` is a genuine resilience layer, not a thin wrapper.** `click()` waits for
   visibility and scrolls into view; `fill()` clears, fills, then *asserts the committed
   value* — which is exactly the failure mode of React controlled inputs;
   `clickAndWaitForResponse()` gives race-free action↔network coupling.
2. **React-specific problems are handled explicitly**, not papered over with sleeps:
   portalled dropdowns (`selectCustomOption`), windowed lists
   (`scrollVirtualizedListToItem`), toast lifecycle including auto-dismiss
   (`expectToast`), and controlled-input reversion (`fillReactInput`).
3. **Exactly one bounded poll in the whole codebase** — inside
   `scrollVirtualizedListToItem`, with an explicit justification comment and a targeted
   ESLint disable. Every other wait is condition-based.
4. **Session strategy is right.** `globalSetup` authenticates once into
   `.auth/standard.json`; specs share auth *state*, not runtime. Auth specs opt out with
   `test.use({ storageState: { cookies: [], origins: [] } })`.
5. **Dual auth strategy with graceful degradation.** `AUTH_MODE=api` is fast and
   deterministic; on failure it logs the reason and falls back to UI login, so an
   unwired API contract degrades performance instead of blocking the suite.
6. **True parallel-safety by construction.** `buildPost()` stamps
   `Date.now()`-sequence-random into every title, so no two workers can collide in a
   shared backend feed.
7. **Worker-scoped `apiAuth`** — one API login per worker rather than per test, with
   test-scoped `seedPost` layered on top and best-effort teardown deletion.
8. **Diagnostics are correctly tuned:** trace/screenshot/video all `retain-on-failure`,
   4 reporters (list, html, json, junit) plus `github` only on CI.
9. **Determinism defaults:** `locale: en-US`, `timezoneId: UTC`, and an
   `x-automated-test: kpost-playwright` header so app logs can segregate bot traffic.
10. **Secrets discipline:** no credential appears in tracked source; `.env`, `.auth/`,
    and `*.storageState.json` are all gitignored; CI pulls from GitHub Secrets.

### 3.3 Verified health check (run for this report)

```
npx tsc --noEmit              → exit 0, no output
npx eslint . --ext .ts        → exit 0, no errors, no warnings
npx playwright test --list    → Total: 30 tests in 9 files
```

---

## 4. Findings

### 4.1 High — application fidelity gap (63% of tests)

`DashboardPage`, `PostCreationPage`, `PostDetailPage`, and `ProfilePage` were scaffolded
before the real app was inspected. They assume routes `/dashboard`, `/posts/new`,
`/posts/:id`, `/profile` and semantics like `getByRole('feed')`, a "Create post" button,
a tag-chip input, and a visibility dropdown.

The application the repo has actually verified is a different product: a modular super-app
that lands on `/home` with a sidebar of KMail, Katchup, Kall, KDirectory, KCloud,
KBooking, KEcommerce, KPay, KNews, Broadcast, Settings — as enumerated in
[src/types/index.ts:14-27](src/types/index.ts#L14-L27).

*Impact:* 19 tests will fail on first contact with the live app, and the failures will be
locator timeouts rather than product defects — the most expensive kind of false signal.

*Fix:* run `npm run codegen`, walk the real modules, and re-model these four page objects
(or replace them with module-specific POMs such as `KMailPage`, `KDirectoryPage`). The
tests, fixtures, and helpers are locator-agnostic and should need little or no change.

### 4.2 High — CI produces no end-to-end signal

Both the `smoke` and `e2e` jobs are gated on `if: ${{ vars.KPOST_START_CMD != '' }}`
([.github/workflows/playwright.yml:62](.github/workflows/playwright.yml#L62) and
[:123](.github/workflows/playwright.yml#L123)). Until that repository variable is set,
every push and PR runs the `static` job only. The gate keeps PRs green, but green
currently means "it compiles and lints", not "it works".

*Fix:* set the `KPOST_START_CMD` repository variable to whatever boots KPost on
`https://localhost:3000` (container, or build + serve), and add the four user secrets.

### 4.3 Medium — `required()` never actually fails

[src/config/env.ts:18-27](src/config/env.ts#L18-L27) throws only when a variable is
missing *and* no fallback is supplied — but all four credential lookups pass a fallback:

```ts
email: required('STANDARD_USER_EMAIL', 'standard.user@kpost.test'),
```

So a missing credential silently authenticates as a non-existent placeholder user, and
the failure surfaces much later as an opaque login timeout in `globalSetup`.

*Fix:* drop the fallbacks for the four credential variables so the run fails fast at
config load with a clear message, or split into `required()` (no fallback allowed) and
`optional()`.

### 4.4 Medium — the "no hard waits" rule is documented as enforced but only warns

`CLAUDE.md` states `page.waitForTimeout` is "banned in tests (ESLint enforces)", but
[.eslintrc.cjs:35](.eslintrc.cjs#L35) sets `playwright/no-wait-for-timeout` to `'warn'`.
`npm run lint` will not fail on a new hard wait. `playwright/no-skipped-test` is likewise
`'warn'`, so a committed `test.skip` also passes the gate.

*Fix:* promote both to `'error'` (the codebase is already clean, so this costs nothing
today and prevents regression tomorrow).

### 4.5 Medium — `webServer` does not start anything

[playwright.config.ts:119-127](playwright.config.ts#L119-L127) runs
`echo "Assuming KPost dev server is already running..."` as its command. Playwright still
polls the URL for 120s, so if the app is down locally the whole run fails at setup with a
webServer timeout rather than a clear "start the app first" message.

*Fix:* either wire the real dev-server command, or drop `webServer` and let
`globalSetup` fail with its already-good diagnostic message.

### 4.6 Low — tagging and matrix inconsistencies

- 4 tests in `dashboard.spec.ts` carry `@smoke`/`@regression` but **no area tag**, so
  `--grep @dashboard` misses them.
- The `mobile-chrome` project is defined in the config but absent from the CI matrix
  (`[chromium, firefox, webkit]`) — it will only ever run locally.
- `npm run clean` deletes `allure-results`/`allure-report`, but no Allure reporter is
  configured. Harmless, but it implies a reporting capability that doesn't exist.
- No `test.step()` anywhere — the HTML report shows flat action lists instead of named
  business steps, which costs readability on multi-stage journeys.

### 4.7 Low — coverage dimensions not yet present

No accessibility scanning (e.g. `@axe-core/playwright`), no visual regression
(`toHaveScreenshot`), no performance budgets, no file upload/download coverage, no
multi-role scenarios (the `adminUser` fixture and `admin` credentials exist but **no test
consumes them**), and no `KPostModule`-level tests beyond the KMail navigation smoke.

### 4.8 Informational — local environment state

The working `.env` sets `AUTH_MODE=ui` and `HEADLESS=false` with real
`@kpostindia.com` test credentials. The file is correctly gitignored and no credential
leaks into tracked source. `.auth/` is empty and `test-results/` does not exist, so no
successful authenticated run has been recorded on this machine yet — consistent with the
finding that the app-dependent surfaces are still unverified.

---

## 5. Requirement coverage scorecard

| Capability | Status | Evidence |
| --- | --- | --- |
| Page Object Model | ✅ | 7 POMs, abstract `BasePage`, `path` contract |
| Custom fixtures / DI | ✅ | 9 fixtures incl. worker-scoped `apiAuth` |
| Session reuse | ✅ | `globalSetup` → `.auth/standard.json` |
| Cross-browser | ✅ | chromium, firefox, webkit, mobile-chrome |
| React-aware waiting | ✅ | `react-helpers.ts`, zero hard waits outside one bounded poll |
| Data factories | ✅ | `buildPost`, `buildPosts`, `buildMaxLengthTitlePost`, `buildUser` |
| Static fixtures | ✅ | `posts.json`, `users.json` |
| Network mocking | ✅ | 8 tests use `page.route` |
| API-shortcut arrange + teardown | ✅ | `apiLogin`, `apiCreatePost`, `apiDeletePost`, `seedPost` |
| Reporting | ✅ | list + html + json + junit (+ github on CI) |
| Failure diagnostics | ✅ | trace / screenshot / video retain-on-failure |
| Type safety | ✅ | strict, `noUnusedLocals`, `noImplicitReturns`, path aliases |
| Lint / format gates | ✅ | ESLint + Playwright plugin, Prettier, `npm run ci` |
| CI pipeline defined | ✅ | 3 stages, concurrency cancel, nightly cron, artifacts |
| CI actually running E2E | ❌ | gated on unset `KPOST_START_CMD` |
| Locators verified vs live app | ⚠️ | Auth + Home only |
| Accessibility / visual / perf | ❌ | not present |
| Admin / multi-role coverage | ❌ | fixture exists, unused |

---

## 6. Recommended next steps (in order)

1. **Re-model the four speculative page objects against the live app** via
   `npm run codegen`. This unblocks 19 tests and is the single highest-value action.
2. **Set `KPOST_START_CMD` + the four GitHub Secrets** so `smoke` and `e2e` actually run;
   until then CI is a compile check.
3. **Remove the credential fallbacks in `env.ts`** so misconfiguration fails at startup
   with a readable message.
4. **Promote `no-wait-for-timeout` and `no-skipped-test` to `'error'`** to make the
   documented rules real.
5. **Fix `webServer`** — real boot command, or remove it.
6. **Add area tags to the 4 untagged dashboard tests**; decide whether `mobile-chrome`
   belongs in the CI matrix.
7. **Record a first green authenticated run** locally (`npm run test:smoke`) and commit
   nothing from `.auth/` — the goal is evidence, not artifacts.
8. **Then extend coverage:** admin-role scenarios, per-module KPost tests (KMail,
   KDirectory, KEcommerce), accessibility scan on key screens, `test.step()` for
   report readability.

---

*Generated from a full read of all 40 tracked files, plus live `tsc --noEmit`,
`eslint`, and `playwright test --list` runs against the working tree.*
