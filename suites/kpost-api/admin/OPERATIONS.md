# KPOST Admin Module Test Bench — Operations Manual

Everything you need to run this suite, read its reports, and get them to the people who fix the
defects. Written for a QA engineer seeing this repo for the first time.

`README.md` is the short front door. This file is the depth.

> Anything marked **⚠ Unverified** was written from source code or from another system's
> responses but could not be proven by running it here. Everything else was executed against
> this repo on 2026-08-13, against a live backend at `http://localhost:9595`.

---

## 1. What this test bench does

It fires hand-written API tests at the KPOST **Admin Module** backend — the tenant (company)
administration service that owns organisation set-up, workplace and HR hierarchies, employee
master data, role postings, product licensing and user onboarding. It hunts for real defects:
authentication bypass, injection, IDOR, unvalidated input, contract violations. Every confirmed
defect is written to a ticket-ready ledger with a `curl` and a Playwright reproduction attached.

There is no browser and no UI code: every test drives `APIRequestContext` directly. The backend
is Java/Spring Boot, which changes nothing here — this is black-box HTTP testing from outside.

```
  npm test
     │
     ▼
  [1] pretest gate ......... scripts/audit-vectors.ts
     │                       fails the run if mandatory vector coverage < 98%
     ▼
  [2] tests ................ 11 Playwright projects covering all 24 functional tags
     │                       assertions record defects into .bug-cache/ (one file per defect)
     ▼
  [3] safety net ........... files a record for failing tests that filed none themselves
     │                       (a plain expect() rather than an assertion helper)
     ▼
  [4] validity gate ........ did this run actually happen? zero tests, a load error or a
     │                       part-way collapse stops everything below here
     ▼
  [5] reports .............. BUG_REPORT.md/.json · DEV_DIGEST · executive HTML
     │                       trend history · bug payloads · JUnit XML · traces
     ▼
  [6] dispatch ............. email · chat webhook · issue tracker
     │                       each skips with one line when unconfigured
     ▼
  [7] publish .............. POST BUG_REPORT.json ──▶ external QA Dashboard
                             REST Bug.create      ──▶ Bugzilla ("KPost Admin")
```

Steps 3–7 happen automatically in the reporters' `onEnd`, in that order. **The order is
load-bearing**: each stage reads what the one before it wrote. See CLAUDE.md → "The reporting
engine" for why.

Step 4 is the one worth understanding before you trust a quiet report. A bench that cannot run
produces exactly the same artifact as a healthy API — an empty defect list — and on a trend line
that reads as *improvement*. The gate makes silence loud instead.

### What makes this module different from the main KPOST bench

Two divergences matter operationally:

- **Login issues no token.** `userDetails/login` returns identity fields only. A session is
  acquired from `QA_AUTH_TOKEN`, or by **minting an HS256 JWT locally** from
  `ADMIN_JWT_SECRET`. If that secret does not match the server's signing key, the run silently
  drops to unauthenticated — which looks like an improvement (fewer defects) and is the
  opposite. Check the digest header says something other than `Authentication | NONE`.
- **The envelope is `{ value, status, statusCode, urlPath, error? }`** and the API answers
  **HTTP 200 or 500 only — never 404**. So a 200 tells you nothing. Every assertion reads the
  envelope's `status` word, not the transport status.

---

## 2. One-time setup

### Requirements

- Node.js 20+ (verified on v20.19.4)
- The Admin Module backend reachable at `BASE_URL` (default `http://localhost:9595`)
- Its liveness page answers at `GET /` — "Admin Application is Up and Running!!"

### Install

```bash
npm install
cp .env.example .env
```

Then edit `.env`. The variables that actually matter on day one:

| Variable | Why it matters |
| --- | --- |
| `BASE_URL` | Target API. Default `http://localhost:9595`. |
| `TEST_ENV` | The label on every report header **and the QA Dashboard's grouping key**. Inferred from `BASE_URL` when unset (`localhost` → `Local`). Never a raw URL. |
| `ADMIN_JWT_SECRET` | **The one to get right.** Must match the server's signing key or every run is unauthenticated. The `.env.example` value is the checked-in dev secret; a shared QA or production backend will differ. |
| `QA_KPOST_ID` / `QA_COMPANY_ID` | The identity baked into a minted token. `companyID` is what tenant-scoped endpoints read. |
| `QA_AUTH_TOKEN` | A real already-issued token. Preferred over minting; `npm run seed` writes it here. |
| `TEST_MOBILE` / `TEST_EMAIL` | Safe destinations. `userDetails/sendOTP` reaches a **real handset and costs money** — these keep every OTP test pointed at one number you control. |
| `KPOST_VECTOR_THRESHOLD` | Coverage gate percentage (default 98). `npm test` fails below it. |
| `DASHBOARD_INGEST_URL` / `DASHBOARD_API_KEY` | Publish to the QA Dashboard. Both unset = ingest skips cleanly. Get the key from the Dashboard's Applications page for slug **`kpost-admin`**. |
| `BUGZILLA_URL` / `BUGZILLA_API_KEY` | File defects into the **`KPost Admin`** Bugzilla product. Both unset = filing skips cleanly. |
| `BUGZILLA_DRY_RUN` | Ships as `true`. Filing is irreversible, so real filing is an explicit opt-in — see §6.3. |
| `KPOST_MIN_TESTS` | Optional absolute floor for the validity gate. Set it in CI, where the expected suite size is known. |

### Verify setup worked

```bash
npm run typecheck            # must print nothing and exit 0
npm run test:unit            # 26 offline unit tests for the bench's own reporting code
npm run audit:vectors        # prints the coverage bar; exits 1 if below threshold
npm run check:integrations   # ~5s: is Bugzilla reachable? is the QA Dashboard?
npm run test:departments     # smallest useful real run against the backend
```

If the last command reports far fewer defects than expected, check the authentication line in
`DEV_DIGEST.md` before believing the API improved.

**`npm run typecheck` passing does not mean the suite can run.** tsconfig's `module: preserve`
is not what Playwright uses for its runtime transform, so an import that is fine to `tsc` can
still throw at *collection* time and leave the suite executing zero tests — which is exactly
what an ESM-only dependency does here (see Troubleshooting §7.8). Only actually running a project
proves the specs load.

---

## 3. Running tests — every command

| Command | What it does |
| --- | --- |
| `npm test` | Full suite. Runs the vector gate first via `pretest`, then all 11 projects, then every report tier and dispatcher. |
| `npm run test:<tag>` | One project. `users`, `departments`, `designations`, `rolePostings`, `locations`, `employees`, `holidays`, `products`, `workplace`, `hr`, `reference`. |
| `npm run test:list` | Enumerate every test as JSON without running anything. Pins `--reporter=json` so it can never clobber `BUG_REPORT.md`. |
| `npm run test:no-onboarding` | Skips the specs that create accounts or send messages — see below. |
| `npm run test:skip-audit` | Bare `playwright test`, bypassing the `pretest` coverage gate. |
| `npm run audit:vectors` | The gate alone. `-- --json` writes `.audit-build/gaps.json`. |
| `npm run scorecard` | Writes `SUITE_SCORECARD.md` from measured facts. |
| `npm run seed` | Establishes a session and writes `QA_AUTH_TOKEN` into `.env`. Opt-in only. |
| `npm run clean` | Removes `test-results`, `.bug-cache`, `.audit-build`, `.scorecard-build`, `.dispatch-build`. Never touches `reports/`. |
| `npm run typecheck` | `tsc --noEmit`. Must be clean before any commit. |
| `npm run check:integrations` | Read-only preflight for Bugzilla and the QA Dashboard. Creates nothing. |
| `npm run provision:integrations` | Creates this bench's Bugzilla product and dashboard application. Dry run unless given `-- --apply --yes`. |
| `npm run dashboard:push` | Re-POST the current `BUG_REPORT.json`. Idempotent. |
| `npm run bugzilla:file` | File the current `BUG_REPORT.json` into Bugzilla by hand. |
| `npm run bugzilla:close-fixed` | Resolve tickets whose defect no longer reproduces. Dry run by default. |
| `npm run bugzilla:repair-refiled` | Fold a re-filed duplicate back into its original. Dry run by default. |
| `npm run test:unit` | Offline unit tests for the bench's own code (`reporters/__tests__`). Its own config, deliberately — see below. |

`test:unit` uses `playwright.unit.config.ts` rather than being a project in the main config,
because the main config's `globalSetup` resets the bug ledger and its reporter chain publishes
the run. Running reporter unit tests through it would wipe `BUG_REPORT.md`, append a point to
the trend history, and push a 0-defect run to the QA Dashboard.

### `test:no-onboarding` — what it skips and why

```
userDetails/sendOTP · userDetails/registration · userDetails/signUp · userDetails/save
userDetails/resetPassword · userDetails/createCommunicationId · demo/createDemoRequest
```

Use it on any environment that must not receive new accounts or dispatch messages. `sendOTP` is
the expensive one: it reaches a real handset, is unauthenticated, unthrottled, and has no
lockout. Note this variant **also bypasses the coverage gate** (npm only runs `pretest` for the
script literally named `test`), so run `npm run audit:vectors` yourself afterwards.

### One spec, or one test

```bash
npx playwright test tests/departments/departments.spec.ts
npx playwright test tests/departments/departments.spec.ts -g "\[IDOR\]"
npx playwright test --project=users -g "sendOTP"
```

### Two gotchas that cost real time

1. **`--reporter=line` (or any `--reporter=` override) disables all configured reporters.** No
   report tier is produced and `BUG_REPORT.md` is left at the "run in progress" stub that
   globalSetup wrote. Use a bare `npm test` when you need the artifacts.
2. **Seeding never runs by accident.** The `seed` project is registered in
   `playwright.config.ts` only when `KPOST_RUN_SEED` is set, which only `npm run seed` does.

---

## 4. Reports — the complete list

### 4.1 `BUG_REPORT.md` — the bug ledger *(root, automatic)*

The human deliverable. One ticket per defect, sorted by severity, each with steps to reproduce,
a `curl`, a Playwright snippet, the owning team, and the user-visible consequence. **Generated —
never edit by hand.**

### 4.2 `BUG_REPORT.json` — machine twin *(root, automatic)*

Same records, same ids, no rendering. This is the exact document the QA Dashboard ingests. Its
`environment` field carries the **short label** (`"Local"`), with the raw URL alongside as
`baseURL` — one shared `environmentName()` produces the label for both this file and the
executive HTML, so a run cannot be grouped two different ways.

### 4.3 `DEV_DIGEST.md` / `.json` — triage summary *(root, automatic)*

Severity / module / owner rollup plus ready-made chat payloads. `npm run notify` prints it.
**Read its authentication line first** — `Authentication | NONE` invalidates the run's
protected-route findings.

### 4.4 `SUITE_SCORECARD.md` — suite health *(root, on-demand)*

`npm run scorecard`. Grades the *test suite*, not the API, out of 100 from measured facts only:
a real `tsc --noEmit`, duplicate route signatures, endpoints under the 10-case floor, coverage
against `api.json`, whether the ownership registry still covers every path, whether every spec
directory is a registered project, and the proportion of defects carrying a curl/snippet/owner.
Where a criterion cannot be measured it deducts rather than assuming credit.

### 4.5 `reports/runs/<run>/kpost-executive-summary.html` — executive report *(automatic)*

Self-contained offline HTML for leads. Mirrored to `reports/latest/`; `npm run report:executive`
prints the path.

### 4.6 `reports/diagnostic/index.html` — Playwright's own report *(automatic)*

`npm run report`. Owns the **trace viewer**, the only way to replay a failed request and
response. Traces are retained on failure with sources. Note this path is flat, not run-scoped.

### 4.7 The QA Dashboard — external *(automatic after each run)*

`reporters/dashboard-ingest.ts` POSTs `BUG_REPORT.json` and logs the dashboard's `runId`. Cross-
run history lives there, not here — this bench holds no database driver and stores no history
beyond the trend file. Application slug: **`kpost-admin`**.

### 4.8 Bugzilla — external *(automatic after each run)*

`reporters/dashboard-bugzilla.ts` files each defect into the **`KPost Admin`** product over
Bugzilla's REST API. See §6 for the whole subject: what it files, what it deliberately does not,
and how to close tickets again.

### Also produced, easy to miss

- `reports/kpost-trend-history.json` — one append-only point per run (tier 3).
- `reports/runs/<run>/kpost-bug-payloads.json` — REST-ready issue payloads (tier 4).
- `reports/junit-results.xml` — for CI consumers.
- `reports/run-validity.json` — this run's verdict, and why. Read it first when a run published
  nothing.
- `reports/runs/` is pruned to `KPOST_RUN_RETENTION` (default 20); `0` keeps everything.

### When a run publishes nothing: the validity gate

A run that did not really happen must never be recorded as a clean one. `reporters/run-validity.ts`
rejects a run when any of these hold:

| Condition | Why it is not a clean result |
| --- | --- |
| errors outside any test | spec files failed to load or globalSetup faulted — nothing was checked |
| the run was interrupted or timed out | its defect list is a partial sample of unknown size |
| zero tests executed | an empty run is not evidence of a healthy API |
| under 50% of *collected* tests produced a result | the run collapsed part-way |
| fewer than `KPOST_MIN_TESTS` executed | optional absolute floor, for CI |

The ratio is against what *this invocation collected*, so `--project=departments` or a `-g`
filter passes: it collects fewer and runs them all.

On rejection you get a `RUN REJECTED — NOT PUBLISHED` banner, a non-zero exit code, local
artifacts still written (they are what you debug with), **`BUG_REPORT.md`/`.json` from the last
valid run preserved rather than overwritten**, and nothing sent to the dashboard or Bugzilla.

---

## 5. Sending reports to developers

| Situation | Send |
| --- | --- |
| "What broke?" — a developer fixing one defect | `BUG_REPORT.md`, or just their ticket from it |
| Daily triage with a team lead | `DEV_DIGEST.md` |
| Status to management | the executive HTML |
| A failure someone disputes | the diagnostic report + its trace |
| Bulk-filing into Plane / Redmine / Jira | `reports/runs/<run>/kpost-bug-payloads.json` |
| Trend over time | the QA Dashboard |

### The automatic channels

All three dispatchers and the dashboard ingest are **fail-safe**: with their env vars unset each
prints one `skipped - X not configured` line and the run is unaffected.

- **Email** — set `SMTP_HOST`, `SMTP_USER`, `SMTP_PASS`, `DEV_EMAIL_RECIPIENTS`.
- **Chat webhook** — set `WEBHOOK_URL`; the payload shape is chosen from the host (Slack /
  Mattermost / Teams).
- **Issue tracker** — set `TRACKER_API_KEY` plus the `PLANE_*` or `REDMINE_*` trio. Dispatch is
  deduped via `reports/dispatched-bugs.json`, so one defect files one ticket, once.
- **QA Dashboard** — set `DASHBOARD_INGEST_URL` and `DASHBOARD_API_KEY`.

### Testing a channel without spamming anyone

Point the webhook at a private channel and run one small project (`npm run test:holidays`)
rather than the full suite. For email, set `DEV_EMAIL_RECIPIENTS` to your own address first.

### Daily routine

```bash
npm test                 # or test:no-onboarding on a protected environment
npm run notify           # read the digest, check the Authentication line
npm run report           # open traces for anything you intend to dispute
```

---

## 6. Bugzilla and the QA Dashboard

Two separate products, each with its own repository, storage and uptime. This bench holds **no
database driver for either** — it makes one HTTP call to each at the end of a run and forgets.

### 6.1 One-time provisioning — **already done**

Neither system knew about this bench until its home was created in each. Both were provisioned
on **2026-08-24** and verified end to end:

| System | This bench's home | State |
| --- | --- | --- |
| Bugzilla 5.2 · `192.168.0.50/bugzilla/rest` | product **`KPost Admin`** (id 4), 25 components, default assignee `jagan@kpost.in` | created |
| QA Dashboard · `localhost:8081` | application **`kpost-admin`** (id 8, kind `api`, prefix `KAD`) | created |

The section is kept because it is what you repeat on a fresh Bugzilla instance, a rebuilt
dashboard, or after adding a Swagger tag — a new tag means a new component, and until it exists
its tickets are filed under the fallback and routed to the wrong team.

While a system is unprovisioned the publishers are correct and useless: the dashboard answers
`401` to every push, and Bugzilla refuses every create with *"There is no component named
'Departments' in the 'KPost Admin' product."* Both are one log line at the end of a nine-minute
run, which is why `check:integrations` exists.

```bash
npm run provision:integrations                      # plan both, write nothing
npm run provision:integrations -- --apply --yes     # create them
npm run check:integrations                          # confirm
```

Provisioning needs credentials beyond the filing key — see the block at the bottom of
`.env.example`. Bugzilla product/component creation requires `editcomponents`
(`BUGZILLA_ADMIN_API_KEY`) and a real Bugzilla login as each component's default assignee
(`BUGZILLA_DEFAULT_ASSIGNEE`); the dashboard's admin API is session-authenticated
(`DASHBOARD_ADMIN_EMAIL` / `DASHBOARD_ADMIN_PASSWORD`). Either half can be done by hand in the
respective UI instead.

**The dashboard shows the application's API key exactly once** and stores only its hash. Paste
it into `.env` as `DASHBOARD_API_KEY` immediately, or create the application again.

The Bugzilla product gets **one component per Swagger tag** — 25 of them, named *exactly* as
`MODULE_BY_PATH` names them. The names are not cosmetic: the filer passes the module string
straight through as `component`, so a mismatch means the ticket is filed under
`BUGZILLA_FALLBACK_COMPONENT` and lands on the wrong team's queue.
`npm run check:integrations` lists every module with no matching component.

### 6.2 What gets filed, and what deliberately does not

One ticket per **defect**, not per failing test. A defect is one root cause, however many tests
and endpoints exhibit it, and the ticket carries the whole blast radius: its affected-endpoint
table, the modules it spans, and up to three distinct observed behaviours. That is why the
grouped ledger is worth more than the hundreds of per-test tickets it replaces.

| Field | Comes from |
| --- | --- |
| `product` | `BUGZILLA_PRODUCT` — fixed per bench |
| `component` | the defect's module (Swagger tag), via `MODULE_BY_PATH` |
| `summary` | `[BUG-API-XXXXXX] <title>` — the tag is the dedup key |
| `severity` / `priority` | the band pair: `critical/major/minor/trivial` × `Highest/High/Normal/Low` |
| `status_whiteboard` | `[cat:Functional|Security|Performance|Compatibility]` |
| `assigned_to` | **not set** — the component's own default assignee owns it |

Dedup is a **live Bugzilla search**, not a local ledger: each run first looks for an open bug
carrying this defect's `[BUG-API-…]` tag and comments on it rather than creating a second. That
is also how you prove dedup works — run the filer twice against the same `BUG_REPORT.json` and
the second pass should create nothing.

**`Assertion Failure` records are never filed.** They are tests that broke, not APIs that broke:
a timeout, a torn-down context, a plain `expect()` whose message could not be classified. They
stay in `BUG_REPORT.md` and the digest where a QA engineer sees them, and are kept out of the
tracker because filing them is how a tracker fills up with noise and stops being triaged.

### 6.3 Filing for real

`BUGZILLA_DRY_RUN` ships as **`true`**, and that default is deliberate: Bugzilla's REST API has
no delete, only resolve, so every ticket filed is permanent. Stage the first real pass:

```bash
# 1. see the mapping with no calls made at all
npm run bugzilla:file

# 2. file a handful, then look at them in Bugzilla
BUGZILLA_DRY_RUN=false BUGZILLA_MAX_FILE=10 npm run bugzilla:file

# 3. re-run the SAME command — it must comment, not create duplicates
BUGZILLA_DRY_RUN=false BUGZILLA_MAX_FILE=10 npm run bugzilla:file

# 4. lift the cap
BUGZILLA_DRY_RUN=false npm run bugzilla:file
```

The cap slices the defect list rather than counting creates, so step 3 revisits exactly the same
defects — which is what makes it a real dedup check.

### 6.4 Closing tickets again

Nothing in a run ever *closes* a ticket: a passing test says nothing to Bugzilla. Left alone, the
product's bug count only rises, even while the API measurably improves.

```bash
npm run bugzilla:close-fixed                      # dry run, full plan
npm run bugzilla:close-fixed -- --apply --yes --limit 20
```

It closes a ticket only when the defect did not recur **and its endpoint was actually exercised
by a non-skipped test** in the run used as evidence. That distinction is the whole point: a
skipped test and a passing test both produce silence, and closing on silence credits fixes
nobody made. Infrastructure-shaped disappearances are reported separately and resolved
`INVALID`, not `FIXED`, and only with `--include-artifacts`.

If a ticket was closed too early and the fault re-filed as a new one, `npm run
bugzilla:repair-refiled` reopens the original and folds the newer ticket into it as a duplicate.

### 6.5 Re-publishing by hand

Both publishers have a standalone entry point, for when a run's publish was interrupted:

```bash
npm run dashboard:push    # idempotent — the dashboard upserts on the defect fingerprint
npm run bugzilla:file     # deduped against Bugzilla itself
```

Both consult the same validity gate, so a stale zero-test report cannot be pushed by hand
either.

---

## 7. Troubleshooting

### 1. The environment is not reachable

```bash
curl -s -o /dev/null -w "%{http_code}\n" http://localhost:9595/
```

Expect `200` and an HTML liveness banner. `curl http://localhost:9595/v3/api-docs` should serve
the live OpenAPI document; it is expected to match the checked-in `api.json`.

### 2. The whole run reports almost no defects

Read the `Authentication` line in `DEV_DIGEST.md`. `NONE` means no session could be established
and every protected-route assertion was skipped or unevaluated. Fix `ADMIN_JWT_SECRET`, or run
`npm run seed`. This failure mode is dangerous precisely because it looks like good news.

### 3. `npm test` refuses to start, printing a coverage bar

That is the `pretest` vector gate doing its job. Either close the listed gaps, or lower
`KPOST_VECTOR_THRESHOLD` deliberately and record why. Do not delete the check. To run the suite
once without it: `npm run test:skip-audit`.

### 4. Dashboard ingest or Bugzilla filing did not happen

Run `npm run check:integrations` — it separates the causes in about five seconds and names the
exact one, without creating a run or filing a ticket.

| Line | Means |
| --- | --- |
| `SKIP … is unset` | Not configured. A decision, not a fault. |
| `FAIL … 401` / `invalid API key` | The key does not match. Reissue it from the Dashboard's Applications page for slug `kpost-admin`, or from Bugzilla's Preferences → API Keys. |
| `FAIL … 404` / `does not point at the ingest route` | `DASHBOARD_INGEST_URL` must end in `/api/ingest`; `BUGZILLA_URL` must end in `/rest`. |
| `FAIL … fetch failed` | The host is down or unreachable from here. |
| `FAIL no product named "KPost Admin"` | Not provisioned yet — see §6.1. |
| `WARN … modules have no component` | Provisioned but incomplete: those tickets will be filed under the fallback component and routed to the wrong team. |

Either way the run itself is unaffected: both publishers are fail-safe and can never change the
exit code, and the reports on disk are complete. If the run was *rejected* rather than failing
to publish, that is the validity gate — read `reports/run-validity.json` and §4.

### 5. Report files are missing or say "run in progress"

You passed a `--reporter=` override, which disables the configured reporter chain. Re-run with a
bare `npm test`.

### 6. `npm run <script>` exits 1 printing nothing

**Symptom:** any npm script exits 1 with only the npm banner — even `typecheck`, whose
`tsc --noEmit` passes when run directly. Reproduced in this repo from Git Bash.

**Cause:** npm resolves its script shell from `ComSpec`, which Git Bash does not set. npm throws
`ERR_INVALID_ARG_TYPE` *before your script runs*, and the error goes only to
`%LOCALAPPDATA%\npm-cache\_logs\*-debug-0.log`.

**Fix:** run npm from PowerShell or CMD. From Git Bash:

```bash
ComSpec="C:\Windows\System32\cmd.exe" npm test
```

Also never pipe npm to `tail` without `set -o pipefail` — the pipe returns *tail's* exit status
and hides the failure.

### 7. `.env` changes seem to have no effect

`authSession` is worker-scoped and resolved once per worker. Kill any stale Playwright workers
and re-run. `npm run clean` clears the caches that survive between runs.


### 8. The suite reports "No tests found", or executes zero tests

The run-validity gate catches this and refuses to publish, so the symptom is a
`RUN REJECTED — NOT PUBLISHED` banner naming *N error(s) occurred outside any test*.

The cause is almost always an **ESM-only package reaching a spec**. Playwright transpiles specs
to CommonJS, so importing one becomes a `require()` of an ES module and throws at *collection*
time — before any test runs, and in every spec that transitively imports it. `npm run typecheck`
stays green throughout, because tsconfig's `module: preserve` is not what Playwright uses for
its runtime transform.

This is why there is no `@faker-js/faker` dependency: faker 10 is ESM-only, nine payload builders
imported it, and the whole suite collected zero tests. Test data comes from
`src/utils/dataGen.ts`, which exports an object named `faker` with the same call signatures — add
a method there rather than reinstalling the package.

To confirm which import is at fault, run one project and read the first error: it names the file
and the line.
---

## Reference

| Doc | For |
| --- | --- |
| [README.md](README.md) | The short front door |
| [CLAUDE.md](CLAUDE.md) | Architecture, conventions, severity grading, known API behaviours |
| `api.json` | The API contract. Stays at the root — two scripts locate the repo root by it |
| `reports/run-validity.json` | Why a run did or did not publish. Read this first when a run went quiet |
| `BUGZILLA-UI/API_CONTRACT.md` | The front end that reads what this bench files. Its `classification.ts` parses the `[cat:Xxx]` whiteboard tag — change one, change both |
| `QA-Dashboard/API_MAP.md` | The ingest contract `BUG_REPORT.json` is POSTed against |
