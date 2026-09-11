# CLAUDE.md — KPost Test Bench (monorepo)

Guidance for Claude Code (and any engineer) working anywhere in this repository. **Read this file
first.** Then read the `CLAUDE.md` of the suite you are touching. For the story behind any decision
(accounts, hosts, known backend issues, past work), read [`docs/context/`](docs/context/).

---

## The mission

Build and keep a **production-grade test bench** for the KPost platform where:

1. **Every common validation is centralized.** Authentication, authorization, request validation,
   status, structure, schema, content-type, headers, error contract, performance, security and
   database checks live in **one** place each.
2. **Adding an API endpoint or a UI screen requires no validation code.** You write a
   *declaration*; the engine runs every applicable check against it. If adding coverage means
   copying assertions, the architecture has failed and the fix belongs in the engine.
3. **Every test type is covered** — smoke, regression, contract, functional, negative, auth,
   authorization, security, database, integration, response-time, change detection.
4. **The report can be trusted.** One defect per fault, graded honestly, no duplicates, and no
   finding whose own evidence contradicts it.

The measure is not the number of tests. It is: *can a new engineer add an endpoint in five minutes
and get the full battery, and can a developer act on the report without re-verifying it?*

---

## Architecture

```
Developer API ─► Excel workbook ─► contract parser ─► endpoint registry
                                                            │
                                                            ▼
                                                   apiEngine.run(definition)
                                                            │
  authentication → authorization → request → execution → status → structure → schema
  → contentType → headers → errorContract → performance → security → database → businessRules
                                                            │
                                                            ▼
                       defect ledger (content-hashed) ─► report ─► CI quality gate
```

**Two directories carry the whole idea:**

| | |
| --- | --- |
| `src/engine/validators/` | every check, once. Add a validator here and **every** endpoint gets it. |
| `src/endpoints/` | declarations only. Add an endpoint here and it gets **every** validator. |

Neither requires touching the other. That is the property the mission depends on — see
[`src/engine/README.md`](suites/kpost-api/src/engine/README.md).

### Adding an endpoint

```ts
{
  id: 'katchup.sendMessage',
  method: 'POST',
  path: '/v2/katchup/sendMessage',
  auth: 'secured',
  expectedStatuses: [200, 400],
  buildRequest: () => buildKatchupMessagePayload({ receiver: FOREIGN.victimKpostID }),
  responseSchema: katchupMessageResponseSchema,
  requiredFields: ['subject', 'receiver'],
  performance: 'write',
  authorization: { USER: 'ALLOW', UNAUTHENTICATED: 'DENY' },
  skip: { businessRules: 'covered by tests/katchupV2/businessRules.spec.ts' },
}
```

That is the entire task. No assertions are written.

### What the engine does NOT own

- **Business rules.** "A Confidential Copy recipient must stay hidden from other recipients" is not
  derivable from a contract. These stay in module specs under `tests/`, tagged with their FR/BR id.
  The `businessRules` stage reports an explicit skip naming the spec, so the report never implies
  coverage that does not exist.
- **Load testing.** `performance` is a single-request latency guard. Throughput belongs in
  k6/JMeter against a dedicated environment.

---

## The roadmap

Each phase is verifiable. A phase is not "done" because code exists — it is done when its gate
passes and the number is honest.

| Phase | Goal | Done when |
| ----- | ---- | --------- |
| **1 — Foundation** ✅ | Monorepo, 4 suites, reporting, defect ledger | all four typecheck; configs load |
| **2 — Trustworthy reporting** ✅ | No duplicate or invalid tickets | `audit:bugs`: duplicates collapse per endpoint; validity gate unit-tested |
| **3 — Correct contract** ✅ | Excel parsed completely and correctly | `contract:parse` → 353 rows / 329 mandatory, multi-endpoint rows split |
| **4 — Centralized engine** ◐ | All common validation in one pipeline | 13 validators registered; endpoints declared, not coded |
| **5 — Migration** ☐ | Every mandatory endpoint declared | registry coverage → 100% of the 333 |
| **6 — UI parity** ◐ | Same declare-don't-code model for screens | screen engine live: 8 validators, screens declared in `src/screens/` |
| **7 — Quality gates** ◐ | CI blocks regressions | 10/10 CI gates green; Excel 100%, vectors 100%, traceability 87.5% |

**Current phase: 5 and 6 in parallel.** Both engines work end to end; the remaining work is
declaring endpoints and screens onto them.

The UI half mirrors the API half exactly:

| | |
| --- | --- |
| `suites/kpost-ui/src/engine/validators/` | navigation · rendering · console · network · a11y · performance · responsive · session |
| `suites/kpost-ui/src/screens/` | declarations only |

A screen declaration buys a WCAG scan, console-error and failed-request capture, a load budget, a
phone-width re-render with a horizontal-overflow check, and — for an `authenticated` screen — the
unguarded-route check that a signed-out visitor cannot still render it. `requiredElements` is
mandatory in the type: a "screen loads" test that asserts nothing about content passes against a
blank page, which is the UI equivalent of a 404 satisfying "must not be 2xx".

---

## How to work here

1. **Read the suite's own `CLAUDE.md`** before editing that suite — it carries the load-bearing
   conventions (assertion helpers, payload rules, reporting engine, known API behaviours).
2. **Read [`docs/context/`](docs/context/)** for operational state a fresh session cannot infer.
   Start with [`working-constraints.md`](docs/context/working-constraints.md).
3. **Verify before you trust.** Hosts change and developers reset the database. A note naming a
   host, account or endpoint may be stale; check it lives.
4. **If you find yourself copying an assertion, stop.** It belongs in a validator.

---

## Install & run

```bash
npm install                 # then, for the UI bench's browsers: npx playwright install
```

| Command (from root)        | Runs                                                            |
| -------------------------- | --------------------------------------------------------------- |
| `npm run test:api`         | KPost API suite                                                  |
| `npm run test:kmail`       | KMail sister suite                                               |
| `npm run test:admin`       | KPost Admin sister suite ⚠ live HR data — read its CLAUDE.md     |
| `npm run test:ui`          | KPost UI suite (cross-browser)                                   |
| `npm run typecheck`        | type-check every suite                                           |
| `npm run audit:excel`      | payloads match the Excel contract (threshold 100)                |
| `npm run audit:vectors`    | every endpoint carries the mandatory security vectors            |
| `npm run audit:bugs`       | duplicate clustering + validity triage of `BUG_REPORT.json`      |
| `npm run contract:parse`   | re-parse the Excel workbook → `docs/excel/endpoints.json`        |
| `npm run trace`            | requirement traceability                                         |

The suites pin **different major versions** of shared dev-deps (API: TypeScript 7 + faker 10 ESM;
UI: TS 5.7 + faker 9). Deliberate — do **not** force-align them.

---

## The test pyramid — the one rule that governs coverage

The bulk of coverage lives at the **API layer** (fast, stable, cheap). The **UI layer is
deliberately thin** — only what a browser can prove that an API cannot: rendering, navigation,
forms, client-side session behaviour, accessibility, cross-browser crashes. Thousands of API cases
under ~80 UI cases is the correct ratio. **Never re-test API business logic through the UI.**

---

## Non-negotiable working constraints

From [`docs/context/working-constraints.md`](docs/context/working-constraints.md) — these OVERRIDE
default behaviour:

- **Do NOT commit or push.** The user commits manually. Make the changes only.
- **The Excel workbook is authoritative for request payloads, not swagger.** When they disagree,
  match the Excel. Re-parse with `npm run contract:parse -- "<path to .xlsx>"`; the parser carries
  an explicit per-tab column map because the three tabs do not share a shape.
- **Never test with real OTP.** Builders are pinned to `TEST_MOBILE`/`TEST_EMAIL`. **Mock OTP
  `123456` (+ `000000` fallback) is an intentional dev bypass — accept it, never file it, never
  fail on it.** Only a genuinely un-issued *non-mock* OTP being accepted is a finding.
- **Never aim destructive calls at the shared session** — use synthetic/disposable identities.
- **One defect per fault, not per failing test.** Critical means auth bypass, injection or data
  exposure. A report where everything is Critical is a report nobody reads.
- **A test that cannot fail is worse than no test.** Every negative assertion needs a positive
  control; see the four traps below.
- **Record what you change** in `docs/context/`. Keep comments concise: trim prose, keep safety
  facts, Excel/API-behaviour facts, and non-obvious "why".

---

## Four traps this bench has actually fallen into

Each cost real time and each is now guarded. Read these before writing an assertion.

1. **A negative assertion passes against a route that does not exist.** "Must not be 2xx" is green
   on a 404. Twenty of twenty-four cases once passed this way. *Guard:* a reachability check that
   fails when a valid token does not get a 200 — and the method matters as much as the path.
2. **This API authenticates BEFORE routing.** A 401 comes back for paths that do not exist, so a
   401 never proves a route is real. *Guard:* 401/403 are excluded from reachability sets.
3. **Comparing two responses without stripping server clocks.** `lastFetchDate` differing by 16 ms
   produced four Critical IDOR tickets against correct code. *Guard:* `comparableBody` strips
   volatile fields.
4. **A wrong contract invalidates every gate built on it.** A parser that silently dropped 35
   endpoints let the Excel gate report 100% while measuring an incomplete workbook. *Guard:*
   `contract:parse` reports row gaps per tab; a gap means the parser is wrong, not the workbook.

---

## Reporting & defect tracking

Every suite produces `BUG_REPORT.md`/`.json` and `DEV_DIGEST.md`/`.json` (gitignored, per run),
files one ticket per fault into its own Bugzilla product, and pushes to the shared QA Dashboard.
Secrets live in each suite's gitignored `.env` — **never commit them.**

Three mechanisms keep the report honest:

- **Content-hashed ids** collapse the same symptom on the same endpoint.
- **`dedupeKey`** collapses one fault surfacing as many symptoms — an unvalidated controller files
  one ticket per *endpoint*, not per fuzzed field.
- **A validity gate** refuses findings whose own evidence contradicts them (exposure claimed on a
  401; enumeration claimed on a 404), announced as `[bug-gate] SUPPRESSED`.

`BUGZILLA_DRY_RUN=true` is currently set in all three API envs **deliberately** — see
[`docs/context/`](docs/context/). Flip it only when the team accepts the re-filing.

---

## Current environment

_Verify — this moves._ Host `192.168.0.66` (`:8989` KPost, `:9081` KMail, `:9595` Admin).
DB `kpostaurora` (**MySQL/MariaDB**, not PostgreSQL).

QA accounts: `meera960/961/962@kpostindia.com` (personal) and
`meera@m960s|m960m|m960l.kpost.in` (business S/M/L). All six authenticate.

Known backend gaps to report, not to work around: `postMail` 500s (no mail-server credentials on
the QA accounts), `getKmailDashboardMsg` returns "No Data Found", `/v2/kall/endKall` 404s, and the
Criticals listed in [`docs/context/critical-verification-2026-09-10.md`](docs/context/critical-verification-2026-09-10.md).
