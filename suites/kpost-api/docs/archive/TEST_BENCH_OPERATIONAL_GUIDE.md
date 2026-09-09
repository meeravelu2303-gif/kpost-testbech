# KPOST API Test Bench — Operational Guide

Single source of truth for running this suite, reading what it produces, and getting those
outputs to the people who act on them.

**Audience:** engineering leads, QA engineers, backend developers.
**Scope:** the 310 active V2 operations. Deprecated V1 routes are out of scope — see
[V1_DECOMMISSION_RISK.md](V1_DECOMMISSION_RISK.md) for why, and for what is still open on them.

Every command below was executed against this repository before being written down, and where a
conventional command does **not** work here that is called out rather than left for you to
discover.

> **One verification caveat, stated up front.** In the sandbox used to write this guide, the
> `npm run <script>` indirection itself exits 1 and swallows stdout for *every* script —
> including `typecheck`, which passes when invoked directly. The npm scripts are therefore
> idiomatic and correct, but only their **direct equivalents are verified here**. Both forms are
> given throughout. If `npm run` misbehaves on your machine too, see
> [npm run exits 1](#npm-run-exits-1-with-no-output).

---

## Quick reference

| I want to… | npm script | Direct equivalent (verified) |
| --- | --- | --- |
| Run everything | `npm test` | `npx playwright test` |
| Run one module | `npm run test:common` | `npx playwright test --project=common` |
| Open the debug report | `npm run report` | `npx playwright show-report reports/diagnostic` |
| Read the triage summary | `npm run notify` | `node scripts/print-digest.js` |
| Locate the executive HTML | `npm run report:executive` | `node scripts/print-executive-path.js` |
| Reset caches | `npm run clean` | `node scripts/clean.js` |
| Type-check | `npm run typecheck` | `npx tsc --noEmit` |

---

## 1. End-to-end automation flow

```
   ┌──────────────────────────────────────────────────────────────────────────┐
   │  TRIGGER                                                                 │
   │  npm test  ·  npx playwright test  ·  CI job  ·  nightly schedule        │
   └───────────────────────────────┬──────────────────────────────────────────┘
                                   │
                                   ▼
   ┌──────────────────────────────────────────────────────────────────────────┐
   │  GLOBAL SETUP        src/config/global-setup.ts                          │
   │  Wipes .bug-cache/ and stubs BUG_REPORT.md so a run never inherits       │
   │  findings from the run before it.                                        │
   └───────────────────────────────┬──────────────────────────────────────────┘
                                   │
                                   ▼
   ┌──────────────────────────────────────────────────────────────────────────┐
   │  RUNNER + FIXTURES   src/fixtures/api.fixture.ts · authSession.ts        │
   │  One Playwright project per controller tag. authSession is WORKER-scoped │
   │  — a session costs several round trips, so it is acquired once per       │
   │  worker, not once per test.                                              │
   │                                                                          │
   │  Auth order: QA_AUTH_TOKEN → QA_KPOST_ID/QA_PASSWORD login → throwaway   │
   │  signup. Never silently skips; if all three fail, tests throw            │
   │  AuthenticationUnavailableError carrying the full attempt log.           │
   └───────────────────────────────┬──────────────────────────────────────────┘
                                   │
                                   ▼
   ┌──────────────────────────────────────────────────────────────────────────┐
   │  ROUTE EXECUTION — 1 canonical spec per METHOD+PATH                      │
   │  src/api/clients/*.client.ts  ·  src/api/payloads/*.payload.ts           │
   │                                                                          │
   │  Every request funnels through capture() in base.client.ts, which does   │
   │  three things and never alters the response:                             │
   │    · records the exact request for the ledger's repro block              │
   │    · feeds status + latency to reporters/telemetry.ts                    │
   │    · attaches the full exchange to the test (Playwright HTML report)     │
   └───────────────────────────────┬──────────────────────────────────────────┘
                                   │
                                   ▼
   ┌──────────────────────────────────────────────────────────────────────────┐
   │  ASSERTIONS          src/utils/apiAssertions.ts · schemaValidator.ts     │
   │  Zod contract + status + auth + injection + header checks.               │
   │  Bare expect(response.status()) is forbidden — it bypasses the ledger.   │
   └───────────────────────────────┬──────────────────────────────────────────┘
                                   │
                    ┌──────────────┴──────────────┐
                 PASS                          FAIL
                    │                             │
                    │                             ▼
                    │   ┌──────────────────────────────────────────────────┐
                    │   │  DEFECT LEDGER   src/utils/bugTracker.ts         │
                    │   │  Writes one file per finding into .bug-cache/    │
                    │   │  with the exclusive 'wx' flag — an atomic create │
                    │   │  is what makes cross-worker dedup reliable.      │
                    │   │  ID = content hash of method+path+title, so one  │
                    │   │  backend fault tripped by 200 tests files ONCE.  │
                    │   └──────────────────────┬───────────────────────────┘
                    │                          │
                    └──────────────┬───────────┘
                                   ▼
   ┌──────────────────────────────────────────────────────────────────────────┐
   │  EXPORTERS (write during the run)                                        │
   │   · Playwright HTML + traces  → reports/diagnostic/                      │
   │   · JUnit XML                 → test-results/results.xml                 │
   └───────────────────────────────┬──────────────────────────────────────────┘
                                   │
                                   ▼
   ┌──────────────────────────────────────────────────────────────────────────┐
   │  AGGREGATORS (onEnd, IN THIS ORDER — the order is load-bearing)          │
   │                                                                          │
   │   1. reporters/kpost-master-reporter.ts                                  │
   │        builds the run model → executive HTML, trend point, bug payloads  │
   │   2. src/reporters/bugReporter.ts                                        │
   │        compiles BUG_REPORT.md + .json, then DEV_DIGEST via devNotifier   │
   │                                                                          │
   │   ⚠ bugReporter DELETES .bug-cache/ when done. It must run LAST, or the  │
   │     master reporter finds an empty ledger.                               │
   └───────────────────────────────┬──────────────────────────────────────────┘
                                   │
                                   ▼
   ┌──────────────────────────────────────────────────────────────────────────┐
   │  DISPATCH LAYER (fail-safe; skips cleanly when unconfigured)             │
   │   · reporters/send-email-report.ts       SMTP digest + attachment        │
   │   · reporters/send-webhook-alert.ts      Slack / Teams / Mattermost      │
   │   · reporters/dispatch-bugs-to-tracker.ts  Plane / Redmine tickets       │
   └───────────────────────────────┬──────────────────────────────────────────┘
                                   │
                                   ▼
   ┌──────────────────────────────────────────────────────────────────────────┐
   │  SCORECARD (manual, post-run)                                            │
   │   npm run test:list && npm run scorecard  →  SUITE_SCORECARD.md          │
   └──────────────────────────────────────────────────────────────────────────┘
```

---

## 2. Runbook

### Step 1 — Prerequisites

| Requirement | Verified version | Check |
| --- | --- | --- |
| Node.js | v20.19.4 | `node -v` |
| npm | 10.8.2 | `npm -v` |
| Backend reachable | `http://localhost:8989` | `curl -s -o /dev/null -w '%{http_code}' http://localhost:8989/` |

Install and configure:

```bash
npm ci
```

```bash
cp .env.example .env
```

**Environment variables that matter most.** Full list with comments is in `.env.example`.

| Variable | Purpose | If unset |
| --- | --- | --- |
| `BASE_URL` | Target API | Defaults to `http://localhost:8989` |
| `QA_AUTH_TOKEN` | Preferred auth — a real token for a seeded account | Falls back to login, then throwaway signup |
| `QA_KPOST_ID` / `QA_PASSWORD` | Second auth route | Falls back to throwaway signup |
| `TEST_MOBILE` / `TEST_EMAIL` | **Single safe destination for every OTP test** | Defaults are safe placeholders |
| `KPOST_RUN_RETENTION` | Run folders kept under `reports/runs/` | 20 |

> **Do not point `TEST_MOBILE` at a real number.** OTP endpoints are exercised dozens of times
> per run. Payload builders are pinned to this value on purpose so an aggressive run can never
> fan out SMS to arbitrary subscribers.

Confirm the build is clean before running anything:

```bash
npm run typecheck
```

### Step 2 — Full suite

```bash
npm test
```

Expect roughly **4,090 tests in ~26 minutes** against a local backend. On completion you get
every artifact in section 3.

> **Never pass `--reporter=line` when you want artifacts.** It *replaces* the configured
> reporter list, so no tier is produced and `BUG_REPORT.md` is left at the "run in progress"
> stub that globalSetup wrote.

### Step 3 — Targeted execution

**By module.** Each controller tag is its own Playwright project:

```bash
npx playwright test --project=common
```

Available projects: `auth` `profile` `common` `integrations` `dashboardV2` `knews`
`generalSettings` `groupsV2` `companyAdministration` `contactsDirectoryV2` `kwordDocuments`
`kpresentation` `kdiary` `kallV2` `redbus` `katchupV2` (plus `seed`, which is opt-in).

Shorthands exist for the common ones — `npm run test:common`, `npm run test:kall`, etc.

**By folder:**

```bash
npx playwright test tests/common/
```

**By spec file.** Note the real filename — there is no `login.spec.ts`; auth lives in
`signupLogin.spec.ts`:

```bash
npx playwright test tests/auth/signupLogin.spec.ts
```

**By endpoint or scenario.** `--grep` matches the full test title, and every describe block is
named `METHOD /path`, so the route itself is the selector:

```bash
npx playwright test --grep "POST /v2/common/sendOTP"
```

```bash
npx playwright test --grep "IDOR"
```

> **`--grep @critical` will not work here — there are no `@tags` in this suite.** Severity is
> assigned by the assertion helpers *after* a test fails, not declared on the test up front, so
> it cannot be a selector. To work severity-first, run the suite and filter the ledger:
>
> ```bash
> node -e "JSON.parse(require('fs').readFileSync('BUG_REPORT.json','utf8')).defects.filter(d=>d.severity==='Critical').forEach(d=>console.log(d.displayId,d.method,d.endpointPath,'—',d.title))"
> ```

**Debug mode:**

```bash
npx playwright test tests/auth/signupLogin.spec.ts --debug
```

> **There is no headed mode here.** This is an API-only suite — no browser is ever launched.
> `--debug` gives you the Playwright Inspector with step-through and the request/response
> viewer, which is the useful part. `--headed` is a no-op.

Useful during development:

```bash
npx playwright test tests/kdiary/ --workers=1 --retries=0
```

### Step 4 — Cleanup

```bash
npm run clean
```

Removes `test-results/`, `.bug-cache/` and `.scorecard-build/`, plus any leftover
`allure-results/` / `allure-report/` from before Allure was removed.

> `.bug-cache/` is normally already gone — `bugReporter` deletes it at the end of every
> successful run. It only survives a crash or a killed run, and a stale one is worth clearing
> because leftover findings would be folded into the next report.
>
> `reports/` is **not** touched by `clean`. Run folders are pruned by `KPOST_RUN_RETENTION`, and
> the trend history is append-only by design.

---

## 3. Reporting ecosystem

| Report | Path / command | Format | Audience | Purpose |
| --- | --- | --- | --- | --- |
| **Suite Scorecard** | `SUITE_SCORECARD.md` | Markdown | CTO, VP Eng, QA Director | Suite grade, coverage, duplicate audit, release verdict |
| **Developer Digest** | `DEV_DIGEST.md` / `.json` | Markdown / JSON | Eng leads, module owners | Pass/fail ratios, severity + module + owner breakdown |
| **Master Bug Ledger** | `BUG_REPORT.md` / `.json` | Markdown / JSON | Backend devs, security SDETs | One ticket per defect: curl repro, expected vs actual, impact |
| **Executive Summary** | `reports/latest/kpost-executive-summary.html` | Static HTML | Eng leads, management | Defect-led narrative with severity and ownership |
| **Playwright HTML** | `reports/diagnostic/index.html` → `npm run report` | Static HTML | QA engineers | Step inspection and the **trace viewer** |
| **CI results** | `test-results/results.xml` | JUnit XML | Jenkins, GH Actions, GitLab | Automated pass/fail gating |
| **Trend history** | `reports/kpost-trend-history.json` | JSON | Quality dashboards | One append-only point per run, kept forever |
| **Bug payload stream** | `reports/latest/kpost-bug-payloads.json` | JSON | Tracker importers | Machine-readable defect stream |

### Corrections to common assumptions

Three paths differ from the Playwright defaults, and using the default will fail:

| Commonly assumed | Actual here | Why |
| --- | --- | --- |
| `playwright-report/index.html` | `reports/diagnostic/index.html` | Every artifact lives under `reports/`; the run-isolation layer hard-links this folder into each timestamped run |
| `src/utils/bugLogger.ts` | `src/utils/bugTracker.ts` | The ledger writer. Assertions that feed it are in `src/utils/apiAssertions.ts`. **There is no `bugLogger.ts`.** |
| `npx allure serve` shows the run | Allure is not installed | It was removed permanently. Per-run debugging is `npm run report` (trace viewer); trends live in the external QA Dashboard |

---

## 4. Viewing and exporting reports

### Playwright HTML (trace viewer)

```bash
npm run report
```

This is the only report that can **replay a failed request and response**. Open a failed test →
Trace → step through the network call.

### Executive summary

```bash
npm run report:executive
```

Prints the absolute path; open it in any browser.

### Digest and ledger

```bash
npm run notify
```

Prints `DEV_DIGEST.md` to stdout — the fastest way to see a run's shape.

**Export to PDF.** No converter is bundled; use whichever is available:

```bash
npx md-to-pdf BUG_REPORT.md
```

```bash
pandoc BUG_REPORT.md -o BUG_REPORT.pdf
```

> `BUG_REPORT.md` is ~2 MB and can exceed 800 defects. For sharing, prefer `DEV_DIGEST.md`
> (~5 KB) or filter the JSON to one module first:
>
> ```bash
> node -e "const d=JSON.parse(require('fs').readFileSync('BUG_REPORT.json','utf8')).defects.filter(x=>x.module.includes('Katchup'));require('fs').writeFileSync('katchup-defects.json',JSON.stringify(d,null,2));console.log(d.length+' defects')"
> ```

### Scorecard

The scorecard needs a resolved test list, then compiles its generator (the repo has no
TypeScript runner):

```bash
npm run test:list && npm run scorecard
```

> ⚠ **`--list` runs globalSetup**, which stubs `BUG_REPORT.md`. Never run `test:list` after a
> run whose report you still need — back the ledger up first, or regenerate the scorecard
> immediately after a full run instead.

---

## 5. Dispatch and notification

### What is automatic

All three dispatchers run **automatically at the end of every run**, from the master reporter's
`onEnd`. They are fail-safe by construction: they return a result object, never throw, and print
one line when unconfigured. A missing SMTP host or an unreachable tracker cannot fail a test run.

```
[KPOST Reporter] Email dispatch skipped - SMTP_HOST not configured
[KPOST Reporter] Webhook dispatch skipped - WEBHOOK_URL not configured
[KPOST Reporter] Bug dispatch skipped - neither PLANE_API_URL nor REDMINE_API_URL configured
```

Seeing those lines means the wiring is healthy and the credentials are absent — not that
dispatch is broken.

**Nothing reaches a developer until you set the environment variables.** Out of the box this
suite writes files and sends nothing.

| Channel | Enable with | Behaviour |
| --- | --- | --- |
| Email | `SMTP_HOST`, `SMTP_PORT`, `SMTP_USER`, `SMTP_PASS`, `DEV_EMAIL_RECIPIENTS` | Digest in the body, report attached. Speaks SMTP directly — no mail library. |
| Chat | `WEBHOOK_URL` | Payload shape auto-detected from the host: Teams gets a MessageCard, Slack/Mattermost get `{text}`. |
| Tracker | `TRACKER_API_KEY` + either `PLANE_*` or `REDMINE_*` | **One ticket per defect, once.** Filed defects are recorded in `reports/dispatched-bugs.json` keyed by content hash. |

> The tracker ledger is what makes a nightly schedule safe. Without it, every night re-files
> every finding until the tracker is unusable.

### Manual dispatch

The dispatchers are TypeScript modules invoked by the reporter; there is no CLI entry point, and
the repo has no TS runner. To fire one by hand, compile it the same way the scorecard does:

```bash
npx tsc reporters/send-webhook-alert.ts --ignoreConfig --module commonjs --target es2022 --esModuleInterop --skipLibCheck --outDir .dispatch-build
```

```bash
node -e "require('./.dispatch-build/send-webhook-alert.js').sendWebhookAlert().then(r=>console.log(r))"
```

Each dispatcher resolves the newest run itself through `reports/latest/run.json`, falling back
to scanning `reports/runs/`, so a hand-run dispatcher still works after someone deletes
`latest/`.

**Simplest alternative** — post the digest with plain curl, no compilation:

```bash
curl -X POST -H 'Content-Type: application/json' -d "{\"text\": $(node -e "process.stdout.write(JSON.stringify(require('fs').readFileSync('DEV_DIGEST.md','utf-8').slice(0,3000)))")}" "$WEBHOOK_URL"
```

### CI integration

**GitHub Actions** — Slack alert on failure:

```yaml
name: API Test Bench
on: [pull_request, schedule]

jobs:
  api-tests:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-node@v4
        with:
          node-version: '20'
          cache: npm
      - run: npm ci
      - run: npm run typecheck
      - run: npm test
        env:
          BASE_URL: ${{ secrets.KPOST_BASE_URL }}
          QA_AUTH_TOKEN: ${{ secrets.KPOST_QA_TOKEN }}
          WEBHOOK_URL: ${{ secrets.SLACK_WEBHOOK }}
          SMTP_HOST: ${{ secrets.SMTP_HOST }}
          SMTP_USER: ${{ secrets.SMTP_USER }}
          SMTP_PASS: ${{ secrets.SMTP_PASS }}
          DEV_EMAIL_RECIPIENTS: ${{ vars.DEV_EMAIL_RECIPIENTS }}
      - if: always()
        uses: actions/upload-artifact@v4
        with:
          name: kpost-reports
          path: |
            BUG_REPORT.md
            DEV_DIGEST.md
            SUITE_SCORECARD.md
            reports/
            test-results/results.xml
```

Because `WEBHOOK_URL` is in the job environment, the built-in dispatcher fires from `onEnd` — no
separate notification step is needed.

**GitLab CI:**

```yaml
api-tests:
  image: mcr.microsoft.com/playwright:v1.62.1-jammy
  script:
    - npm ci
    - npm run typecheck
    - npm test
  artifacts:
    when: always
    paths: [BUG_REPORT.md, DEV_DIGEST.md, SUITE_SCORECARD.md, reports/]
    reports:
      junit: test-results/results.xml
```

> **The suite exits non-zero whenever defects are found**, which is almost always against this
> backend. If you want the pipeline to continue and report rather than block, add
> `continue-on-error: true` (GitHub) or `allow_failure: true` (GitLab) — and gate the merge on
> the Critical count from `BUG_REPORT.json` instead:
>
> ```bash
> node -e "const c=JSON.parse(require('fs').readFileSync('BUG_REPORT.json','utf8')).defects.filter(d=>d.severity==='Critical').length;console.log('Critical:',c);process.exit(c>0?1:0)"
> ```

---

## 6. Troubleshooting

### `npm run` exits 1 with no output

**Symptom:** any `npm run <script>` returns exit 1 and prints only the npm banner — including
`npm run typecheck`, whose underlying `tsc --noEmit` passes when run directly.

**Cause:** the npm script indirection, not the scripts. It shows up under some Git Bash / Windows
npm combinations, where npm fails to relay the child process's stdout and exit code.

**Fix:** use the direct equivalent from the [quick reference](#quick-reference). Every npm script
in this repo is a thin wrapper around one command or one file in `scripts/`, so there is always a
direct form:

```bash
node scripts/print-digest.js
```

Helper scripts are **real files rather than `node -e` one-liners** for a related reason: npm on
Windows strips the nested double quotes from an inline `node -e "..."`, so the script exits 0
having executed nothing. That failure mode is worse than an error, because it looks like success.

### Stale Node processes hold `test-results/`

**Symptom:** `rm: cannot remove 'test-results': Directory not empty`, or a new run behaving
oddly.

**Cause:** a previous run is still alive. Two concurrent runs race on `.bug-cache/` and produce a
corrupted, partial report.

```powershell
Get-Process node -ErrorAction SilentlyContinue | Stop-Process -Force
```

```bash
npm run clean
```

Confirm nothing is running before starting a new suite. Never chain cleanup and execution with
`&&` — if the cleanup fails on a lock, the `&&` silently skips the test run and you get an empty
result set that looks like a passing no-op.

### The report is empty or says "run in progress"

Three causes, in order of likelihood:

1. `--reporter=line` was passed, replacing the configured reporters.
2. `playwright test --list` was run after the suite — it triggers globalSetup and stubs the file.
3. The run was killed before `onEnd`.

All three are recovered by re-running the suite.

### Flaky tests

Retries are environment-aware in `playwright.config.ts`:

```ts
retries: env.isCI ? 1 : 0,
workers: env.isCI ? 2 : env.workers,
```

Local runs use **zero retries deliberately** — this is a bug-hunting suite against a live
stateful backend, and a retry that passes on the second attempt hides a real intermittent
defect. If you need to confirm flakiness:

```bash
npx playwright test tests/kdiary/ --repeat-each=3 --workers=1
```

Genuine flakiness here is usually one of: shared state from a previous run's writes, worker
concurrency on a singleton controller (`resultMap` is an instance field on several KPOST
controllers), or OTP rate limiting.

### Backend DTO changed

When a request shape changes on the server, update in this order:

1. **`src/api/payloads/<tag>.payload.ts`** — the request builder. Field names must match the DTO
   exactly. A wrong name is silently accepted by `Record<string, unknown>` overrides and produces
   tests that assert nothing.
2. **`src/api/schemas/<tag>.schema.ts`** — the Zod response contract.
3. **`src/api/clients/<tag>.client.ts`** — only if the path or verb changed.
4. `npm run typecheck`, then re-run that project.

> **The field-name trap is real and has bitten this suite.** `buildPinCodePayload` takes
> `postalCode`; tests written against a guessed `pinCode` key still passed type-checking, still
> ran, and silently asserted nothing for an entire release cycle. When adding a fuzz case,
> verify the key against `swagger.json`:
>
> ```bash
> node -e "const s=require('./swagger.json');console.log(Object.keys(s.components.schemas.PostalCodeRO.properties))"
> ```

### Authentication fails

The chain is `QA_AUTH_TOKEN` → `QA_KPOST_ID`/`QA_PASSWORD` → throwaway signup. Every failed step
is recorded and the whole log prints once per worker. Set `VERBOSE_AUTH_DIAGNOSTICS=true` to see
it.

Tests call `requireAuthToken()` rather than `test.skip(...)` **on purpose** — unverified coverage
should be visible as a failure, not hidden as a skip.

### Adding a new endpoint

Four files, one project entry, and the deduplication rule:

1. `src/api/clients/<tag>.client.ts` — path constant + method
2. `src/api/payloads/<tag>.payload.ts` — faker-backed builder
3. `src/api/schemas/<tag>.schema.ts` — Zod contract
4. `tests/<tag>/<feature>.spec.ts` — one `test.describe('METHOD /path')` with **10+** cases

Then verify you have not created a duplicate:

```bash
npm run test:list && npm run scorecard
```

`SUITE_SCORECARD.md` reports duplicate signatures and anything under the 10-case floor.

---

## Appendix — file map

| Path | Role |
| --- | --- |
| `playwright.config.ts` | Projects, reporters, retries, trace policy |
| `src/config/env.config.ts` | Typed environment accessor |
| `src/config/global-setup.ts` | Resets the defect ledger per run |
| `src/fixtures/api.fixture.ts` | Client fixtures + tokens |
| `src/fixtures/authSession.ts` | Worker-scoped session acquisition |
| `src/api/clients/base.client.ts` | Transport, request capture, telemetry, attachments |
| `src/utils/apiAssertions.ts` | The bug-hunting assertions |
| `src/utils/bugTracker.ts` | Defect ledger + report writer (**not** `bugLogger.ts`) |
| `src/utils/devNotifier.ts` | Digest generator (generates; does not send) |
| `reporters/kpost-master-reporter.ts` | Tiers 2–4 driver |
| `reporters/generate-scorecard.ts` | Scorecard generator |
| `src/reporters/bugReporter.ts` | Compiles the ledger; **must run last** |
| `CLAUDE.md` | Architecture and conventions — read before contributing |
| `V1_DECOMMISSION_RISK.md` | Open risks on removed V1 routes |
