# CLAUDE.md — KPost UI Automation

> **Monorepo note.** This is the UI suite in the **`kpost-testbench`** monorepo, at
> `suites/kpost-ui/`. Read the **root [`../../CLAUDE.md`](../../CLAUDE.md)** for cross-cutting rules
> — especially the **test pyramid** (the UI layer is deliberately thin; do not re-test API business
> logic here) — the current environment/backend state, and
> **[`../../docs/context/`](../../docs/context/)** for history. This suite's own conventions are
> below.

Guidance for working in this repository (for both humans and AI assistants).
Read this before adding tests or page objects so the suite stays consistent.

## What this is

A Playwright + TypeScript **UI** automation framework for the KPost React app
(`http://localhost:3000`), built to sit alongside the existing Playwright API
automation. Architecture is Page Object Model + custom fixtures. See `README.md`
for the full tour, `OPERATIONS.md` for running it and delivering its reports,
`docs/archive/TEST-BENCH-REPORT.md` for the archived state-of-the-bench analysis,
and this file for the working contract.

**Current size:** 11 page objects · 15 spec files · 81 tests · 4 browser projects
(chromium, firefox, webkit, mobile-chrome) = **324 tests planned per full run**.
That 324 is the number every report calls `totalTests`; confirm it with
`npm run test:list` after adding specs.

## The app under test — verified ground truth

Everything in this section was read off the running app on **2026-08-12**, not
assumed. If you change a locator, verify it the same way.

### ⚠ The environment moved on 2026-09-03 — and needs two changes before it runs

The old setup is gone: `localhost:3000` no longer serves and `192.168.1.176:8989`
answers on no port. The UI is now at **`https://192.168.0.83:3001`** (self-signed
cert; `ignoreHTTPSErrors` already covers it) and the backend holding this bench's
accounts is **`192.168.2.94:8989`** — the same one the API bench points at.

They are not yet connected to each other. Measured 2026-09-03:

| Check | Result |
| --- | --- |
| `192.168.2.94:8989` reachable from the bench | ✅ 200, full country list (ICMP is firewalled; TCP is fine) |
| The bench's 3 accounts exist there | ✅ Qa Alpha, Meera Velu, Qa Disposable |
| What the UI at `.83` actually calls | ❌ `devapi2.kpostindia.com` |
| Those accounts on devapi2 | ❌ `fetchUserDetails` → 500 for every id form |

So login fails today at step 1, and no test can run. **Two changes are needed, and
both are required — either alone is not enough.** Both were verified by rerouting
the UI's calls to the real backend and watching what happened:

1. **Point the UI at `192.168.2.94:8989` through a SAME-ORIGIN `/api` proxy** —
   not directly. Direct calls fail twice over: the backend answers `403 Invalid
   CORS request` to anything carrying an `Origin` header, and the page is HTTPS
   while the backend is HTTP, which browsers block as mixed content (observed
   live: `Mixed Content: … requested an insecure resource`). A dev-server proxy
   makes the call same-origin and server-to-server, which sidesteps both — the
   `setupProxy.js` pattern already in the `KPOST_REACTJS_2023_V1` tree.
2. **Fix KPOST-AUTH-004** (Bugzilla #93). `192.168.2.94`'s `common/*` controller
   returns `"status":"Success"` exactly as the old backend did, so pointing the
   UI at it *without* the casing fix reproduces the blocker immediately: country
   list empty, KPOST ID field disabled. Confirmed by direct test.

With both applied, the flow gets through: country resolves to `+91 India`, the ID
field enables, the password step appears, and `POST /v2/signupLogin/userLogin/`
returns 200 with an access token. Reaching `/home` could not be confirmed from
here, because the app also calls `kmail5.kpostindia.com`, which 401s a token
issued by a different backend — an artefact of the simulation, not a proven
defect. Re-verify it once the environment is properly wired.

### ⚠ `BASE_URL` must be a SECURE CONTEXT — this is the single biggest footgun

**KPost does not run on a plain-HTTP LAN address.** Verified 2026-08-27, headless
chromium, same dev server, same moment:

| Origin | Result |
| --- | --- |
| `http://localhost:3000` | Renders normally. Login form present. **Zero** console errors. |
| `http://192.168.0.50:3000` | **Blank white page.** Empty `<body>`, no inputs, no buttons. |

The blank page throws two uncaught errors: `TypeError: Cannot read properties of
undefined (reading 'addEventListener')`, then `FirebaseError: Messaging: This
browser doesn't support the API's required to use the Firebase SDK
(messaging/unsupported-browser)`. Both have one cause — a bare IP over HTTP is
**not a secure context**, so `navigator.serviceWorker` is `undefined`, the app
calls `.addEventListener` on it unguarded, and the render dies. `localhost` is
treated as secure even over HTTP, which is why it works there.

So `BASE_URL` must be **`http://localhost:3000`**, or an `https://` origin if the
dev server is started with `HTTPS=true`. Point it at `http(s)://<LAN-IP>:3000`
and every single test fails with an unhelpful "element not found" 90 seconds
into global setup — the app is up, answering 200, and rendering nothing.

That the app crashes outright instead of degrading is itself the defect behind
KPOST-GENERAL-001; the origin is what decides whether it fires.

**Login is two-step, behind a country gate.** `/login` →
`textbox "Enter KPOST ID / Mobile number"` → `Submit` →
`textbox "Enter your password"` → `Login` → lands on `/home`.

The screen also renders a **Country** combobox above the ID field, and the ID
input is `disabled={!country}` (Login.js). The app fills that itself — it
fetches `/v2/common/countries` on mount and defaults to `+91 India` — so a
healthy app needs no interaction there and the flow stays ID → password. The
suite therefore does not select a country; it *waits for the form to become
usable* and diagnoses it when that never happens.

> 🚨 **BLOCKED as of 2026-08-28 — KPOST-AUTH-004.** That country list currently
> renders "No options", so the KPOST ID field never enables and **nobody can
> sign in**, by hand or under test. The data is fine (the endpoint returns 200
> with 200+ countries); `Login.js:970` gates it on a case-sensitive
> `response.status === "SUCCESS"` while the local backend's `common/*`
> controller answers `"Success"`. Proved by rewriting only that one string in
> the response: the country defaults to `+91 India` and a full sign-in
> completes. Until it is fixed, `npm run test:serial` aborts in global setup
> with that defect id — deliberately, rather than running 324 tests to prove
> the same point 324 times. `src/utils/login-preflight.ts` owns the diagnosis
> and `tests/auth/login-form.spec.ts` pins the contract.

> **Related, and a trap:** `ListDomains` (Login.js:1249) compares the same way,
> and `/v2/common/domain` answers `"Success"` too — so while KPOST-AUTH-004 is
> live the domain-suggestion overlay described below never renders either. Do
> **not** conclude from that run that the overlay is gone and simplify
> `submitId()`: fixing the casing brings both lists back, and the overlay with
> them.

> ⚠ **The Submit button is covered by an undismissable overlay.** Typing an "@"
> pops `ul.login__domain-list` ("@kpostindia.com") directly over Submit. It
> swallows pointer events, is not itself clickable, and closes on neither Escape
> nor blur. `{ force: true }` does **not** fix it — force skips Playwright's
> actionability check but the browser still delivers the event to the topmost
> element. Activate it by keyboard instead (`focus()` + `Enter`), which is both
> the accessible path and immune to hit-testing. See `LoginPage.submitId()`.

**Navigation is via Quick Access, not a sidebar.** The left rail is *icon-only*:
`<div class="... icon-KP_03-KMail">` with no text, no `aria-label`, no `title` —
unreachable by any accessible locator. The accessible path is the **Quick Access
launcher** (top-bar button, or `Ctrl+K`): a real ARIA dialog whose entries are
real buttons with real names, e.g. `button "K KMail Open inbox and mails Open"`.
Use `AppShellPage.launchModule()`. `openModuleFromRail()` exists only to cover
the rail itself and is the one sanctioned CSS-class selector in the codebase.

**Other verified shell facts:**

- `/home` always has one *unrelated* `role="dialog"` in the DOM — always
  disambiguate the launcher with `.filter({ hasText: 'Quick Access' })`.
- The top-bar **Global Search ships disabled** (`aria-label "Global Search
  (Disabled)"`). `Ctrl+K` opens Quick Access, not search.
- Home pane: a real `tablist` with `tab "Recents"` (default) and `tab
  "Contacts"`, plus KNews and KEcommerce panels. Two `searchbox "Search"`
  controls render — scope with `.first()`.
- Logout is the rail icon `icon-KP_18-Logout` → a confirmation modal →
  `button "Logout"` → `/login`.
- Auth lives in **localStorage**, not cookies: `accessToken`, `refreshToken`,
  `isAuthenticated`, `Authuser`, `deviceIdentity_primary`, and an encrypted
  `persist:persist:localhost` redux blob. The session survives a reload.
- **KPost never reaches `networkidle`** — the shell polls news, Firebase, and
  websockets forever. Never wait on it; `waitForAppReady` deliberately does not.
- First authenticated paint regularly exceeds 10s (it boots behind a
  `PersistGate` loader), which is why `AppShellPage` gives the shell assertion
  its own 45s budget while everything after it keeps the normal timeout.

### Module status

| Module | Status |
| --- | --- |
| `KDirectory` | ✅ Works. Routes to `/kdirectory`, no failed requests. Opens a first-run setup wizard (Country / Language / vertical) with `Continue` disabled until filled. Contact search + directory list sit **behind** that wizard. |
| `Katchup` | ✅ Works. Routes to `/katchup`. It is a **chats & contacts** module, *not* a social feed — no post composer, no feed of posts; the whole module exposes 14 interactive elements. Recents/Contacts tabs, an "<n> Unopened Messages" counter, and a conversation search that renders "No results found". Backend 500s from `localhost:8989/v2/contacts/*` are noisy but non-fatal. Conversation threads are unverified: the test account has "My Contacts • 0". |
| `KMail` | ✅ **Works** (the earlier 401 force-logout is fixed; it never calls `kmail5.kpostindia.com` now — data comes from `localhost:8989`). Loads at `/kmail`. Three tabs — `Recents`, `Contacts`, `Status of Mails` — all verified clickable; an "<n> Unopened Mails" counter and a Status-of-Mail summary. ⚠ Still raises an uncaught `TypeError … (reading 'status')` in `UnopenedMailAsync` on load (KPOST-KMAIL-001) — and it **refires on the pane's refresh cycle**, so `KMailPage.send()` re-dismisses the overlay right before its click; the suite records each dismissal as a `dismissed-app-error` annotation. **KMail has no composer** — composing is the separate "Write Mail" module. |
| `Write Mail` | ✅ Works (composer, route `/writemail`, renders alongside the KMail pane). Fields ship **no labels**: To is `input[name="to"]`, Subject `input.toInput`, body a Quill `div.ql-editor`, and Send an icon-only `button.post_button_size` with no accessible name. The To field **normalises on blur** (full native address → bare KPOST ID) while still submitting the full address — never press Enter to "commit" it, that can eat the recipient. Send fires `POST /v2/sentMail/postMail/`. **Self-sends are rejected** (400 "Duplicate IDs are present in ToAddress…" → alert "Some Error Occurred!"), so the success path needs `MAIL_RECIPIENT` (a second account); the backend also intermittently 401s valid sessions (KPOST-KMAIL-002). |
| `Settings` | ✅ Works. Routes to `/settings` (rail: `icon-KP_15-Settings`). Six sections as **plain clickable text, not ARIA tabs** — Profile Creation, Digital Card Settings, General Settings, KMail Settings, KNews Settings, My Account — and selecting one does not change the URL. Renders the signed-in user's name + avatar + "Add Cover Photo". **No toggles, switches, or theme controls exist**; the app's only preference control is the header language `<select>` (English/Russian/Japanese), modelled on `AppShellPage`. Only KNews Settings carries its own Submit; "My Account" opened directly renders no controls. |
| `KEcommerce` | ✅ Works. Routes to **`/e-commerce`** (hyphenated — not `/kecommerce`); rail: `icon-KP_14-KCommerce`. Zero failed requests. The catalog is ~60 merchant-logo images with alt text (amazon, flipkart, myntra, …) and **nothing else** — no heading, search, filters, or cart; the only interactive elements are the shell header controls. ⚠ The catalog **intermittently renders empty** with no error state (KPOST-KECOM-001) — the two catalog tests annotate this. |
| `KNews` | ✅ Works. Routes to `/knews` (launcher + rail `icon-KP_08-KNews`). A real news UI: `banner` with `textbox "Search headlines…"` and a "⟳" refresh, a `region "Breaking news ticker"`, a `complementary` sidebar of category buttons (All News / World, publishers, languages, topics — names carry emoji, match on text; there is **no "Top Stories"**), and feed cards as real links inside `main`. Content comes via public RSS bridges (corsproxy.io, rss2json.com) that 503/422/**429** — when they fail the feed renders **empty with no error state** (KPOST-KNEWS-001); the ticker is content-dependent and legitimately absent when there is no breaking feed (that test skips, not fails). |
| `KPay` | ❌ **Not implemented.** The rail shows `icon-KP_12-KWallet` (expanded label "KPay") but clicking it navigates nowhere, the launcher does not offer it, and `/kpay`, `/kwallet`, `/pay` all render the 404 page. Registered as KPOST-KPAY-001 (a dead nav entry is broken UX). `tests/kpay/` pins this contract and is **designed to fail the day KPay ships** — rebuild `KPayPage` from the real DOM then; do not pre-write balance/history locators. |

### Reporting known app defects

When a test fails because the *app* is wrong, register it in
`src/utils/known-defects.ts` and call `noteKnownDefect()` at the top of the test.
That attaches a `known-app-defect` annotation (visible in the HTML and JSON
reports) and returns a message to pass as the `expect()` message, so the failure
output opens with e.g. `KNOWN APPLICATION DEFECT KPOST-AUTH-001: …` instead of a
bare assertion diff.

Three rules: never weaken an assertion to make one go green; delete the entry the
moment the app is fixed (a stale one excuses a real regression); and remember
this documents, it does not suppress — annotated tests still fail.

**Logout does not guard protected routes.** Logging out correctly clears
`accessToken`, `refreshToken`, `Authuser`, and `deviceIdentity_primary`, and
lands on `/login`. But navigating back to `/home` afterwards **stays on `/home`**
and renders a dead, shell-less page instead of redirecting to `/login`. The
`tests/auth/logout.spec.ts` case that asserts the redirect fails for this reason
— that is correct signal; do not weaken it.

## Golden rules

1. **Import `test`/`expect` from `src/fixtures/fixtures.ts`, never from
   `@playwright/test`** in specs. (Page objects import from `@playwright/test`
   for types and `test.step` — that's expected.)
2. **No hard waits.** `page.waitForTimeout` is banned and ESLint now **errors**
   on it. The only sanctioned bounded poll is in `scrollVirtualizedListToItem`.
   Never wait for `networkidle` on this app (see above).
3. **Locators, in order of preference:** `getByRole` → `getByLabel` →
   `getByPlaceholder` → `getByText` → `getByTestId`. CSS only where the product
   exposes no accessible name at all — today that is exactly two places, the icon
   rail in `AppShellPage` and the composer fields in `WriteMailPage`. Both are
   product accessibility defects rather than locator style choices, which is why
   `tests/a11y/` scans them. Declare every locator once, in the constructor.
4. **Web-first assertions only** (`await expect(locator).toBeVisible()`), never
   `expect(await locator.isVisible())`.
5. **Wrap every page-object method body in `test.step()`** with a business-level
   description. That is what makes the HTML report readable. Keep `BasePage`'s
   low-level helpers step-free so the report doesn't drown in noise.
6. **Tests are atomic and parallel-safe** — but see the concurrency caveat below.
7. **Assertions live in tests and thin POM `expect*` helpers.** Page objects
   model *behavior*; specs express *intent*.
8. **Secrets come from `env` (`src/config/env.ts`), never `process.env` directly
   and never hard-coded.** `env.required()` throws on a missing variable — do not
   reintroduce fallback defaults, they turn a config error into a login timeout.
9. **Record verification status in the page-object header.** Every POM says what
   was observed live and what is still conventional. Keep it truthful.

## Known constraints

- **One active session per account — this is the constraint everything else
  follows from.** A full-parallel smoke run failed 6/12 where the same run
  serially passed 8/12, because concurrent contexts on one account evict each
  other. Until per-worker accounts exist, run app-dependent suites with
  `--workers=1` (`npm run test:serial`).
- **Nothing may sign in or out as the standard user except global setup.** Same
  constraint, different blast radius: `tests/auth/` used to drive login/logout as
  the standard user, which took the one session the shared `storageState`
  occupied — so every authenticated test scheduled after `tests/auth/` ran
  logged out and failed on "Execution context was destroyed", nowhere near the
  cause. Measured 2026-08-27: global setup verified the stored session, the auth
  specs ran, and `/home` with that same stored state then redirected to `/login`.
  The auth specs now use `env.users.auth` (`AUTH_USER_EMAIL`, defaulting to the
  admin account) and `tests/auth/logout.spec.ts` signs itself in first rather
  than logging out the shared session. **If you add a spec that logs in or out,
  give it `authUser`, never `standardUser`.** A large share of the failures
  previously attributed to KPOST-AUTH-002 were this.
- **The KMail smoke test is expected to fail** while the 401s above persist.
  That is real signal, not test debt — do not "fix" it by weakening the
  assertion.

## Layout (where things go)

| Need to… | Put it in |
| --- | --- |
| Add a screen | `src/pages/<Name>Page.ts` extending `AppShellPage` (authenticated) or `BasePage` |
| Add shared app-chrome behaviour | `src/pages/AppShellPage.ts` |
| Add a generic interaction helper | `BasePage` or `src/utils/react-helpers.ts` |
| Change how a dropped session is recovered | `src/utils/session-repair.ts` (wired into the `page` fixture) |
| Talk to the API (auth, seeding) | `src/utils/api-helpers.ts` |
| Inject a new page object / state | `src/fixtures/fixtures.ts` |
| Add test data | `src/data/*.json` (static) or `src/data/factories/*` (per-test) |
| Unit-test pure logic (no browser) | `src/**/*.test.ts` — vitest, e.g. `src/reporting/run-model.test.ts` |
| Scan a screen for accessibility | `src/utils/a11y.ts` + a case in `tests/a11y/a11y.spec.ts` |
| Add a domain type | `src/types/index.ts` |
| Register an app defect | `src/utils/known-defects.ts` + `noteKnownDefect()` in the test |
| Change what a report says | `src/reporting/run-model.ts` first — the files and the dashboard payload are projections of it |
| Add a report artifact | `src/reporting/<name>.ts`, fed the model by `dashboard-reporter.ts` |
| Add tests | `tests/<area>/<name>.spec.ts` |

Areas in use: `a11y/`, `auth/`, `home/`, `journeys/`, `kmail/`, `writemail/`, `kdirectory/`,
`katchup/`, `settings/`, `kecommerce/`, `knews/`, `kpay/`.

`journeys/` holds the cross-cutting paths no single module owns — session
survives a reload, modules open from a typed URL, browser back/forward. Put a
test there when it spans modules or exercises the browser itself rather than
one screen.

Class hierarchy: `BasePage` (framework-generic) → `AppShellPage` (KPost chrome:
launcher, rail, language picker, logout) → `HomePage` / `KMailPage` /
`WriteMailPage` / `KDirectoryPage` / `KatchupPage` / `SettingsPage` /
`KEcommercePage` / `KNewsPage` / `KPayPage`. `LoginPage` extends `BasePage`
directly — there is no shell before sign-in.

`KMailPage` and `WriteMailPage` split along the product's own seam: KMail has no
composer, so composing (and the send verdict) is `WriteMailPage`, while the Sent
folder stays on `KMailPage`. A spec that sends a mail and then confirms it
landed legitimately uses both.

**Defect annotations reach every reporter.** `noteKnownDefect()` lands in the
HTML report (annotation on the test page), `results.json`
(`annotations[].type === 'known-app-defect'`), and `junit.xml`
(`<property name="known-app-defect" value="KPOST-… — …"/>`) — verified for all
registered defects. CI systems that parse JUnit get the defect ID and summary
without any extra wiring.

### The reporting engine — one model, five projections

`src/reporting/dashboard-reporter.ts` is registered in `playwright.config.ts`
alongside — never instead of — the html/json/junit reporters. On `onEnd` it
builds **one** run model and projects it five ways:

| File | Role |
| --- | --- |
| `run-model.ts` | The model. Pure — counts, completeness verdict, defect sightings. No I/O. |
| `bug-report.ts` | `BUG_REPORT.json` + `.md` — the developer deliverable, same schema as the API bench's. |
| `dev-digest.ts` | `DEV_DIGEST.md` + `.json` — one-screen triage. `npm run digest`. |
| `dashboard-reporter.ts` | Orchestrates, then POSTs to `$DASHBOARD_INGEST_URL` (Bearer key, slug `kpost-ui`). |
| `bugzilla-reporter.ts` | Files known defects into the **"KPost UI"** Bugzilla product (id 3). |

All four report files are **generated and gitignored** — every run rewrites them
whole, so the repo carries no stale copy. (The API bench commits its
`BUG_REPORT.*`; this bench deliberately does not.)

**Order inside `onEnd`, and why.** Bugzilla files **first**, then the file
reports are written, then the dashboard is pushed, then evidence is uploaded to
it. A bug number does not exist until the ticket is created, so filing last
meant nothing downstream could ever name the ticket a defect had been filed as —
the two systems held the same defect and never referred to each other.
`fileBugzillaDefects()` now returns the ticket per defect (a freshly created one
*or* an already-open one it deduped against), `withBugzillaLinks()` grafts those
onto the model, and from there `BUG_REPORT.md` shows a Bugzilla column and the
dashboard receives `bugzillaId` / `bugzillaUrl` so its defect page links straight
to the ticket. Every defect also carries `category: Functional`, a `priority`
derived from severity, and `type: WEBSITE` — fields the ingest contract already
accepts, so the dashboard shows the same classification the ticket carries
instead of deriving its own. Bugzilla being unset, dry-run, or unreachable
returns no links and everything downstream behaves exactly as before.

⚠ **Do not link `{DASHBOARD_PUBLIC_URL}/defects/{KPOST-…}`.** That route takes
the dashboard's own *numeric* defect id and answers "Invalid defect id" for this
bench's string id — the link was dead every time it was clicked. Tickets link to
the dashboard root and name the defect id to search for; the deep link goes the
other way, dashboard → Bugzilla.

**Bugzilla.** This bench files into its own "KPost UI" product on the shared
Bugzilla instance (the same one the API bench files "KPost API" into), so the
two benches' tickets never collide. The product has 12 components — one per
module in the table above (`Auth`, `Home`, `KMail`, `WriteMail`, `KDirectory`,
`Katchup`, `Settings`, `KEcommerce`, `KNews`, `KPay`, `Accessibility`) plus a
`General` fallback — each pre-configured with Ayyappan Ashok as its default
assignee, so `bugzilla-reporter.ts` never sets `assigned_to` itself; the
assignee lives in exactly one place (the Bugzilla component config), not
duplicated into this bench's env. Every filed bug's summary is tagged
`[<defect-id>]` for dedup (an open bug with that tag already in the target
component is skipped, not re-filed) and its `status_whiteboard` carries
`[cat:Functional]`, the same contract `BUGZILLA-UI`'s `categoryIndex.ts` reads
for the API bench. `BUGZILLA_URL`/`BUGZILLA_API_KEY` unset → clean no-op, like
the dashboard push; `BUGZILLA_DRY_RUN` (default `true`) logs what would be
filed without filing it — set it `false` to file real tickets. Every bug —
newly created, or an older one being backfilled — gets up to 12 evidence files
(screenshots, videos, traces) attached directly, the same cap the dashboard's
own evidence upload uses. Backfill is idempotent per bug, not per run: a bug
with zero attachments (filed before this existed, or whose first attach
attempt failed) gets evidence attached once; a bug that already has at least
one attachment is left alone on every later run. Video/trace attachments need
Bugzilla's site-wide `maxattachmentsize` parameter raised above its ~1000 KB
default — that is an **admin-panel-only** change (Administration → Parameters
→ Attachments), the REST API has no endpoint for it; an oversized file is
skipped with a warning, never fails the run. On the instance this bench points
at that is **already done** — `maxattachmentsize` reads 51200 KB (50 MB),
verified 2026-08-27 via `GET /rest/parameters` — so videos and traces fit.
`usestatuswhiteboard` is `0` there, which only hides the field in Bugzilla's own
web UI: the value still stores and still reads back over REST (bug #98 carries
`[cat:Functional]`), so the category contract is unaffected. Turn that parameter
on if you also want the tag visible in the browser.

**Who a filed ticket belongs to — reporter vs assignee.** These are set by two
different mechanisms and neither is a field this bench writes:

- **Reporter is whoever owns `BUGZILLA_API_KEY`.** Bugzilla records the
  authenticated user as the reporter and offers no way to override it, so the
  identity on every ticket is decided entirely by which key is in `.env`. Both
  benches use **Meera Velu's** key (`user_api_keys` id 5, "KPOST test benches
  (API + UI) - bug filing"), so QA files the bug.
- **Assignee is the component's default owner.** Bug creation deliberately omits
  `assigned_to`, so Bugzilla applies each component's `initialowner`: all 12
  KPost UI components default to **Ayyappan Ashok**, all 27 KPost API components
  to **Jaganathan Murthy**. The developer therefore comes from the Bugzilla
  component config — one place — rather than being duplicated into either
  bench's env.

If tickets ever show the wrong reporter, the key changed owner; if they show the
wrong assignee, a component's default owner changed. Do not "fix" either by
setting fields at create time.

⚠ **Bugzilla access control needs one fix, and it is not this bench's to make.**
Verified 2026-08-28 against the live instance: product access is group-gated
(`group_control_map`, `membercontrol`/`othercontrol` = MANDATORY), and the two
product groups are already correct — Jagan is in "KPost API" only, Ayyappan in
"KPost UI" only. But **TestProduct (product 1) is gated behind the "KPost UI"
group**, so everyone who can see KPost UI can also see the sandbox. It needs its
own group containing only the administrator. Bugzilla exposes no REST endpoint
for product group controls, and the bench's API key lacks `creategroups`, so
this is an admin job: Administration → Groups → new group `TestProduct`, then
Administration → Products → TestProduct → Group Access Controls → point it at
that group (Entry + MANDATORY/MANDATORY) instead of "KPost UI", then add only the
admin as a member. Existing TestProduct bugs must be moved to the new group too,
or they stay visible under the old one.

⚠ **Every Bugzilla write on this instance answers HTTP 400 and succeeds anyway.**
Its `mailfrom` parameter is the bare token `bugzilla-daemon` instead of an
address, so Bugzilla writes the bug (or attachment), then fails to mail about it,
and reports `{"code":68000,"message":"There was an error sending mail … no
sender"}` — after the write has committed. Verified 2026-08-27 end to end: bug
#111 in the sandbox `TestProduct` plus a 660 KB PNG, an 848 KB WEBM and an 8.6 MB
trace ZIP were all created by calls that "failed" this way, and all three read
back **byte-identical**. `bugzilla-reporter.ts` recognises code 68000
specifically, recovers the new bug's id via the same dedup search the next run
would use, and counts mail-failed attachments as the successes they are — so
filing works today. **Fix it properly anyway** in Administration → Parameters →
Email: set `mailfrom` to a real address, or `mail_delivery_method` to `None`.
Until then every run prints one warning about it. Bugzilla bug IDs are one global
sequence across the whole instance, not per-product — KPost UI's first bug
continuing from KPost API's last one is expected, not a bug. As of 2026-08-27 the
instance holds 98 bugs, all of them KPost API's, and **no KPost UI bug has ever
been filed** — the first real (non-dry-run) UI run creates them.

The API bench splits files and push across two reporters and documents an
ordering rule to keep them in step. Building one model and projecting it removes
the possibility of a mismatch instead of managing it — **if you add an artifact,
derive it from the model too, never from a re-read of a written file.**

Preserved guarantees: unset dashboard vars → clean no-op; 15s timeout; an outage
warns and never fails a run; defects upserted by stable `KPOST-*` id with
severity/module from the registry. The ingest contract lives in
`QA-Dashboard/src/lib/validation.ts` — if you change the registry shape, check it
still maps.

**Every failure is accounted for.** A run that reports "191 failed, 17 defects"
invites the obvious question — what about the other 174? — and the report has to
answer it rather than leave the reader to work it out. So the reporter records
every failed test that carried **no** `known-app-defect` annotation, and
`BUG_REPORT.md` renders them under **"⚠ Failures with no registered defect"**,
grouped by error, with browser and spec. `verdict()` leads with that count,
ahead of any severity tally: the old order announced "8 high-severity defects"
and never mentioned that 23 failures were unexplained, because the line that
would have said so was unreachable once any High defect existed.

An unexplained failure is either a defect nobody has registered yet or a broken
test. Both need a person, so they are listed, not counted. When the list is
empty the report says so explicitly — "all N failing tests are accounted for" is
a claim worth making out loud.

**One ticket per defect, with the browsers as a field.** A bug tracker records
flaws in the product, and a missing `<label>` is one flaw even when it surfaces
in four browsers — filing it four times gives one developer four tickets to close
for one line of HTML and inflates the open-defect count past what exists. So
"which browser?" is answered as a FIELD, which is what a standard defect
template's Environment field is for.

Each `DefectRecord` carries `browsers` (`{ webkit: 64 }`),
`sightingsByBrowser` (test titles under each) and — the half that is easy to
forget — `unaffectedBrowsers`: the browsers that ran the same suite and did
NOT hit it. The Bugzilla body states both:

    BROWSERS
      Affected     : webkit
                       - webkit  2 failing test(s)
      Not affected : chromium, firefox, mobile-chrome — ran the same suite in
                     this run and did NOT hit it.

    => webkit-SPECIFIC. The other browsers behave correctly, so look for a
       browser-API or platform difference rather than shared application logic.

That verdict line is computed, not guessed: one affected browser plus at least
one unaffected reads as browser-specific; all affected reads as shared
application code. `unaffectedBrowsers` is derived from the run's project list,
so a `--project=chromium` run leaves it empty rather than vouching for three
browsers nobody opened.

The summary carries a compact tag — `[webkit]`, `[all browsers]`, or
`[chromium+firefox]` — because the summary is the only field a bug list shows.
The whiteboard carries `[browser:chromium,firefox]`, which BUGZILLA-UI parses
(`backend/src/lib/classification.ts` → `browsersOf`) and renders as coloured
`BrowserPill` chips in the bug list and detail sidebar, one per browser.

A genuinely browser-specific fault still gets its own ticket — Firebase on
WebKit, MicInput on Firefox — because it is its own registry entry, not because
the filer split it. That is the distinction: **split when the cause differs, not
when the browser differs.**

**Attribution happens AFTER the assertion fails, never before.** Checking
`page.url()` up front to decide whether the app signed you out looks tidier and
is wrong — the redirect is usually still in flight, so the check sees the old URL
and the failure lands unattributed. `AppShellPage.expectModuleRoute()` asserts
first and only then asks where it ended up. Three real KPOST-KMAIL-003 sightings
were reported as anonymous `toHaveURL failed` before this was fixed.

**Report honestly — the rules that are not negotiable.**

- `totalTests` is what Playwright **planned** (`suite.allTests().length` = 260),
  never what finished. When a run is cut short, the gap between planned and
  accounted IS the signal — the dashboard's `assessRunReport()` flags exactly
  that. Never shrink the total to match, never scale the counts up to the plan.
- Counts come from tests that reached a **terminal result**, one vote per test
  taken from its last attempt (so a retried flaky test counts once). Tests that
  were interrupted are counted as `interrupted`, not folded into skipped — they
  did not pass, fail, or get skipped.
- An incomplete run prints a `⚠ run INCOMPLETE` warning before any pass rate, and
  banners both file reports.
- **A dry run is not a run.** `--list` and a `--grep` that matches nothing reach
  `onEnd` having executed nothing; posting those filed phantom `0/0/0` rows on the
  dashboard. The reporter returns early when no test ever began.
- The environment label is a short **code** (`Local` / `QA` / `Staging` /
  `Production`), from `src/utils/environment.ts`, shared verbatim with the API
  bench. The dashboard groups by that string, so `local` here and `Local` there
  would split one environment into two rows. Never send a URL — `baseURL` is
  reported separately.

**When the app raises an error.** `assertNoAppErrorOverlay()` detects the
dev-server overlay (`#webpack-dev-server-client-overlay`) and throws the real
cause — compiler message or runtime stack — instead of letting it surface as
"element not found" or "iframe intercepts pointer events". It runs from
`waitForAppReady` (after every navigation) and from `BasePage.click` (when a
click fails). Note the overlay blocks **clicks but not reads**, so a partly
broken app shows up as "assertions pass, clicks fail". The overlay is dev-only:
in a production build the same error would instead be a silently broken
feature, so treat anything it reports as a genuine app defect.

## Available fixtures

| Fixture | Scope | Gives you |
| --- | --- | --- |
| `loginPage` `homePage` `kmailPage` `writeMailPage` `kdirectoryPage` `katchupPage` `settingsPage` `kecommercePage` `knewsPage` `kpayPage` | test | Page objects bound to the current page |
| `directoryUser` | test | The pre-onboarded directory account when configured, else the standard user |
| `anonymousPage` | test | A `Page` in a fresh, logged-out context |
| `standardUser` / `adminUser` | test | Credentials from `env` |
| `authUser` | test | The account `tests/auth/` signs in and out as — `AUTH_USER_EMAIL`, defaulting to admin. **Any spec that logs in or out must use this, never `standardUser`** (see Known constraints). |
| `apiAuth` | **worker** | One API login (token + cookies) reused across the worker |
| `seedPost(post)` | test | **Legacy.** Blog-era API seed + auto-teardown; no current spec uses it. Kept as the worked arrange-via-API example. |

## How to add a Page Object

```ts
import { type Locator, type Page, expect, test } from '@playwright/test';
import { AppShellPage } from './AppShellPage';

export class ExamplePage extends AppShellPage {
  protected readonly path = '/example';        // relative to baseURL
  private readonly saveButton: Locator;

  constructor(page: Page) {
    super(page);
    this.saveButton = page.getByRole('button', { name: /save/i });  // declare once
  }

  async save(): Promise<void> {
    await test.step('Save the form', async () => {   // every method gets a step
      await this.click(this.saveButton);             // BasePage helper, not raw page
      await expect(this.saveButton).toBeEnabled();
    });
  }
}
```

Then expose it in `fixtures.ts`:

```ts
examplePage: async ({ page }, use) => {
  await use(new ExamplePage(page));
},
```

## How to add a test

```ts
import { test, expect } from '../../src/fixtures/fixtures';

test('does the thing @smoke @kdirectory', async ({ homePage, kdirectoryPage }) => {
  await homePage.open();          // starts authenticated (shared storageState)
  await homePage.expectLoaded();
  await kdirectoryPage.openFromLauncher();
  await kdirectoryPage.expectLoaded();
});
```

- **Tag** every test: `@smoke` and/or `@regression`, plus an area tag (`@auth`,
  `@home`, `@kmail`, `@kdirectory`). CI runs `@smoke` first. Put tags in the
  `describe` title so the whole block inherits them.
- **Auth tests run logged-out**: add
  `test.use({ storageState: { cookies: [], origins: [] } })` at the top of the
  file, or use the `anonymousPage` fixture.
- **Conditional skips are allowed** for account/environment state a spec cannot
  control (`test.skip(cond, reason)`); blanket `test.skip()` now fails lint.

## Session / auth model

`src/config/global-setup.ts` logs the standard user in **once** and saves the
session to `.auth/standard.json`. Fixtures load that state by default, so most
tests start signed in. Auth specs opt out. `.auth/` is gitignored — never commit
real sessions.

`AUTH_MODE` selects the strategy and now defaults to **`ui`**: KPost's session is
several localStorage keys plus an encrypted redux blob, so injecting one API
token cannot boot the SPA authenticated. `api` mode remains for when that
contract is wired, and falls back to UI login on failure.

Global setup re-implements the login flow rather than reusing `LoginPage`,
because `test.step()` is illegal outside a running test. **If you change
`LoginPage.submitId()`, change `seedViaUi()` too.**

After seeding, `verifySession()` loads the saved state into a clean context and
requires `/home` to render the authenticated shell. Without it, a session that
fails to propagate shows up as every authenticated test failing on a confusing
"element not found", several layers from the cause.

**Second, optional account.** Set `DIRECTORY_USER_EMAIL` /
`DIRECTORY_USER_PASSWORD` to an account that has *already* completed KDirectory
onboarding and global setup stores a second session at `.auth/directory.json`
(`DIRECTORY_STORAGE_STATE`). The gated KDirectory specs select it via
`test.use({ storageState: … })` and stop skipping. Leave both unset and they skip
with a reason; set only one and `env.ts` fails fast. A configured-but-broken
directory user is fatal, not a warning — opting in is a statement that the
account exists. The full chain (env → seeding → verification → spec selection →
wizard detection) is verified working; only a genuinely onboarded account is
still missing.

**Optional mail recipient.** `MAIL_RECIPIENT` (a second KPOST account) unlocks
the full send-success E2E ("a sent mail is accepted and appears in the Sent
folder"). Without it that test skips, and the always-running self-send contract
test covers the whole compose/send pipeline against the documented rejection.

## Commands

```bash
npm install && npx playwright install     # first-time setup
cp .env.example .env                       # then fill in real test-user creds
npm test                                   # full suite, all browsers
npm run test:smoke                         # @smoke only
npm run test:serial                        # workers=1 — required for app-dependent runs
npm run test:ui                            # time-travel debugging
npm run test:unit                          # vitest — pure logic, no browser/app/account needed
npm run test:list                          # enumerate (324) without running — now SAFE.
                                           # It passes `--reporter=list`, which replaces the
                                           # configured reporters for that invocation, so the
                                           # html/json/junit ones never fire and cannot overwrite
                                           # playwright-report/, results.json or junit.xml with the
                                           # empty output of a run that executed nothing. Drop that
                                           # flag and listing goes back to destroying the last run's
                                           # report — the dashboard reporter is the only one that
                                           # guards itself.
npm run report                             # Playwright HTML report: traces, video
npm run digest                             # print DEV_DIGEST.md — fastest read on a run
npm run codegen                            # record real KPost selectors
npm run ci                                 # typecheck → lint → unit → e2e (the gate)
```

Per-area (`test:kmail`, `test:kpay`, …) and per-browser (`test:chromium`,
`test:mobile`, …) scripts exist for every module and project; combine with
`-- --project=chromium`. Full list and operational detail: `OPERATIONS.md`.

## Before you push

Run `npm run ci` (or at minimum `npm run typecheck && npm run lint &&
npm run test:unit`). Typecheck, lint and the unit suite must be **clean — zero
errors, zero warnings, 47/47 passing**; they are today, keep them that way.

Prefer `npm run test:unit` over `npx playwright test --list` as the cheap
pre-push check: it needs no app and, unlike `--list`, does not overwrite the
previous run's HTML report.

## CI shape

`.github/workflows/playwright.yml` — three stages on push/PR to `main`/`develop`,
plus a nightly 02:00 cron and manual dispatch:

1. **static** — typecheck + lint. Always runs, no app needed.
2. **smoke** — chromium, `--grep @smoke`.
3. **e2e** — matrix across chromium / firefox / webkit, artifacts on failure.

Stages 2 and 3 are **gated on the `KPOST_START_CMD` repository variable** and are
skipped while it is unset — so today CI proves the suite compiles and lints, not
that it passes.

## Known follow-ups

- **Fix the `UnopenedMailAsync` TypeError** in KMail (KPOST-KMAIL-001). It no
  longer blocks any test — the suite dismisses the dev overlay and verifies the
  tabs beneath — but the uncaught error is still real, and in production the
  unopened-mail feature would fail silently.
- **Verify the relocated Write Mail specs still pass.** `WriteMailPage` and
  `tests/writemail/` were extracted from `KMailPage` without the app running, so
  the *move* is unverified even though the logic it carries was verified live on
  2026-08-12. The one genuinely new case — "the composer exposes recipient,
  subject and body fields" — has never executed.
- **Accounts cannot currently be self-provisioned — the OTP service is down.**
  Attempted 2026-08-28 through the API bench's own documented six-step pipeline
  (`mobileNoExist` → `sendOTP` → `validateOTP` → `signup` → `userLogin` →
  verify), via the UI proxy at `localhost:3000/api` because a direct call to
  `192.168.1.176:8989` answers 401. Step 1 passes ("Mobile number can be used"),
  then **`POST /v2/common/sendOTP` returns 500 "API service is not working"**,
  `validateOTP` consequently fails for both mock OTPs (`123456`, `000000`), and
  `signup` refuses with `kpostID: "Domain is not available; kpostID must start
  with a letter or Invalid kpostID"`. No account was created. Until that service
  is back, `MAIL_RECIPIENT` and `DIRECTORY_USER_*` have to come from accounts
  someone provisions by hand — which is what gates the suite's only
  create-and-verify coverage.
- **Provision a pre-onboarded KDirectory user.** The plumbing is done — set
  `DIRECTORY_USER_EMAIL` / `DIRECTORY_USER_PASSWORD` and the three gated specs
  run. Only the account itself is missing. First run against a real one, narrow
  `KDirectoryPage`'s unverified locators (results list, filters, empty-state
  string) to what the DOM actually shows.
- **Seed at least one Katchup contact** for the test user so the conversation
  thread journey (`KatchupPage.openFirstConversation` / `sendMessage` /
  `expectMessageVisible`) stops skipping and gets verified.
- **Fix the missing post-logout route guard** (see above), then the failing
  `logout.spec.ts` case turns green on its own.
- **Give each worker its own account** so the suite can run in parallel again.
- **Wire CI app provisioning**: set `KPOST_START_CMD` and the four user secrets.
- **Raise with the product team**: the login overlay covering Submit, and the
  icon rail having no accessible names — both are real accessibility defects.
- **Decide the fate of the blog-era leftovers**: `data/factories/postFactory.ts`,
  `data/posts.json`, the `Post` types, `apiCreatePost`/`apiDeletePost`, and the
  `seedPost` fixture are unused by any spec.
- ~~Run the accessibility scans against the live app.~~ **Done.** They ran, found
  3 violations on the login screen and 4 on Home, and every one is registered as
  KPOST-A11Y-001 … -006 from direct observation. Those specs are legitimately red
  until the app is fixed; never widen `disableRules` or drop a WCAG tag to reach
  green.
- **Register the KPost UI defects in Bugzilla for the first time.** As of
  2026-08-27 the instance holds 98 bugs, all of them the API bench's — no KPost
  UI ticket has ever been created. The plumbing is verified end to end (bug
  creation, screenshot/video/trace attachment, byte-identical read-back); it just
  needs one real run with `BUGZILLA_DRY_RUN=false`.
- **Re-judge KPOST-AUTH-002 from a clean full run.** Much of what it described
  was the suite logging itself out (now fixed); whether the app still drops
  sessions on its own is an open question its entry now says so plainly. Confirm
  or delete it — do not leave it as-is.
- **Raise with the backend team**: `POST /v2/signupLogin/fetchUserDetails/` answers
  **HTTP 500** for an account that simply does not exist, where a 404/400 belongs.
  The UI handles it correctly (it raises the alert "Enter a Valid KpostID / Mobile
  Number"), so this is not a UI defect and is deliberately NOT in the registry —
  but a 500 for ordinary "unknown user" input hides real server faults in the
  monitoring noise.
- **Not yet covered**: visual regression, file upload/download, and the
  remaining KPost modules (Kall, KCloud, KBooking, KDOC, Broadcast, My Profile).
