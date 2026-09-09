# KPOST API Test Bench — Operations Manual

Everything you need to run this suite, read its reports, and get them to the people who fix
the defects. Written for a QA engineer seeing this repo for the first time.

`README.md` is the short front door. This file is the depth.

> Anything in this document marked **⚠ Unverified** was written from source code or from the
> dashboard's own responses, but could not be proven by running it here. Everything else was
> executed against this repo on 2026-08-13.

---

## 1. What this test bench does

It fires ~4,584 hand-written API tests at the KPOST backend, hunting for real defects —
authentication bypasses, injection, IDOR, unvalidated input, contract violations. Every
confirmed defect is written to a ticket-ready ledger with a `curl` and a Playwright
reproduction attached. It then dispatches notifications and publishes the run to the external
QA Dashboard, where the history across every run lives.

There is no browser and no UI code: every test drives `APIRequestContext` directly.

```
  npm test
     │
     ▼
  [1] pretest gate ......... scripts/audit-vectors.ts
     │                       fails the run if mandatory vector coverage < 98%
     ▼
  [2] tests ................ 16 Playwright projects, one per Swagger tag
     │                       assertions record defects into .bug-cache/ (one file per defect)
     ▼
  [3] reports .............. BUG_REPORT.md/.json · DEV_DIGEST · executive HTML
     │                       trend history · bug payloads · JUnit XML · traces
     ▼
  [4] dispatch ............. email · chat webhook · issue tracker
     │                       each skips with one line when unconfigured
     ▼
  [5] publish .............. POST BUG_REPORT.json ──▶ external QA Dashboard
                             logs the dashboard's runId
```

Steps 3–5 all happen automatically in the reporters' `onEnd`, in that order. The order is
load-bearing: each stage reads what the one before it wrote.

---

## 2. One-time setup

### Requirements

| | Version here | Check |
| --- | --- | --- |
| Node.js | v20.19.4 | `node -v` |
| npm | 10.8.2 | `npm -v` |

No Java, no database, no Docker. The bench writes files and makes HTTP calls, nothing else.

### Install

```bash
npm install
cp .env.example .env
```

Then open `.env` and fill it in.

### What each variable means

**Target environment** — the only two you must set to run anything:

| Variable | Meaning |
| --- | --- |
| `BASE_URL` | The API to test, e.g. `http://localhost:8989`. |
| `TEST_ENV` | Environment label: `Local`, `QA`, `Staging`. **It appears on every report header and is what the QA Dashboard groups runs by.** Inferred from `BASE_URL` if unset. |
| `API_TIMEOUT` | Per-request timeout, ms. Default 60000 — deliberately not 30000, because signup has been measured above 30s under load. |
| `TEST_WORKERS` | Parallel workers locally (default 4). CI is pinned to 2. |

**Authentication** — the suite tries these in order and never silently skips:

| Variable | Meaning |
| --- | --- |
| `QA_KPOST_ID` / `QA_PASSWORD` | **The only auth config that belongs in `.env`.** An account that exists on `BASE_URL`. |
| `QA_USER_TYPE` | `loginRO.userType` — `PERSONAL`, or the size-suffixed tier (`BUSINESS_M`) for a company identity. |
| `QA_DEVICE_ID` | Optional. Derived from (`BASE_URL`, `QA_KPOST_ID`) when unset, so the bench presents one stable device. |
| `TOKEN_REFRESH_SKEW_SECONDS` | Refresh a token with less life than this rather than carrying it into a run. Default 600. |
| `ALLOW_UNAUTHENTICATED_RUN` | `1` to let a run proceed with no session. Default `0` — the run aborts. |
| `QA_AUTH_TOKEN` | **Escape hatch only.** Never refreshed, never cached; it will die mid-run. |
| `TEST_MOCK_OTP` / `TEST_MOCK_OTP_FALLBACK` | The fixed OTP codes test environments accept. |

Tokens are **not** configuration. `globalSetup` mints one per run and caches it in
`.auth/session.json`, scoped to `BASE_URL`; workers reuse it and it refreshes before expiry.
Pasting a token into `.env` is what broke this suite — see `docs/AUTHENTICATION.md`.

If no session can be established the run aborts before a single assertion executes, rather
than publishing a report about coverage it never ran. When login is refused, run
`npm run auth:diagnose`: KPOST reports "no such account", "wrong password", "account not
active" and "wrong environment" with one identical message, and only elimination separates
them.

**Safety** — do not point these at anything real:

| Variable | Meaning |
| --- | --- |
| `TEST_MOBILE` / `TEST_EMAIL` | Every OTP-sending test is pinned to these. The suite fires those endpoints hundreds of times per run; a random 10-digit Indian number is a real subscriber. |

**QA Dashboard** — where runs are published:

| Variable | Where to get it |
| --- | --- |
| `DASHBOARD_INGEST_URL` | The dashboard's ingest endpoint, e.g. `http://localhost:8081/api/ingest`. |
| `DASHBOARD_API_KEY` | A per-application token from the dashboard's **Applications** page. ⚠ Unverified — I could not open that page from here; confirm the exact location with whoever runs the dashboard. |

Both unset is fine: publishing logs one skip line and the run is unaffected.

**Bugzilla filing** — where defects get filed as bugs. See §4.8.

| Variable | Where to get it |
| --- | --- |
| `BUGZILLA_URL` | The REST API base, e.g. `http://192.168.0.50/bugzilla/rest`. |
| `BUGZILLA_API_KEY` | A Bugzilla API key for an account with `editbugs` on the target product. |
| `BUGZILLA_PRODUCT` | Defaults to `KPost API`. Must already exist in Bugzilla. |
| `BUGZILLA_VERSION` | Defaults to `unspecified`. |
| `BUGZILLA_DRY_RUN` | `true` logs the mapped fields for every defect and makes no API calls at all — review this before ever setting it back to `false` against a new Bugzilla instance. |

`BUGZILLA_URL` and `BUGZILLA_API_KEY` are both-or-neither: unset (either one) logs one skip
line and the run is unaffected, exactly like the QA Dashboard.

**Notifications** — all optional, all skip cleanly when unset. See §5.

`SMTP_HOST` `SMTP_PORT` `SMTP_USER` `SMTP_PASS` `SMTP_FROM` `SMTP_SECURE` `DEV_EMAIL_RECIPIENTS`
`WEBHOOK_URL` `TRACKER_API_KEY` `PLANE_*` / `REDMINE_*`

**Set by tooling — never by hand:** `KPOST_RUN_SEED`, `CI`, `BUILD_ID`, `BUILD_NUMBER`,
`GITHUB_RUN_ID`, `CI_PIPELINE_ID`.

### Verify setup worked

```bash
npm run typecheck                    # must print nothing and exit 0
npm run audit:vectors                # must end with: [vectors] PASS
curl -s -o /dev/null -w '%{http_code}\n' "$BASE_URL/"   # backend reachable?
npm run test:common                  # smallest useful real run, ~1.5 min
```

If the last one ends with `[KPOST Dashboard] run published - dashboard runId N`, the whole
chain works.

---

## 3. Running tests — every command

| Command | Runs | When to use | Duration |
| --- | --- | --- | --- |
| `npm test` | Everything, ~4,584 tests, **plus the pretest coverage gate** | Before a release; the definitive run | ~35 min † |
| `npm run test:no-signup` | 4,481 tests — everything except registration specs | Environments that must not receive new accounts | 33.9 min ✓ |
| `npm run test:skip-audit` | Everything, skipping the coverage gate | Only when you already know the gate passes | ~35 min † |
| `npm run test:auth` | `auth` — 239 tests | Login, signup, OTP, tokens | ~2 min † |
| `npm run test:profile` | `profile` — 715 tests (largest) | Profile, images, device OTP | ~4 min † |
| `npm run test:common` | `common` — 437 tests | Lookups, enquiry, PIN, forgot-password | 1.5 min ✓ |
| `npm run test:integrations` | `integrations` — 326 tests | Cross-module flows | ~2 min † |
| `npm run test:dashboard` | `dashboardV2` — 101 tests | Dashboard endpoints | ~1 min † |
| `npm run test:knews` | `knews` — 110 tests | KNews | ~1 min † |
| `npm run test:settings` | `generalSettings` — 132 tests | Settings | ~1 min † |
| `npm run test:groups` | `groupsV2` — 227 tests | Groups | ~2 min † |
| `npm run test:admin` | `companyAdministration` — 260 tests | Company admin (`/admin`) | ~2 min † |
| `npm run test:contacts` | `contactsDirectoryV2` — 308 tests | Contacts directory | ~2 min † |
| `npm run test:kword` | `kwordDocuments` — 190 tests | KWord documents | ~2 min † |
| `npm run test:kpresentation` | `kpresentation` — 94 tests (smallest) | KPresentation | ~1 min † |
| `npm run test:kdiary` | `kdiary` — 270 tests (`/dairySchedule`) | KDiary | ~2 min † |
| `npm run test:kall` | `kallV2` — 339 tests | KAll | ~2 min † |
| `npm run test:redbus` | `redbus` — 235 tests | **RedBus — a LIVE booking integration.** Refusal paths only | ~2 min † |
| `npm run test:katchup` | `katchupV2` — 600 tests | KatchUp | ~4 min † |
| `npm run test:list` | Enumerates every test as JSON **on stdout** — it writes no file, so redirect it if you want one: `npx playwright test --list --reporter=json > list.json` | Checking test counts per project | ~15 s ✓ |
| `npm run audit:vectors` | The coverage gate alone | After adding or deleting tests | ~10 s ✓ |
| `npm run seed` | Registers a throwaway account on `BASE_URL` | Bootstrapping an empty database | ~1 min † |
| `npm run auth:check` | Preflight — will the suite authenticate? | Before any full run | ~5 s ✓ |
| `npm run auth:diagnose` | Names the exact reason login is refused | When `auth:check` fails | ~10 s ✓ |
| `npm run auth:diagnose:all` | Same, swept across every host this repo has targeted | When the account may live elsewhere | ~30 s † |
| `npm run auth:reset` | Discards the cached session so the next run re-mints | After changing credentials or `BASE_URL` | instant ✓ |

✓ measured here. † estimated from test counts — **only the two ✓ rows were timed**.

### One spec, or one test

```bash
npx playwright test tests/common/common.spec.ts
npx playwright test tests/common/common.spec.ts -g "sendOTP"
npx playwright test tests/kdiary/ --repeat-each=3 --workers=1   # confirm flakiness
```

### Debugging a failure

```bash
npx playwright test tests/common/common.spec.ts -g "sendOTP" --debug
```

This is an API suite, so there is **no browser window** — the inspector steps through test
code, and the request/response detail lives in the trace viewer (§4.6). ⚠ Unverified: I did not
execute `--debug` in this audit.

> **Never pass `--reporter=line`.** It replaces *all* configured reporters, so no report tier
> is produced and `BUG_REPORT.md` is left at the stub `globalSetup` wrote.

### Switching environment

Edit `.env`, or override per command:

```bash
BASE_URL=https://qa.kpost.example TEST_ENV=QA npm run test:common
```

`TEST_ENV` flows into every report header **and** into the QA Dashboard as the environment the
run is grouped under. Set it whenever you change `BASE_URL`, or runs against two environments
will be filed together.

### Two gotchas that cost real time

**`test:no-signup` does not run the coverage gate.** npm's `pretest` hook only fires for the
script literally named `test`. If you use the no-signup variant, run `npm run audit:vectors`
yourself.

**Never run two suites at once on one machine.** Both use the fixed path `.bug-cache/`, and the
first to finish deletes it — the second then produces a plausible-looking report with most of
its defects missing. This has happened here: a concurrent run left a full suite reporting 90
defects and 33 endpoints when the true figures were far higher.

---

## 4. Reports — the complete list

Everything below is produced automatically per run unless marked on-demand.

### 4.1 `BUG_REPORT.md` — the bug ledger *(root, automatic)*

Markdown. The primary human deliverable: an executive summary table, defect counts by
severity / priority / module / owner / classification, a release verdict, and then one
itemised ticket per defect containing severity, owner, endpoint, description, business risk,
steps to reproduce, expected vs actual, a **copy-pasteable `curl`**, and a Playwright snippet.

**For:** backend developers and security SDETs. **Generated — never edit by hand.**

### 4.2 `BUG_REPORT.json` — machine twin *(root, automatic)*

Same content, no rendering: `generatedAt`, `environment`, `baseURL`, `run` (totals, duration,
`endpointsExercised`, auth strategy), `summary` (five tallies) and `defects[]` with 18 fields
each. This is also the exact document POSTed to the QA Dashboard.

`environment` is the **short label** — `Local` / `QA` / `Staging` / `Production`, or whatever
`TEST_ENV` says — resolved by `src/utils/environment.ts`, the same helper the executive report
uses. The full target URL is published alongside it as `baseURL`. Set `TEST_ENV` per environment:
this label is what the dashboard groups runs by, so two hosts that mean the same environment must
carry the same label.

**For:** CI jobs, tracker importers, the dashboard.

### 4.3 `DEV_DIGEST.md` / `.json` — triage summary *(root, automatic)*

The short version: pass/fail ratios, a verdict line (`DO NOT SHIP — 15 critical defects
open`), and breakdowns by severity, module and owner. The `.json` also carries ready-to-send
Slack, Teams and Discord payloads. Regenerable standalone from `BUG_REPORT.json`.

**For:** engineering leads and module owners — the thing to paste into a channel.

```bash
npm run notify        # prints the digest to the terminal
```

On a tree with no run yet this exits 1 with `No DEV_DIGEST.md found. Run npm test first.` —
that is the command working correctly, not a fault. `npm run report:executive` behaves the same
way.

### 4.4 `SUITE_SCORECARD.md` — suite health *(root, on-demand)*

Suite grade, endpoint coverage against `swagger.json`, duplicate-test audit, artifact
checklist, release verdict. Describes the **test suite's** quality, not the API's.

```bash
npm run scorecard
```

Self-contained: it compiles itself, enumerates the tests into `.scorecard-build/` and writes
the file. Run it **after** a suite run for full marks — it measures coverage from run artifacts,
so on a freshly cleaned tree the coverage rows score 0 for lack of evidence rather than for lack
of tests.

**For:** QA leads, CTO/VP Eng.

### 4.5 `reports/runs/<run>/kpost-executive-summary.html` — executive report *(automatic)*

Self-contained, KPOST-branded HTML: a defect-led narrative with severity, ownership,
reproduction, filters and tabs. No server needed — open the file. Also mirrored to
`reports/latest/`, and it is the file the email dispatcher attaches.

```bash
npm run report:executive     # prints the path to the newest one
```

**For:** engineering leads and management.

### 4.6 `reports/runs/<run>/diagnostic/index.html` — Playwright's own report *(automatic)*

Per-test steps and, uniquely, the **trace viewer** — replay the exact request and response of
a failed call, with the spec source that issued it. Nothing else here replicates this.

```bash
npm run report
```

**For:** whoever is actually debugging.

### 4.7 The QA Dashboard — external *(automatic after each run)*

Cross-run history, trends, and multi-project rollups live outside this repo, in the QA
Dashboard. `reporters/dashboard-ingest.ts` POSTs `BUG_REPORT.json` at the end of every run and
logs the dashboard's own id:

```
[KPOST Dashboard] run published - dashboard runId 5
```

Open it at the host in your `DASHBOARD_INGEST_URL` (here: `http://localhost:8081`).
⚠ Unverified: the dashboard's pages, its Applications page and its export buttons live in a
separate repository that I could not inspect — its read API returned 401 to the ingest token,
so read access is separate from ingest access.

**For:** everyone — it is the only place that answers "is this getting better or worse?"

### 4.8 Bugzilla filing — external *(automatic after each run)*

`reporters/dashboard-bugzilla.ts` files every defect in `BUG_REPORT.json` into Bugzilla over
its REST API at the end of the run — a pure API producer, it never touches Bugzilla's
database. Skips with one log line when `BUGZILLA_URL` / `BUGZILLA_API_KEY` are unset; a
Bugzilla outage is a logged warning per defect, never a failed run:

```
[bugzilla] filed 35 new, commented 0 existing, 0 failed (of 35 defects)
```

**Field mapping:** `product` is `BUGZILLA_PRODUCT` (fixed per bench); `component` is the
defect's `module` string verbatim — this is why Bugzilla's component names must match this
suite's module names exactly (see below); `summary` is `[<id>] <title>`, where `<id>` is the
defect's stable content hash (`BUG-API-XXXXXX`), never the positional `displayId` — a
positional id renumbers between runs and would silently break dedup; `severity`/`priority`
map from this suite's `Critical/Major/Minor/Trivial` and `P0-P3` through a fixed table, confirmed
against the live instance's `GET /rest/field/bug/bug_severity` and `GET /rest/field/bug/priority`
(`critical/major/minor/trivial` and `Highest/High/Normal/Low` respectively — re-confirm these
if Bugzilla's own field values are ever changed). `blocker` is deliberately never emitted:
Bugzilla reserves it for "blocks development or testing work", a statement about our pipeline
rather than about the product under test.

**Defect category** — `Functional`, `Performance`, `Security` or `Compatibility` — has no
native Bugzilla field, so it rides in the Status Whiteboard as `[cat:<Category>]` (the only tag
written there, e.g. `[cat:Security]`). Whiteboard rather than `keywords` because keywords must
be pre-defined by an administrator, and filing with an unknown keyword is rejected outright —
this bench must not depend on an admin step having been run. The whiteboard is
substring-searchable, so a triage queue is `whiteboard contains cat:Security`. **This format is
a contract with the BUGZILLA-UI repo**, whose backend parses this tag back into a structured
filter — change both or neither.

Defects are classified on the two production axes only — **severity** (impact: the native
`bug_severity`/`priority` fields) and **category** (type: the `[cat:]` tag) — plus the owning
**module** (the Bugzilla component). The former `[tierN]` business-tier tag was removed:
module criticality is already carried by a defect's severity and shown by its component, so a
third coarse axis only added noise.

**One ticket per defect, with its blast radius.** A grouped defect files once and carries an
`Affected endpoints (N)` block listing every route that exhibits it, the modules it spans, and
its distinct observed behaviours. The description truncates that list at 40 rows for
readability; the attached `<id>-repro.txt` carries it complete.

**Dedup:** live, not a local ledger. Before filing, the reporter searches Bugzilla for an open
bug whose summary already contains the `[<id>]` tag. Found → posts an "observed again in run
&lt;date&gt;, environment &lt;env&gt;" comment instead of creating a duplicate. Not found →
creates the bug and attaches `<id>-repro.txt` (request headers/body, expected, actual, curl).
On a commented bug the same attachment is only added if a file of that name isn't already
there, so re-running the suite every night never piles up duplicate attachments. This is also
why re-running the reporter against an unchanged `BUG_REPORT.json` is the way to prove dedup
is working: it should report `0 created / N commented`.

**Assignment** is deliberately never set by this bench (no `assigned_to` in the create call —
Bugzilla's own per-component default assignee handles it. To add a new module's filing
target: create the matching component under the `BUGZILLA_PRODUCT` product in Bugzilla, named
**exactly** like the module string that appears in `BUG_REPORT.json` (see `MODULE_BY_PATH` in
the generated registry for what that string will be), and set that component's default
assignee. Nothing in this repo needs to change — the mapping is `defect.module` → Bugzilla
component name, verbatim, with no lookup table to update.

Standalone (no full suite run needed): `npm run bugzilla:file` reads the existing root
`BUG_REPORT.json` directly — useful for re-proving dedup or checking a mapping with
`BUGZILLA_DRY_RUN=true` without waiting on a ~16-minute run.

**Reconciling tickets filed before grouping existed.** The bench previously filed one ticket
per *failing test*, which put 1283 open bugs into a product describing roughly 565 real
defects. `npm run bugzilla:reconcile` maps those old tickets onto the new grouped ids — it
recovers the fingerprint from each bug's own summary and `Classification:` line, so no local
ledger from the original run is needed — then keeps the lowest-numbered bug in each group and
marks the rest RESOLVED/DUPLICATE against it.

It is **dry-run by default and prints the whole plan**. Writing requires `--apply --yes`
together, because Bugzilla's REST API has no delete and every write is one-way. Stage it:

```bash
npm run bugzilla:reconcile -- --limit 20
```

inspect the twenty groups it names, then re-run the same command with `--apply --yes` before
lifting the cap. Re-running is safe — an already-resolved duplicate is skipped, and a bug whose
summary carries no `[BUG-API-…]` tag is never touched.

**Relabeling already-filed ticket summaries.** `assertRejectsInvalidInput` now titles a finding
by its actual outcome — `Invalid input accepted: …` (HTTP 2xx), `… triggers a server error
(HTTP 5xx) …`, or `… is rejected with HTTP … instead of 400/422` — so two different faults never
share a summary. The defect **id is unchanged** (it is pinned to the original fingerprint via
`identityTitle`, so a re-run only comments), but tickets filed under the old wording keep their
old summary until relabeled. `npm run bugzilla:relabel:kpost` (and `:admin` for the admin bench)
derives the new title from each defect's classification + observed status in the current
`BUG_REPORT.json` and updates the matching ticket's summary in place, keyed by its `[BUG-API-…]`
tag — the tag, and therefore dedup, is untouched. Dry-run by default; `--apply --yes` to write,
`--limit N` to stage. See `identityTitle` in `CLAUDE.md`.

**For:** the Bugzilla-using QA/dev team, alongside or instead of the Plane/Redmine dispatcher.

### Also produced, easy to miss

| Artifact | What it is |
| --- | --- |
| `test-results/results.xml` | JUnit XML for CI pass/fail gating (Jenkins, GH Actions, GitLab) |
| `reports/kpost-trend-history.json` | Append-only, one metrics point per run, **kept forever** — survives run-folder pruning |
| `reports/runs/<run>/kpost-bug-payloads.json` | REST-ready issue payloads, one per defect, POSTable straight at Plane/Redmine/Jira |
| `reports/runs/<run>/kpost-run-model.json` | The joined run model tiers 2–4 are projected from — re-derive any artifact without re-running |
| `reports/latest/` | Mirror of the newest run plus `run.json`, the pointer dispatchers resolve through |
| `reports/dispatched-bugs.json` | Which defects have already been filed in the tracker, keyed by content hash — what makes a nightly schedule safe |

Run folders are timestamped in **UTC** and capped by `KPOST_RUN_RETENTION` (default 20). Tier 3
keeps the metrics for every run forever, so pruning loses evidence, never the trend line.

### Summary

| Report | Format | Audience | Generated |
| --- | --- | --- | --- |
| `BUG_REPORT.md` | Markdown | Backend devs, security SDETs | Automatic |
| `BUG_REPORT.json` | JSON | CI, trackers, dashboard | Automatic |
| `DEV_DIGEST.md` / `.json` | Markdown / JSON | Eng leads, module owners | Automatic |
| `SUITE_SCORECARD.md` | Markdown | QA leads, CTO/VP Eng | On demand — `test:list` + `scorecard` |
| Executive summary HTML | HTML | Leads, management | Automatic |
| Diagnostic report + traces | HTML | Whoever is debugging | Automatic |
| QA Dashboard | Web app | Everyone | Automatic (POST per run) |
| Bugzilla bugs | Bugzilla | Bugzilla-using dev/QA team | Automatic (filed per run, deduped) |
| `results.xml` | JUnit XML | CI gating | Automatic |
| Trend history | JSON | Dashboards | Automatic (append) |
| Bug payloads | JSON | Tracker importers | Automatic |

---

## 5. Sending reports to developers

### Which report for which situation

| Situation | Send |
| --- | --- |
| New failures found | `BUG_REPORT.md` + the digest. The ledger has the `curl`; the digest says who owns what. |
| Management asks for status | Executive HTML + `SUITE_SCORECARD.md`. Never the raw ledger. |
| A developer needs reproduction detail | That defect's section of `BUG_REPORT.md` (or its `BUG_REPORT.json` entry), plus its dashboard defect page. The `curl` reproduces it without checking out this repo. |
| "Is quality improving?" | The QA Dashboard's monthly trend. Single-run files cannot answer this. |
| CI gate | `test-results/results.xml`. |

### The automatic channels

All three fire from the master reporter's `onEnd` and are fail-safe: they return a result,
never throw, and print one line when unconfigured. **Out of the box this suite sends nothing.**

```
[KPOST Reporter] Email dispatch skipped - SMTP_HOST not configured
[KPOST Reporter] Webhook dispatch skipped - WEBHOOK_URL not configured
[KPOST Reporter] Bug dispatch skipped - neither PLANE_API_URL nor REDMINE_API_URL configured
```

Those lines mean the wiring is healthy and the credentials are absent — not that dispatch is
broken.

**Email** — set `SMTP_HOST`, `SMTP_PORT`, `SMTP_USER`, `SMTP_PASS` and
`DEV_EMAIL_RECIPIENTS` (comma-separated). Recipients get an HTML digest in the body and the
**executive HTML attached**, so it opens offline. Subject line:

```
[KPOST] QA API run — 102 FAILED, 74.7% pass, 97 defects
```

It speaks SMTP directly — implicit TLS on 465, STARTTLS otherwise, AUTH LOGIN or PLAIN — so no
mail library is installed. ⚠ Unverified: no SMTP host is configured here, so this was read from
source, not executed.

**Chat webhook** — set `WEBHOOK_URL`. The payload shape is chosen from the host: Office/Teams
URLs get a MessageCard, everything else (Slack, Mattermost) gets `{text}`.

**Issue tracker** — set `TRACKER_API_KEY` plus either `PLANE_*` or `REDMINE_*`. Files **one
ticket per defect, once**, recorded in `reports/dispatched-bugs.json` by content hash. Without
that ledger a nightly schedule re-files every finding every night.

### Testing a channel without spamming anyone

- **Email:** point `DEV_EMAIL_RECIPIENTS` at your own address only, and use a scratch SMTP
  account. Confirm with a one-project run (`npm run test:common`) rather than the full suite.
- **Webhook:** create a throwaway channel and use its incoming-webhook URL, or post the digest
  by hand with no test run at all:

  ```bash
  curl -X POST -H 'Content-Type: application/json' \
    -d "{\"text\": $(node -e "process.stdout.write(JSON.stringify(require('fs').readFileSync('DEV_DIGEST.md','utf-8').slice(0,3000)))")}" \
    "$WEBHOOK_URL"
  ```

- **Tracker:** point it at a scratch project. Delete `reports/dispatched-bugs.json` to re-file
  deliberately; keep it to never double-file.

### Sharing files by hand

After any run:

| File | Where |
| --- | --- |
| Bug ledger | `BUG_REPORT.md` / `.json` (repo root) |
| Digest | `DEV_DIGEST.md` (repo root) |
| Scorecard | `SUITE_SCORECARD.md` (repo root) |
| Executive HTML | `npm run report:executive` prints the path |
| Traces | `npm run report` opens it |

The executive HTML is self-contained — one file, no assets — so it attaches to mail or a ticket
and opens anywhere.

**Excel/CSV from the dashboard:** open the dashboard's daily report, filter to the day, and use
its export control to download CSV, then attach that to the mail or ticket.
⚠ **Unverified** — the dashboard is a separate repository whose UI I could not open from here.
Confirm the exact button and file format with whoever maintains it before relying on this step.

### Daily routine

```
1. Confirm no other run is in progress, then:  npm test
2. Open the QA Dashboard daily report for today
3. Review defects marked new — those appeared for the first time in this run
4. npm run notify   → paste the digest to the dev channel, or let the email dispatcher send it
5. For each critical/major defect: file or update its ticket, using the curl from BUG_REPORT.md
6. Track fixes by re-running the affected module (e.g. npm run test:auth) and checking the
   defect's occurrence count stops increasing in the dashboard
```

---

## 6. Troubleshooting

### 1. The environment is not reachable

**Symptom:** mass failures, `ECONNREFUSED`, or every test failing identically.

```bash
curl -s -o /dev/null -w '%{http_code}\n' "$BASE_URL/"
```

Anything other than a status code means the backend is down or `BASE_URL` is wrong. Fix
`.env`; do not "fix" the tests. Note that on this API a 403 does not mean unreachable — many
routes answer 403 by design.

### 2. Dashboard ingest returns 401

**Symptom:** `[KPOST Dashboard] ingest skipped - HTTP 401 Unauthorized`.

`DASHBOARD_API_KEY` is wrong, revoked, or belongs to a different application. Reissue it from
the dashboard's Applications page and update `.env`. A 422 instead means the payload was
rejected — the log line now names the field, e.g. `run.durationMs: Required`.

**The run itself is unaffected.** Reports are already written; only publishing failed.

### 3. Ingest connection refused

**Symptom:** `[KPOST Dashboard] ingest skipped - fetch failed`.

The dashboard is down or the URL is wrong. **The test run completes normally and every file
report is written** — publishing is the last step and cannot fail a run. Start the dashboard
and re-publish by re-running, or leave it: the next run publishes the newer data anyway.

### 4. Report files are missing or say "run in progress"

Three causes, in order of likelihood:

1. `--reporter=line` was passed, replacing every configured reporter.
2. `playwright test --list` (or `npm run test:list`) ran *after* the suite — it triggers
   `globalSetup`, which resets `BUG_REPORT.md` to a stub.
3. The run was killed before `onEnd`.

All three are fixed by re-running the suite. If `BUG_REPORT.md` was committed previously,
`git checkout HEAD -- BUG_REPORT.md BUG_REPORT.json` restores the last good one.

### 5. `.env` changes seem to have no effect

`.env` is read once at config load. Anything already running keeps the old values — stop the
run and start again. If a variable still looks ignored, check it is not also set in your shell:
a real environment variable wins over `.env`, by design, so CI can override it.

### Bonus: `npm run` exits 1 printing nothing

**Symptom:** any `npm run <script>` exits 1 with only the npm banner — even `typecheck`, whose
`tsc --noEmit` passes when run directly.

**Cause:** npm resolves its script shell from `ComSpec`, which Git Bash does not set. npm then
throws `ERR_INVALID_ARG_TYPE` *before your script runs*, and the error goes only to
`%LOCALAPPDATA%\npm-cache\_logs\*-debug-0.log`.

**Fix:** run npm from PowerShell or CMD, which set `ComSpec` natively. From Git Bash:

```bash
ComSpec="C:\Windows\System32\cmd.exe" npm test
```

Also never pipe npm to `tail` without `set -o pipefail` — the pipe returns *tail's* exit
status and hides the failure.

### Stale processes hold `test-results/`

```powershell
Get-NetTCPConnection -State Listen -LocalPort 8081 | Select-Object OwningProcess
```

```bash
npm run clean
```

Never chain cleanup and execution with `&&`: if cleanup fails on a file lock, `&&` skips the
test run and you get an empty result set that looks like a pass.

---

## Reference

| Doc | For |
| --- | --- |
| `README.md` | What this is, in one screen |
| `CLAUDE.md` | Architecture, conventions, severity grading, known API behaviours |
| `docs/V1_DECOMMISSION_RISK.md` | **Open risk** — the deprecated V1 routes are still mounted (they answer 403, not 404) |
| `docs/api.json` | QA tracker export: real request/response bodies |
| `docs/archive/` | Superseded docs, kept for history |
| `swagger.json` | The API contract. Stays at the root — two scripts use it to locate the repo root |
