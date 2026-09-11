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

**Current phase: 5 and 6 in parallel**, with a recorded backlog — see [Known gaps](#known-gaps--the-backlog). Both engines work end to end; the remaining work is
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
5. **Read [Known gaps](#known-gaps--the-backlog) before planning work.** It records what is
   deliberately unfinished and why, so nobody re-discovers it or assumes a number is clean.

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
- **The Excel `Types(Katchup,Kall&KDiary)` tab is authoritative for every type code** — Katchup
  `messageType`/`status`/`sharedType`, Kall `kallStatus`/`kallType`/`kallMode`/`repeatType`, KMail
  `kmailType`/receiver type/priority/`module`, Kdiary `remarks`, business user tiers. The bench's
  copy is `src/api/enums/kpostTypes.ts`; never hand-type a code's meaning in a comment. After a
  workbook update run `npm run contract:types -- "<path to .xlsx>"`; `npm run test:unit` fails if
  the module and the tab disagree. (The bench once labelled messageType 18 "Confidential" — it is
  Secret — and filed an invalid Critical on it.)
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

## Six traps this bench has actually fallen into

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
5. **Judging a disclosure or removal from the ACTOR's response instead of the AFFECTED party's
   fetch.** This is the standing vantage-point rule, and it has produced a wrong test twice.

   > **The verdict on a disclosure, removal, ownership or delivery requirement is taken from the
   > affected party's own read — never from the response the actor receives.**

   The actor's response is the actor's view, and the actor is often entitled to see what the
   rule is protecting from someone else. NFR-SEC02 first asserted on the *sender's* send
   response, where a sender may legitimately see the Confidential Copy list they chose — it
   reported a leak that was not one. FR-K10 first asserted that a recalled message left the
   *sender's* conversation, where the backend correctly keeps the row marked recalled
   (`messageType 7`, `status 5`) — it reported a defect against correct behaviour.

   *Guard:* before writing the assertion, name the party the requirement protects and read as
   them. That usually means a second login on a throwaway device id — worth it. It applies to
   every rule of this shape still to be written: **forward, transfer, delete, recall, block,
   unshare, revoke.** If reading as the affected party is impossible on the environment, the
   test skips with that reason; it does not fall back to the actor's view.
6. **Running several mutations against ONE seeded fixture.** The companion to the vantage-point
   rule, and it produced a wrong result the same week.

   > **One action per seeded fixture. A mutation sequence sharing a fixture makes every result
   > after the first unreadable.**

   Five sender actions — edit, note, reminder, recall, delete — were run against a single
   message. All five answered 200 and the read was "none of them check ownership". Re-run with
   a fresh message per action, recall and delete answered **400**: they check ownership
   correctly. Their 200 in the first run was real, but it came *after* the edit had rewritten
   the message's `sender` to the caller, so by then the caller genuinely owned it. The shared
   fixture turned a two-stage escalation into a flat, wrong conclusion — and it was the more
   serious finding that the flat reading destroyed.

   *Guard:* seed inside the loop, never outside it. If a test genuinely needs a chain, assert
   each step against the state that step alone produced, and say in the test which earlier step
   each result depends on. Applies to every mutation family still to be written: block/unblock,
   archive/restore, add/remove member, grant/revoke.

---

---

## Known gaps — the backlog

**Status: recorded 2026-09-11, deliberately not yet fixed.** The team is running the suite and
filing the current findings in Bugzilla first; this list is what we come back to afterwards. Every
number here came from a real run, not an estimate. Re-measure with `npm run trace`,
`npm run audit:gate` and `npm run collect` before trusting any of it — these move.

**Admin module (`suites/kpost-api/admin/`) is OUT OF SCOPE.** Do not run it, fix it or report on
it. Everything below is `kpost-api`, `kmail` and `kpost-ui` only.

### Where the numbers stand

```
automatable requirements : 68
traced to a tagged test  : 51  (75.0%)
untraced                 : 12
blocked (never ran)      : 5
tolerant assertion       : 13 requirement(s)
High-priority, 1-2 tests : 28 of 41  (target 3+)
collect: api 4795 · kmail 936 · ui 332 tests
```

75.0% is the honest number after removing six wrongly-tagged requirements and separating out the
blocked ones. FR-K05 was briefly blocked on a bench error — copies are delivered via
`forwardReceiverList`, which the bench had not been sending — and is traced again. It went **down** from 88.2% as the measurement got stricter. That is the intended
direction.

### 1. Tolerant assertions — 13 requirements (Step 6)

The tag is right; the assertion cannot fail for it. `handledCleanly()` passes on a 400, and a
status set containing both a 2xx and a 4xx means success and refusal both pass — so "a recipient
can Reply" was satisfied by the server *rejecting* the reply. **These need the assertion replaced,
not more tests added.** `npm run trace` prints the list with a reason per entry.

`FR-C03 · FR-K03 · FR-K14 · FR-K15 · FR-K16 · FR-K18 · FR-K22 · FR-K23 · FR-K24 ·
FR-M01 · FR-M02 · FR-M03 · FR-M06`

The fix is the same move every time: stop asserting the response was well-formed, assert the
effect is observable on a subsequent read — and give each one its own seeded fixture (trap #6).
Seven were done this way already (FR-K21, FR-C01, FR-C02, FR-C05, FR-K04, BR-C01 and NFR-SEC02);
each took roughly one read-back call and each found something.

### 2. Blocked — 5 requirements, all external

Written or tagged but never able to execute here. **Do not write assertions for these until the
dependency lands**; a test nobody has seen pass is not evidence.

| id | blocked on |
| --- | --- |
| `FR-M01`, `FR-M02`, `FR-M04`, `BR-M01` | The QA accounts have no mail-server credentials — `getMailCredentials` returns all-null, `postMail` 500s, the mailbox read answers "No Data Found". A provisioning gap for the developers, not a payload bug. |
| `FR-K03` | No multipart shape we could construct attaches a file. `sendKatchupMsgMultiPart` returns `attachmentUuid: null` even with the documented `attachmentCaption`/`fileName` pairing; `uploadMultipartFiles` answers 400 "could not be read as a multipart upload" for every part name tried. **Open question for the developers: what does the `files` part expect?** Until that is answered we cannot tell an API defect from a bench mistake. |

The FR-K03 access-control question is unanswered for the same reason: **can a non-participant
download an `attachmentUuid` they were never sent?** No uuid could be obtained to try it.

### 3. Untraced — 12 requirements

`BR-K02 · BR-X01 · FR-C07 · FR-C08 · FR-C09 · FR-K09 · FR-K17 · FR-K25 · FR-S05 · FR-S11 ·
FR-S12 · NFR-U01`

Six of these lost their tags deliberately, because the test they were on proved something else:

- **`FR-C08` / `FR-C09`** (call log with participant names, roles, duration; exact start/end
  timestamps) sat on a Zod-contract check whose schema declares none of those fields. **This is
  a spec problem, not a bench gap** — Kall's contract may not carry what the FRD claims, which
  needs a product decision before a test can be written.
- **`FR-S11`** (maintain an authenticated session) and **`FR-S12`** (log out, terminating the
  session) sat on `assertStatus([200, 400, 401, 403])` — sets that accept 401, so they passed
  when the session was *not* maintained and when the logout was refused.
- **`BR-X01`** (read receipts consistent across Katchup and KMail) is untraced because it needs
  the end-to-end journey layer that does not exist yet, and is also gated on the mail credentials.

### 4. Type coverage — Kall and Kdiary are thin

Katchup and KMail are well covered. The other two send one default value and almost nothing else,
so the server's type branches are untested.

| module | field | exercised | missing |
| --- | --- | --- | --- |
| Katchup | `messageType` | 0, 1, 2, 3, 5, 6, 7, 8, 9, 14 (Cc and Confidential Copy), 15, 16, 18 (Secret), 20 | **4, 10, 11, 17, 19, 21, 22, 23, 24, 25, 26** — per the product enum (see the `businessRules.spec.ts` header) |
| KMail | `fetchMailType` | all three (Y / N / A) | — |
| KMail | `kmailStatusFlag` | all three | — |
| Kall | `kallType` (0 normal, 1 kool/scheduled) | `0` for a direct call (`buildKallROPayload`; it sent 1 until 2026-09-11), `1` for repeat series, `9999` fuzz | — |
| Kall | `kallMode` (0 Audio … 5 Primary Video) | `0` Audio | **1–5** never sent |
| Kall | `kallStatus` (0 new … 11 Not Joined) | 2 cancelled (default), 4 declined, 7 ReScheduled | **0, 1, 3, 5, 6, 8, 9, 10, 11** never sent |
| Kdiary | `userType` | `PERSONAL` | **`BUSINESS_S`, `BUSINESS`** are in the contract |
| Kdiary | `repeatType` | `9999` fuzz only | contract shows `1` |
| Kdiary | `remarks` (0 None … 6 Delete) | `1` Completed | **0, 2–6** never sent |

**Worth doing alongside the tolerant work, not after it.** It is the same failure shape — coverage
that looks present because the endpoint is called, but only ever down one branch. Kall business
rules have already produced four confirmed findings and `addMembersToKall` 500s on a duplicate
member, so varying these should be expected to surface more.

### 5. Application flow — the weakest layer

Roughly 25 genuine multi-step chains now exist (seed → act → read back as the affected party), and
they are what found every recent defect. What is still missing is an **end-to-end journey layer**:
nothing walks signup → login → send → recipient reads → receipt propagates → forward → recall.
Cross-module coverage is `tests/crossModule/platformRules.spec.ts` (4 rules) plus one UI navigation
journey. `BR-X01` is the requirement this blocks.

### 6. Architecture phases still open

- **Phase 5 — engine migration.** 9 of 329 mandatory endpoints are declared on the centralized
  engine; the rest are hand-written specs. The mission property — *add an endpoint, get the full
  battery free* — does not hold until this is done. This is the largest single gap against the
  stated goal.
- **Phase 6 — UI screens.** 2 screens declared against a whole application.

### 7. Bench defects, not product defects

- **KMail treats a 429 login as fatal.** Running `test:api` immediately before `test:kmail` leaves
  the auth service throttled and KMail cannot start — that produced a run where **479 of 496
  failures were one bench fault**. Workaround: run KMail first, or leave a gap. `authSession`
  needs the same backoff the API bench's BR-S01 test already uses.
- **A suite that fails to authenticate writes `"defects": []`.** A total execution failure is
  currently indistinguishable from a clean run in the report. That is how a dead 929-test run came
  to report zero defects.

### 8. Open questions for the product/dev team, not bugs

- **`getKpostIdUsingModule` payload width.** The route is public by design (confirmed), but the
  anonymous response carries names and gender alongside handles. Whether the payload should be
  that wide is a product decision; deliberately not filed.
- **`BUG-API-A349C7` — payment gateway callback requires a bearer token.** Whether the gateway is
  meant to call it tokenless is a design question the response cannot settle. Still the only
  Critical in the report that has not been decided.
- **Should Katchup message ids be guessable?** They are one global sequential counter. The
  ownership check is the fix for the current P0, but non-sequential ids would remove the
  enumeration surface entirely. See `docs/handover/katchup-message-ownership.md`.

- **Confidential Copy leaks in PRODUCTION, not on QA.** Per the product enum, Confidential Copy is
  `messageType 14` with the party in `sharedMessageDetails.hiddenContactList`. QA strips that list
  from the primary's copy (verified from the primary, a Cc recipient and each hidden recipient; the gate test is green). A production capture shows it populated
  on the recipient's own row. Likely a build difference — raise with the production capture as
  evidence.
- **`BUG-API-6EEBB3` was INVALID and should be closed.** It was built on `messageType 18`, which is a
  Secret message, not Confidential Copy; `selectedMembers` there makes nobody a recipient. The bench
  had mislabelled 18 as "Secret / Conf." in its own comments. Retraction recorded in
  `docs/context/critical-verification-2026-09-10.md`.
- **Recall answers `status: 5`**, which the status enum (0 Sent · 1 Unread · 2 Read · 3 Not sent ·
  4 Group) does not list. Ask what 5 means before any receipt assertion depends on it.

- **`sharedType 14` is not in the Types tab's SHARE TYPE list**, yet the live web client sends it on
  every Copies / Confidential Copy message. The bench follows the client
  (`KATCHUP_OBSERVED.copiesSharedType`); the workbook should list it.

- **The `module` list stops at 17 in the workbook on disk** (`KPOST API (5).xlsx`); the sheet
  shared on 2026-09-11 shows 18–20. Re-run `npm run contract:types` against the newer copy.

### 9. Findings awaiting a developer fix

The gate suite is deliberately red for these — each will go green when the fix lands. See
`docs/handover/` for the developer-facing write-ups.

| finding | where |
| --- | --- |
| `sendMessage` honours an undocumented `msgID` and overwrites any message, any type, no ownership check — then recall/delete follow because `sender` was rewritten | `gate/security/messageOwnership.spec.ts` |
| Stored XSS — Kdiary `createEvent`, Katchup `sendMessage` | `gate/security/storedContent.spec.ts` |
| Hibernate internals leaked on `createSchedule` | `gate/security/internalsLeak.spec.ts` |
| Wallet notification to a caller-supplied mobile | `gate/security/tokenIdentity.spec.ts` |
| A Note/Reply on a Confidential Copy leaks the hidden list via its `referenceMessage` snapshot | `gate/security/confidentialCopy.spec.ts` |
| A reply is not linked to the message it replies to | `tests/katchupV2/businessRules.spec.ts` |
| `addMembersToKall` 500s on a duplicate member | `tests/kallV2/kallEffects.spec.ts` |


## Reporting & defect tracking

Every suite produces `BUG_REPORT.md`/`.json` and `DEV_DIGEST.md`/`.json` (gitignored, per run),
files one ticket per fault into its own Bugzilla product, and pushes to the shared QA Dashboard.
Secrets live in each suite's gitignored `.env` — **never commit them.**

Three mechanisms keep the report honest:

- **Content-hashed ids** collapse the same symptom on the same endpoint.
- **`dedupeKey`** collapses one fault surfacing as many symptoms — an unvalidated controller files
  one ticket per *endpoint*, not per fuzzed field.
- **A validity gate** refuses findings whose own evidence contradicts them, announced as
  `[bug-gate] SUPPRESSED`. Four rules, each added after a bad ticket got through:
  exposure claimed on a 401/403; enumeration claimed on a 404; **a run that could not establish a
  session** (the assertion never ran, so there is no verdict — a bench fault, not a defect); and
  **a concurrency or idempotency claim evidenced by a 401/403** (two identical refusals are
  correct gating under load, not shared state). Covered by `npm run test:unit`.

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
