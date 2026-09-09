# CLAUDE.md

> **Monorepo note.** This suite lives in the **`kpost-testbench`** monorepo under `suites/kpost-api/`
> (it also hosts the `kmail/` and `admin/` sister suites nested inside it). Read the **root
> [`../../CLAUDE.md`](../../CLAUDE.md)** first for cross-cutting rules (test pyramid, working
> constraints, reporting) and the **current environment/backend state** — live host, QA accounts,
> and known blockers (the `postMail` mail-provisioning gap, undeployed endpoints, the `192.168.1.38`
> DB-schema issue). See **[`../../docs/context/`](../../docs/context/)** for the accumulated history
> and the "why" behind past decisions (payload↔Excel alignment, the KMail token-trust fix, the
> coverage audit). This suite's own conventions — for the KPost API bench **and the KMail sister
> suite** — are documented below.

Guidance for Claude Code (and any engineer) working in this repository.

## What this project is

A Playwright + TypeScript **API test automation framework** for the KPOST Communication
Platform API. It contains **no UI/browser code** — every test drives `APIRequestContext`
directly. The purpose is not regression-guarding a healthy API; it is **adversarial
bug-hunting** against a live backend, with every confirmed defect written to
`BUG_REPORT.md` in a fixed, ticket-ready schema.

The API contract lives in `swagger.json` (OpenAPI 3.0.1, ~3.8 MB, **408 endpoints across
34 tags**). Treat it as the source of truth for paths, payload shapes and documented
behaviour — but **not** for actual behaviour, which frequently diverges (see below).

## Commands

```bash
npm test                    # full suite (~4,600 tests), all configured reporters
npm run typecheck           # tsc --noEmit — must be clean before any commit
npm run test:auth           # single project: auth | profile | common | integrations | modules
npm run generate            # regenerate registry + module specs from swagger.json
npm run report              # open the tier 1 diagnostic report (traces)
```

Run a single spec or a single test:

```bash
npx playwright test tests/common/common.spec.ts -g "sendOTP"
```

> Passing `--reporter=line` **overrides all configured reporters**, so none of the four report
> tiers are produced for that run and `BUG_REPORT.md` is left at the "run in progress" stub
> globalSetup wrote. Use the bare `npm test` when you need the artifacts.

## Sister suite: `kmail/`

This repo hosts a **second, self-contained suite** under `kmail/` — the KMail API bench. It is a
separate Playwright project with its own `src/`, `tests/`, `reporters/` and
`kmail.swagger.json`, run from the root via `npm run test:kmail`. It shares the root
`node_modules` (identical deps, resolved by Node's upward lookup — no separate install),
authenticates through the **same KPOST login** (`KPOST_AUTH_BASE_URL`) but drives the KMail
service (`KMAIL_BASE_URL`), and files defects to the **`KMail API`** Bugzilla product so they
route to a different developer than the KPost API product. Everything below in this document
describes the **KPost** suite at the repo root; `kmail/` has its own conventions but follows the
same adversarial, one-defect-per-fault philosophy.

## Sister suite: `admin/`

A **third self-contained suite** lives under `admin/` — the **KPOST Admin Module** bench
(112 endpoints, 24 tags: org hierarchy, employees, departments, designations, role postings,
product licensing), ported from the standalone `KPOST-ADMIN-AUTOMATION` project. Run from the
root via `npm run test:adminmodule` (`:list`, `typecheck:adminmodule`). Like `kmail/` it shares
the root `node_modules` — but note it adds **`jsonwebtoken`** as a root dependency, because the
admin module's login returns identity only and the bench **mints its own HS256 token** from
`ADMIN_JWT_SECRET` (or uses a pasted `QA_AUTH_TOKEN`); it is **not** the KPost bearer token.
It drives the admin service (`BASE_URL`, e.g. `adminmodule.kpostindia.com` in prod / a `:9595`
host in staging) and files defects to the **`KPost Admin`** Bugzilla product, whose 25
components all default-assign to **`jagan@kpost.in`**. The suite has 11 tag directories under
`admin/tests/` and follows the same conventions as KPost/KMail. **Safety:** the admin surface
holds real company HR data — against a production target, run refusal-path/read-only only
(`npm run test:no-onboarding` from inside `admin/`) and keep `BUGZILLA_DRY_RUN=true` until a run
is reviewed.

## Architecture

```
scripts/       grouped by purpose; every entry point is reached through an npm script
  audit-vectors.ts             the pretest coverage gate (98% of mandatory vectors)
  clean.js  run-seed.js        run lifecycle
  lib/repo-root.js             finds the repo root by walking up to swagger.json. Scripts
                               must NOT re-derive it from __dirname: that encodes how deep
                               the file sits, and moving it then points every path one level
                               too high — which surfaces as an empty read, not an error
  generate/                    generateModuleOwnership.js (swagger.json -> moduleOwnership
                               .generated.ts) and generateTokenDerived.js (data/ -> registry)
  bugzilla/                    close-fixed-bugzilla-bugs.js, reconcile-bugzilla-duplicates.js,
                               repair-refiled-bugzilla-bugs.js, verify-open-bugs.js
  report/                      print-digest.js, print-executive-path.js
  auth/  auth-check/           login diagnosis, and the pre-run credential check
  sql/                         one-off DBA repairs, run by hand and never by the suite
  seed/seed.setup.ts           driven by `npm run seed`, found via testMatch not by import
data/          inputs to the generators — checked in, never produced by a run
  kpostID_attribute_usages.xlsx   source for src/api/registry/tokenDerived.generated.ts
reporters/     the tier 2-4 engine (see "The reporting engine") + the dispatchers
  kpost-master-reporter.ts     builds the run model, drives every tier
  send-email-report.ts  send-webhook-alert.ts  dispatch-bugs-to-tracker.ts
  dashboard-ingest.ts          POSTs BUG_REPORT.json to the external QA Dashboard, LAST in the array
src/
  config/      env.config.ts (typed env), global-setup.ts (resets bug ledger)
  fixtures/    api.fixture.ts (Playwright fixtures), authSession.ts (session acquisition)
  reporters/   bugReporter.ts (compiles BUG_REPORT.md + .json, then the digest)
  utils/       bugTracker.ts (bug ledger + report/JSON writer),
               devNotifier.ts (Developer Digest generator),
               apiAssertions.ts (the bug-hunting assertions),
               schemaValidator.ts (Zod wrapper), fuzzData.ts (attack corpus)
  api/
    clients/   one thin client per hand-written tag + generic.client.ts (path-driven)
    payloads/  faker-backed request builders
    registry/  endpoints.generated.ts (GENERATED — do not edit)
    schemas/   Zod response contracts
tests/         16 directories, one per Swagger tag, every spec hand-written:
               auth/ profile/ common/ integrations/ dashboardV2/ knews/
               generalSettings/ groupsV2/ companyAdministration/ contactsDirectoryV2/
               kwordDocuments/ kpresentation/ kdiary/ kallV2/ redbus/ katchupV2/
docs/          api.json (QA tracker export), V1_DECOMMISSION_RISK.md (open risk),
               archive/ (superseded docs, kept for history)
swagger.json   the API contract. Stays at the ROOT: `audit-vectors.ts` and
               `generate-scorecard.ts` locate the repo root by testing for this file.
OPERATIONS.md  the operations manual — running, reporting, delivery, troubleshooting
```

Each `tests/<dir>` is a separate Playwright **project**, so `--project=<name>` scopes a run.

**Reporters live in two places, deliberately left alone.** `reporters/` holds the tier 2–4
engine and the dispatchers; `src/reporters/bugReporter.ts` holds the ledger compiler. Moving it
would mean re-pointing `playwright.config.ts` and rewriting its relative imports for no
functional gain, so the split is documented rather than "fixed".

### One layer of test authoring: every spec is hand-written

There is **no generated test matrix**. An earlier design generated `tests/modules/` from a
registry via `src/testFactory/endpointSuite.ts`; that approach was abandoned because a generic
15-case template cannot express the assertions that actually find defects here — ownership on
a specific DTO field, a fare the client must not choose, a recall aimed at someone else's
message. Those files no longer exist and should not be reintroduced.

Every suite lives under `tests/<tag>/`, one Playwright project per Swagger tag, with a
dedicated 4-file set: `src/api/schemas/<tag>.schema.ts`, `src/api/payloads/<tag>.payload.ts`,
`src/api/clients/<tag>.client.ts`, and one or more `tests/<tag>/<feature>.spec.ts`. Each
endpoint gets its own `test.describe` and 10+ standalone `test()` cases — **no loops**, so
every case is individually named, reportable and skippable.

That rule now holds literally: with `tests/legacy/` removed, **no spec contains a
template-literal `test.describe`** and no describe block is generated by a loop. The
table-driven form that briefly existed there is gone with it. If it is ever reintroduced, the
bar is the rule's purpose rather than its letter — every case individually named, reportable
and skippable — and it should be confined to groups of endpoints that genuinely share one
shape, never to an endpoint with a distinctive risk.

`scripts/generate/generateModuleOwnership.js` is the only generator still in use: it derives
`MODULE_BY_PATH` (path -> Swagger tag -> owning team) so bug tickets route correctly.

Endpoints matching `DESTRUCTIVE` in the generator (logout-all, account deactivation, the
kmail password patch job) are marked `destructive: true` and skipped at run time — they
would damage the shared environment.

### V1 / legacy routes are out of scope

`swagger.json` labels nine tags "superseded" or "abandoned" — 98 operations across V1 auth,
profile, common, contacts, katchup, kall, groups and dashboard, plus the `unusedv2/kall` tree.

They were covered once, found 491 defects (73 Critical), and were then **removed from the run**
so execution capacity goes to the active V2 surface. Do not reintroduce them here.

What matters for anyone reading this later: **deleting the tests did not decommission the
routes.** They are separately mounted, absent from `api.json`, and were answering at the time of
removal. The findings and the verification command that closes them out live in
`docs/V1_DECOMMISSION_RISK.md`, which stays until a request to a V1 path returns 404. As of
2026-08-13 those paths answer **403, not 404** — they are still mounted, so the risk is open.

The suite therefore targets the **310 active operations** only, and coverage percentages in
`SUITE_SCORECARD.md` are computed against that denominator, not against the 408 in the spec.

## Non-negotiable conventions

**Never assert with bare `expect(response.status())`.** Use the helpers in
`src/utils/apiAssertions.ts` so failures land in `BUG_REPORT.md` with full metadata:

| Helper | Use for |
| --- | --- |
| `assertStatus` | expected status set; logs a finding on mismatch |
| `assertRejectsInvalidInput` | invalid input must be 400/422 — flags silent 200 acceptance |
| `assertUnauthorized` | protected route must be 401/403 — flags 400/500/200 |
| `assertStatusCodeParity` | HTTP status must equal the envelope's `statusCode` |
| `assertNoInternalLeak` | injected input must not return stack traces / SQL errors |
| `assertNoReflectedScript` | script payloads must not come back unescaped |
| `assertPublicRouteReachable` | the **inverse** of `assertUnauthorized`: a route the contract declares public (`security: []`) must NOT be gated — flags one that answers 401/403 to a token-less caller. Pass a `{ token: null }` request; probe login/signup with an INVALID body so a credential-401 isn't mistaken for a gate |
| `assertNot200OKOnError` | a success transport status must not carry a failure envelope (HTTP 200 with `status: FAILURE` / `statusCode: 500`) |

Pass `body` and (where non-default) `headers` in the assertion `meta` — they populate the
**Steps to Reproduce** block in the bug ledger. Without them the ticket says
`(no request body)` and a developer has to reconstruct the call from the snippet.

**Every assertion needs an `expect` message** explaining the user-visible consequence, not
just the mismatch. `'…returned 200 — a client trusting the HTTP status is misled'` beats
`'expected 400'`.

**Request payloads match the "KPost API" Excel, not swagger.** The Excel workbook (the
authoritative source for request body shapes — swagger frequently diverges) is dumped per-tab
to text and each payload builder's fields are aligned to its endpoint's row; the builder header
comments cite the Excel shape. When a builder's fields change to match the Excel, **re-point any
`assertRejectsInvalidInput`/injection fuzz that targeted a removed or renamed field onto a real
field** — otherwise the phantom field is ignored, the real payload stays valid, and the test
files a false "invalid input accepted" defect. Endpoints absent from the Excel keep their
swagger-derived shape until the Excel adds them.

**Public vs protected is decided per endpoint from swagger `security`.** `security: []` = public
→ probed with `assertPublicRouteReachable` (a token-less request must not be gated; probe
login/signup with an *invalid* body so a credential-401 is not mistaken for a gate).
Inherits the global `bearerAuth` = protected → gets an `assertUnauthorized` test. Swagger's
`security: []` is not always trustworthy: several "public" routes require auth by product
decision — `profile/fetchUserDetails`, the profile/group image and katchup attachment/media
downloads, `taWallet/*`, `metaDee/aiMessage` — so those keep `assertUnauthorized`.

**OTP and destructive endpoints are constrained on purpose.** Payload builders for
`sendOTP` / `sendOTPtoMail` / `forgotPassword*` are pinned to `TEST_MOBILE` / `TEST_EMAIL`,
never faker values — a random 10-digit Indian number is a real subscriber and this suite
fires those endpoints hundreds of times. Do not "fix" that by reintroducing faker.
`deactivateAccount` and password changes exercise **refusal paths only**.

**Authentication never silently skips — and never silently proceeds either.** Credentials are
configuration; tokens are derived state. `.env` holds `QA_KPOST_ID` / `QA_PASSWORD` and
nothing else auth-related. `globalSetup` mints the session once per run and caches it in
`.auth/session.json`, **scoped to `BASE_URL`** — a token minted against another host is
discarded, never reused, because that mismatch is reported by the API as `"Invalid
Credential"` and is indistinguishable from a wrong password. `authSession.ts` tries, in order:
cached session → refresh via `generateJWTokens` → `QA_KPOST_ID`/`QA_PASSWORD` login →
`QA_AUTH_TOKEN` override → throwaway signup. Every failed step is recorded, and the
whole chain is printed once per worker. **If no session can be established the run aborts**
(`ALLOW_UNAUTHENTICATED_RUN=1` opts out): a run that publishes a report and files tickets
from coverage it never executed is worse than one that refuses to start. See
`docs/AUTHENTICATION.md`, and `npm run auth:diagnose` when login is refused.

**Never aim a destructive call at the shared session.** `userLogout` /
`userLogoutFromAllDevices` use `revocableToken` (same account, throwaway device) and
`deactivateAccount` uses `disposableToken` (a freshly registered account). Both were firing at
the run's live identity: revocation took every other worker's auth down mid-run, and a
successful deactivation would have destroyed the account the whole bench depends on. If all routes fail, `requireAuthToken()` throws
`AuthenticationUnavailableError` carrying the full attempt log. Tests must call
`requireAuthToken()` rather than `test.skip(...)`, so unverified coverage is visible.

`authSession` is **worker-scoped** on purpose: establishing a session costs several round
trips, and ~4,600 tests would otherwise spend most of the run re-authenticating.

## Known API behaviours (verified against the live backend)

Do not "fix" tests that fail on these — they are **real defects the suite is meant to catch**:

- `status` is emitted **UPPERCASE** (`SUCCESS`/`FAILURE`) while `swagger.json` documents
  `Success`/`Failure`. `dataEnvelopeSchema` therefore types `status` as a plain string; the
  casing deviation is asserted once by a dedicated contract test.
- Several endpoints return **HTTP 200 carrying `statusCode: 500`** in the body
  (`userLogin`, `forgotPasswordOTPOrSentKpostIDSms`). `assertStatusCodeParity` exists for this.
- Protected routes commonly answer **400 or 500 instead of 401/403** when unauthenticated.
- `saveEnquiryDetails` accepts an empty body (creates an all-null row, HTTP 200) and
  **persists `<script>` payloads verbatim** — stored XSS.
- `getDesignationByProfessionId` NPEs (500) on a flat payload, exactly as the spec warns.
- PIN lookups return HTTP 500 with `statusCode: 204` in the body.
- Signup validation is self-inconsistent: identical payload shapes yield different
  rejection reasons, so throwaway-user creation is unreliable on this environment.

## The reporting engine

Four tiers, one wiring point. Everything lives in `reporters/` and every artifact is written
to `reports/`, which is created on demand and git-ignored.

Two more artifacts sit alongside the four tiers:

| Artifact | Written by | Purpose |
| --- | --- | --- |
| `BUG_REPORT.md` | `src/reporters/bugReporter.ts` | The human ledger — one ticket per defect with owner, risk impact, curl and Playwright repro |
| `BUG_REPORT.json` | same | Machine twin of the ledger, for CI jobs and tracker importers |
| `DEV_DIGEST.md` / `.json` | `src/utils/devNotifier.ts` | Grouped triage summary by severity / module / owner, plus ready-to-send Slack, Teams and Discord payloads |

`devNotifier` **generates, it does not send.** Delivery belongs to `reporters/send-*.ts`,
which already own SMTP, payload shaping and the fail-safe behaviour; the digest reads
`BUG_REPORT.json` so it can also be regenerated standalone long after the run. It runs last,
inside `bugReporter.onEnd`, because it consumes a file that reporter has only just written.

**Allure is absent permanently.** It was removed, re-added on request, and removed again — this
time for good, so do not reintroduce it. It duplicated tier 1 as a second generic per-test
viewer, needed a Java CLI to render (a run only produced raw `allure-results/` JSON), and at one
point had 1,353 generated files committed to git. The two jobs it was covering now have better
homes: **trends belong to the external QA Dashboard**, which holds every run across every bench,
and **per-run debugging belongs to Playwright's native report**, which owns the trace viewer and
already receives the request/response attachments from `attachExchange()` in `base.client.ts`.

| Tier | Artifact | Audience |
| --- | --- | --- |
| 1 Diagnostic | `reports/runs/<run>/diagnostic/index.html` + traces | developers, QA engineers |
| 2 Executive delivery | `reports/runs/<run>/kpost-executive-summary.html` | engineering leads, management |
| 3 Historical trend | `reports/kpost-trend-history.json` | quality dashboards |
| 4 Auto-bug stream | `reports/runs/<run>/kpost-bug-payloads.json` | Plane / Redmine / Jira |

```
reporters/kpost-master-reporter.ts    Reporter class — builds the run model, drives every tier
reporters/run-model.ts                joins Playwright results + bug ledger + HTTP telemetry
reporters/telemetry.ts                per-request status/latency sink written by the transport
reporters/run-paths.ts                run-folder layout, latest pointer, archiving, retention
reporters/generate-executive-html.ts  the tier 2 template (self-contained HTML)
reporters/kpost-trend-logger.ts       tier 3
reporters/kpost-bug-payloads.ts       tier 4
reporters/send-email-report.ts        dispatcher — SMTP digest + attached report
reporters/send-webhook-alert.ts       dispatcher — Slack / Teams / Mattermost
reporters/dispatch-bugs-to-tracker.ts dispatcher — Plane / Redmine ticket creation
```

### Run isolation

Every execution writes into its own timestamped folder, so a re-run never destroys the
evidence from the run before it:

```
reports/
  runs/run_2026-08-10_17-42-08/   executive HTML · bug payloads · run model · diagnostic/
  latest/                          mirror of the newest run + run.json pointer
  kpost-trend-history.json         root, append-only, one point per run
  dispatched-bugs.json             which defects have already been filed in the tracker
```

- Folder stamps are **UTC**, so they sort chronologically for everyone, never repeat an hour
  across a DST change, and match the timestamps printed inside the report.
- The diagnostic report is **hard-linked** into the run folder, with a per-file copy fallback.
  A failing run's traces are tens or hundreds of megabytes; linking archives them for free and
  leaves `reports/diagnostic/` valid for `npx playwright show-report`.
- `latest/` re-renders the executive HTML rather than copying it, because the trace-viewer link
  is relative — inside the run folder `./diagnostic/` is a sibling, from `latest/` it is not.
- `KPOST_RUN_RETENTION` (default 20) caps how many run folders are kept and logs what it
  pruned. Tier 3 keeps the *metrics* for every run forever, so pruning loses evidence, never
  the trend line.
- Dispatchers resolve the newest run through `reports/latest/run.json`, falling back to a scan
  of `reports/runs/`, so a hand-run dispatcher still works after someone deletes `latest/`.

### Dispatchers

All three are invoked from `onEnd` and are **fail-safe by construction**: they return a result
object, never throw, and print one `[KPOST Reporter] … skipped - X not configured` line when
their environment variables are absent. A missing SMTP host or an unreachable tracker cannot
fail a test run. See `.env.example` for every variable.

- **Email** speaks SMTP directly rather than pulling in a mail library — implicit TLS or
  STARTTLS, AUTH LOGIN or AUTH PLAIN, one multipart message. Zero third-party code added to a
  repository whose purpose is auditing someone else's security. If DKIM or OAuth2 is ever
  needed, replace `sendMail`; nothing above it changes.
- **Webhook** picks its payload shape from the URL host: Teams' connector rejects a bare
  `{text}` and needs a MessageCard, Slack and Mattermost both take `{text}`.
- **Tracker** files **one ticket per defect, once.** Dispatched defects are recorded in
  `reports/dispatched-bugs.json` keyed by the content hash (`BUG-API-XXXXXX`), not the
  positional `KP-001`. Without that ledger a nightly schedule re-files the same findings every
  night until the tracker is unusable.

Tiers 2–4 are projections of a single run model, persisted as `reports/kpost-run-model.json`
so a downstream job can re-derive any artifact without re-running the suite.

### Tier 1 is Playwright's own report, deliberately

Playwright's HTML reporter is a pre-compiled React bundle inside `@playwright/test`; its options
are only `outputFolder`, `open`, `host`, `port`, `title`. There is no template, theme or slot
API, so the KPOST-branded, defect-led report of tier 2 cannot be produced by configuring it — a
custom reporter is the only supported route. The two do different jobs and neither replaces the
other: tier 1 owns the **trace viewer**, which replays a failed request and response and which
nothing else replicates; tier 2 owns the **narrative** — defects, severity, ownership,
reproduction. Tier 2 links to tier 1 in its footer.

Allure is gone permanently — see "Allure is absent permanently" above.

### Rules that are load-bearing

- **`kpost-master-reporter` must stay ahead of `bugReporter` in `playwright.config.ts`.**
  Reporter `onEnd` hooks run in array order and `bugReporter` deletes `.bug-cache/`, which is
  where both of them read the defect ledger from.
- **Defect ids are display ids, not identity.** `KP-001…` are assigned in the reporter process
  after sorting by severity, because a sequential id cannot be minted safely inside a worker.
  The stable content hash (`BUG-API-XXXXXX`) travels with each entry, so the HTML report, the
  bug payloads and `BUG_REPORT.md` all cross-reference.
- **One payload per defect, not per failed test.** A single backend fault trips hundreds of
  cases here; filing hundreds of tickets for it is how an issue tracker becomes unusable.
- A failure that never filed a ledger entry — a bare `expect` rather than one of the assertion
  helpers — gets a synthetic defect, deduplicated by *(endpoint, first line of the failure)*.
- Latency and response codes come from `recordApiCall`, which `base.client.ts` calls after every
  round trip. It is observational only: it never reads, delays or alters a response, and it
  swallows its own errors. Reporters cannot see HTTP traffic, so there is no other source.
- **The tier 2 client script is a string, so `tsc` cannot see inside it.**
  `assertClientScriptParses()` runs `new Function(CLIENT_JS)` at generation time so a typo fails
  loudly instead of shipping a page whose tabs and filters silently do nothing.
- Each tier is wrapped individually in the master reporter: a template fault in tier 2 must not
  cost the run its trend point or its bug payloads.
- Pass/fail colour is never the only signal — status pills carry a glyph and a word, because the
  green/red pair sits at the colour-vision-deficiency separation floor.

## Bug reporting

`BUG_REPORT.md` is **generated — never edit it by hand**. Findings are written by
`src/utils/bugTracker.ts` during the run and compiled by `src/reporters/bugReporter.ts`.

### One defect per fault, not one per failing test

A single backend fault trips hundreds of cases here. Identity is therefore the **fault**, not
the test that found it: `computeId` hashes `classification + title` (or an explicit
`dedupeKey`), the endpoint is deliberately *not* part of it, and every test that observes the
fault contributes an **occurrence** instead of a second ticket.

Occurrences are written by workers as individual files under `.bug-cache/occurrences/<id>/`
with the same atomic `wx` create as every other cache here, and merged by `compileGrouping()`
in the reporter process, after every worker has exited. Workers never mutate a shared file.
Each compiled record carries `occurrences`, `affectedEndpoints[]`, `affectedModules[]`,
`observedByTests[]`, `firstSeen`/`lastSeen` and a bounded `evidenceSamples[]`, so a grouped
ticket is strictly more informative than the many it replaces.

Measured on the ledger that motivated this: **1283 findings → 565 defects.** Two systemic
faults account for most of the collapse (an auth filter answering 400 on 227 routes; missing
security headers on 257).

`KPOST_GROUPING=endpoint` switches identity back to including `METHOD /path`, which yields 707
on the same ledger. It exists because a shared *title* is not proof of a shared *fix* —
"Response body violates the documented contract" collapses 21 endpoints across 13 modules into
one ticket, and those are 21 different DTOs. Changing the mode changes every id, so treat it as
a migration, not a toggle.

A defect spanning several modules is routed to the module holding the most affected endpoints,
with every other owner named on the ticket. A ticket addressed to everyone is addressed to no
one.

### Severity grading is deliberate — don't inflate it

A report where everything is Critical is a report nobody reads.

**Four bands**, `Critical | Major | Minor | Trivial`, each with a `P0..P3` priority derived
mechanically in `bugTracker.ts` (pass `priority` explicitly to override):

| Band | Priority | Means |
| --- | --- | --- |
| Critical | P0 · Showstopper | System crash, severe data loss, or a total feature blockade with no workaround — auth bypass, injection, IDOR, unauthenticated data exposure, or invalid input **accepted** and persisted |
| Major | P1 | Significant loss of core functionality, though a difficult workaround may exist — business rule not enforced, internals disclosed, privileged route reachable |
| Minor | P2 | Small functional failure that does not impair basic operations — wrong status code or misreported outcome; misleads a client, corrupts nothing |
| Trivial | P3 | Cosmetic contract/response-shape deviation, wording, presentation |

`Minor` and `Trivial` were previously named `Medium` and `Low`. `normalizeSeverity()` still
reads the old words so historical artifacts keep parsing; nothing emits them any more.

**Category is the second axis**, orthogonal to severity, and every defect carries exactly one:

| Category | Means |
| --- | --- |
| Functional | Incorrect output, logic failure, or a broken workflow |
| Performance | Slow responses, excessive resource use, or degradation under stress |
| Security | Vulnerability, data leak, or authorization flaw |
| Compatibility | Behaviour specific to certain clients, versions, devices or environments |

Category is **derived from the flaw classification** by `categoryFor()`, so no existing
assertion had to be rewritten to gain one: `Security/*` is Security, everything else defaults
Functional. Pass `meta.category` to override. Nothing derives to `Performance` or
`Compatibility` — latency in `telemetry.ts` is observational with no defensible threshold on a
shared bench, and an API surface driven by one client shape has no compatibility axis to fail
on. Both stay override-only until a test asserts a budget or a second client shape it can
defend.

The rules that keep Critical meaningful:

- **Anonymous access** (`assertUnauthorized`) is only Critical when the response actually
  contained personal or credential fields (`SENSITIVE_RESPONSE_MARKERS`). Many KPOST routes
  are registration-time lookups — name availability, language lists — that *must* work
  before a token exists; `GET /` is a static landing page. Those are graded **Major** as a
  spec/implementation mismatch: either the route is public and swagger must say
  `security: []`, or the auth filter is missing. Both are real defects; neither is a breach.
- **Invalid input** (`assertRejectsInvalidInput`) is Critical only when the bad input was
  *accepted*. Being rejected with the wrong status code is **Minor**.
- **On this API, HTTP 200 says nothing about success.** Routes routinely answer 200 with
  `status: FAILURE`, and the RedBus tag has no `statusCode` field at all. Any severity
  heuristic keying on the transport status alone over-grades — `assertRejectsInvalidInput`
  and `assertNoReflectedScript` both read the envelope's `status` word for this reason.
- **Reflected script is not stored XSS.** A payload echoed into an error message on an
  `application/json` response is inert in a browser: graded **Major**. Persisted, or
  reflected into `text/html`, it executes: **Critical**.
- **A 5xx is not Critical on its own.** An unhandled server fault means the request reached
  code that did not expect it — that is **Major**, the band for internals disclosed and rules
  not enforced. It grants nothing and corrupts nothing, and the cases where a fault *does*
  spill a stack trace are already caught and graded by `assertNoInternalLeak`. `assertStatus`
  therefore defaults to `Major` for 5xx and `Minor` for a merely wrong 4xx/2xx; pass
  `meta.severity` when the endpoint's consequence is genuinely worse. Auto-grading every 500
  Critical put ~20 ordinary NPEs on the same list as the payment-signing oracle, and a P0 list
  nobody can triage is the same as no P0 list.
- **Masking a failure behind HTTP 200 is Major, not Critical.** `assertStatusCodeParity` and
  `assertNot200OKOnError` grade a masked 5xx and an exception trace as **Major** (a client
  believes a write landed that did not; monitoring never sees it) and a parity mismatch that
  hides nothing as **Minor**.

Bug ownership comes from `MODULE_BY_PATH` in the generated registry, which is derived from
the Swagger tag. Do **not** reintroduce URL-prefix guessing: KPOST routes do not match their
tag names (Company Administration is `/admin`, Kdiary is `/dairySchedule`), so prefix
matching silently routes tickets to the wrong team.

IDs are a **content hash** of `method + path + title`, not a counter: Playwright workers are
separate processes, so a counter would restart per worker and mint duplicates. The hash also
deduplicates a defect that hundreds of tests trip over, and stays stable across runs.

**Display/identity split — `identityTitle`.** When a finding sets `identityTitle`, *that*
string (not the human `title`) feeds the id, so the ticket's wording can be improved without
changing its id — and therefore without re-filing a ticket already open in Bugzilla.
`assertRejectsInvalidInput` uses it: its `title` now names the actual outcome (`Invalid input
accepted: …` for a 2xx, `… triggers a server error (HTTP 5xx) …` for a crash, `… rejected with
HTTP …` for a wrong code) so two genuinely different faults never share a summary, while
`identityTitle` stays pinned to the original `"<scenario> is not rejected with 400/422"`
fingerprint. That string is load-bearing — keep it byte-stable. To bring **already-filed**
tickets up to the new wording (the id is unchanged, so a re-run only comments), run
`npm run bugzilla:relabel:kpost` / `:admin` — dry run by default, `--apply --yes` to write.

Findings are written first to individual files under `.bug-cache/` using the exclusive `wx`
flag — an atomic create is what makes cross-worker deduplication reliable. Never replace this
with read-then-append; that races.

## Environment

`.env` (see `.env.example`). `BASE_URL` defaults to `http://localhost:8989`. The backend is
usually **live and stateful** — tests create real rows. Prefer read-only or self-cleaning
assertions, and keep destructive happy-paths behind throwaway identities.

## Gotchas

- TypeScript 7 + faker 10 (ESM-only) require `module: preserve` / `moduleResolution: bundler`
  in `tsconfig.json`. Switching to `node16` breaks the faker import.
- Payload builders take `Record<string, unknown>` overrides, not `Partial<T>` — fuzz tests
  deliberately submit wrong-typed values and a strict override type would forbid that.
- `noUnusedLocals`/`noUnusedParameters` are on; dead helpers fail the build.
