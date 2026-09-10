# API bench readiness — 2026-09-10

What changed in the session that took the API bench to a state the team can run and trust, and
**why**. Read alongside [`working-constraints.md`](working-constraints.md).

## Verified state at the end of the session

| Gate                                  | Result                                    |
| ------------------------------------- | ----------------------------------------- |
| `npm run typecheck` (4 suites)        | clean                                     |
| `npm run audit:vectors`               | 2029/2029 mandatory — **100.00%**         |
| `npm run audit:excel`                 | **100.00%**, 0 documented fields absent   |
| `node scripts/traceability.js`        | 56/64 — **87.5%** (API layer 56/57)       |
| `npm run collect`                     | 7,506 tests across 4 suites               |

Target host `192.168.0.66` (`:8989` KPost, `:9081` KMail, `:9595` Admin).

## Safety change — read this first

**`BUGZILLA_DRY_RUN` is now `true`** in `.env` and `admin/.env` (it was `false`; `kmail/.env` was
already `true`). The defect ledger derives ticket ids by content-hashing `classification :: title`,
so the payload realignment below changes ids across the board — the first live run after it would
have filed a fresh set of tickets duplicating what is already in Bugzilla. Flip it back
deliberately, once, when the team is ready to accept the re-filing.

Related action for a human: existing Bugzilla tickets against `/generalSetting/changeTheme` should
be resolved INVALID — their content-hash ids no longer correspond to anything the suite emits.

## Excel conformance is now a gate, not an exercise

`npm run audit:excel` (`suites/kpost-api/scripts/excel-conformance.js`) holds every mandatory
endpoint to the workbook: each documented field must actually be sent to *that* endpoint, by its
own describe block or by a builder it calls transitively. The workbook lives in the repo as
[`docs/excel/endpoints.json`](../../suites/kpost-api/docs/excel/README.md) so the gate runs without
the .xlsx and a contract change arrives as a readable diff. Threshold is **100** — a new Excel row
should fail CI on arrival.

Getting to 100% meant fixing the checker as much as the payloads. Five checker faults each
produced *phantom* findings — fields the suite demonstrably sent, reported as absent:

- describes titled `Auth - POST /path` were missed (the verb was anchored to the start of the
  title), and theme-titled describes (`Mail signature writes`, `Letterhead`) were unattributable
  until route constants were resolved — that alone was **34 endpoints reported as untested that
  were fully tested**;
- a flat builder map let KMail's `buildUnsubscriberPayload` overwrite KPost's (**9 names collide**
  across the benches), so the wrong builder was judged;
- ES6 shorthand (`{ uniqueName, ... }`) and non-exported local helpers
  (`personalDataFields()`) were invisible to the field scan;
- `type` sat in the noise list while being a real field on `/dairySchedule/createEvent`.

The lesson worth keeping: **a conformance number is only as good as the matcher behind it.** The
first "91.6%" was mostly matcher artefacts in both directions.

### Payloads actually corrected

`fetchUserDetails` `countryID` (without it the endpoint answers 400 "countryID does not match the
account on record", so every case on the route was exercising a rejected request) ·
`adminRegistration` `registerNo` · enterprise `adminUserLogin` geo/push trio · `metaDee/aiMessage`
`content`/`requestType` · kdiary `updateEvent` `repeat`/`weekly` · KMail `knownPostBoxContacts`
`lastFetchTime` (the builder sent `{}`) · KMail `clearStatusOfKmailsContacts` `selectedContact` ·
new `buildImportantMailsPayload` and `buildReplyNotRequiredPayload` (kept out of the shared
`buildCommonPayload` — KMail entities are not `@JsonIgnoreProperties(ignoreUnknown = true)`, so an
extra field on the shared shape is a hard Jackson 400 wherever it does not belong) ·
`updateGroupProfileImage` now sends the documented `{"groupKpostID": …}` JSON text part rather than
a bare id string.

**Adding `selectedContact` to the clear-status payload immediately exposed a real defect**: with a
complete body the endpoint reaches its own logic and accepts `kmailStatusFlag: 99` with HTTP 200.
The incomplete payload had been hiding missing validation behind an early rejection. Expect more of
this — a payload fix can turn a passing test red, and that is the fix working.

### Reasoned exemptions (in the gate, with reasons)

`createUserGroup` / `addUserToGroup` `createdBy` — the server derives the actor from the token, and
sending one would defeat the spoofing cases. `userLogout` `deviceIdentity_Primary` / `logouttime` —
casing only; the suite sends the spellings every QA session demonstrably authenticates with, a live
probe could not separate them, and Java binding is case-sensitive.

## Cross-module requirements

New `tests/crossModule/platformRules.spec.ts` (and a `crossModule` project) covers the three
requirements that belong to no controller: **NFR-SEC01** (every authenticated operation demands a
valid JWT), **BR-X02** (password policy applies at *every* account-creation path), **NFR-R02** (an
accepted message must be retrievable — an accept that stores nothing is silent data loss).

Two traps were found and closed while writing it, both worth remembering:

- **A "must not be 2xx" assertion passes trivially on a route that does not exist.** The first
  draft used five wrong paths; 20 of its 24 cases were green against 404s. Each route now has a
  **reachability guard** that fails if a valid token does not get a 200. Method matters as much as
  path — these are GET routes, and a POST answers 405, which also passes vacuously.
- **BR-X02 would have passed on any 4xx**, including a rejection for an unrelated field. It now
  requires the refusal to mention the password.

**BR-X01** (read receipts consistent across Katchup and KMail) is deliberately *not* written: it
needs a delivered mail, and `postMail` 500s on every QA account for want of mail-server
credentials. A skipping test would have claimed coverage the bench does not have.

## Live findings worth reporting to developers

Confirmed against `192.168.0.66` with a valid token, and reduced to faults rather than failing
tests:

1. **Confidential Copy leaks to the primary recipient** — Critical, breaks NFR-SEC02. A
   messageType-18 message names the confidential party in `selectedMembers`, and the *recipient's*
   own `katchupMessagesForSelectedContactID` fetch returns it. Verified from the recipient's
   session, not from the sender's send response (a sender may legitimately see their own list —
   asserting on that would have reported a leak that is not one).
2. **`getLoginHistory` and `getActiveSession` answer 409 to everyone**, token or not — 12 failing
   tests, one fault.
3. **`userLogoutFromAllDevices` answers 500** even with a valid token — 6 tests, one fault. A user
   cannot revoke their own sessions.
4. **`fetchUserDetails` / `fetchPersonalUserDetails` answer 500 for an unknown kpostID** (200 for a
   real one) — an unhandled lookup miss.
5. **`/v2/contacts/globalSearch` has no rate limiting** — a directory-wide read, so the cheapest
   membership-enumeration primitive available.

## One bench fault fixed (a false-finding generator)

`auth.schema.ts` asserted `status: z.enum(['Success','Failure'])`. The platform answers
`SUCCESS`/`FAILURE` everywhere — a real deviation, but one the bench asserts **once** by design, in
the dedicated envelope-contract test (`strictDocumentedEnvelopeSchema`), with every other schema
using `z.string()`. The login schema was re-filing a known fault as a second ticket.

---

# Second pass — closing the blind spots the gates could not see

The gates above all read source code. A green gate therefore says "the test is written", never
"the test ran and meant something". This pass hunted the difference.

## The governing failure mode: a test that passes while proving nothing

Three distinct instances were found and fixed. They share a shape worth naming, because it will
recur:

| where | how it passed while proving nothing |
| ----- | ----------------------------------- |
| `NFR-SEC01` sweep | five of six paths were wrong; "must not be 2xx" is green against a 404. **20 of 24 cases** |
| the four newly-covered endpoints | all four answer 404 — 55 new tests went green against nothing |
| `BR-X02` | asserted only "some 4xx", which a rejection for an unrelated field satisfies |

It happened a **fourth and fifth** time, in the guard written to prevent it — and the fourth fix
was itself wrong, which is the part worth reading.

`[deployment]` was first written as `expect(status).not.toBe(404)`. In a full run three of the
four passed while their routes were still missing. My first diagnosis was throttling (429); that
was a guess, it was wrong, and the "fix" built on it changed nothing — the next full run still
showed 3 passes.

The real cause: **this API runs its authentication filter BEFORE routing.** A rejected token
answers **401 for a route that cannot possibly exist** — verified directly:

```
POST /v2/profile/thisRouteCannotPossiblyExist   bad token -> 401
POST /v2/profile/updateSchoolDetails            bad token -> 401
```

I had listed 401 and 403 in `REACHABLE_STATUSES`, so a 401 "proved" the route existed. During a
full run the shared QA account session is periodically evicted by another worker (KPost allows
one session per account/device), those requests come back 401, and the case went green. Both
statuses are now excluded from the reachable set and skip instead, with the reason stated.

Two lessons, and the second is the one that cost the time:

1. **A negative assertion is not repaired by another negative assertion.** State what must be
   true, not what must not.
2. **Diagnose before fixing.** The 429 theory was plausible, cheap to implement, and wrong; one
   direct probe against a route that cannot exist would have settled it in seconds. A fix built
   on an unverified cause is indistinguishable from no fix — except that it looks like progress.

**Side observation worth its own ticket:** full runs produce occasional spurious 401s on the
shared account because workers evict each other’s sessions. Most assertion helpers list 401
among their acceptable statuses, so this is invisible today — but it means a full-run 401 is not
always the API’s verdict on the request.

The countermeasure is now a convention: **every negative assertion needs a positive control.**
`crossModule` has a per-route reachability guard that fails when a valid token does not get a 200;
the undeployed endpoints have `skipIfUndeployed` plus a `[deployment]` case that reports the 404
as the finding. A skip states the truth. A pass launders a missing endpoint into evidence of a
working one.

## Coverage gaps closed

**Four mandatory Excel endpoints had no test at all** — `/v2/kall/endKall` (row 88) and the nested
education family `updateSchoolDetails` / `updateCollegeDetails` / `updateUniversityDetails` (rows
107-109). The nested family is not an alias of `saveOrUpdate*Details`: that takes a flat
`UserProfileRO` keyed by `requestType`, this takes an array of full records with the row id,
`course`/`standard`/`field`, `about` and `attachmentPath`. All four are now covered with the seven
mandatory vectors — and all four answer **404 to a valid token**, which is itself the finding.

Endpoint reference coverage is 290/301 mandatory; the remaining 11 are matcher artefacts
(query strings, literal path params) verified covered by hand.

## The disposable-account fix — the biggest real win

`freshUser()` called `signup` **without the OTP flow**, so registration could never succeed:
`disposableToken` was permanently null and roughly fourteen destructive-path tests skipped every
run — account deactivation, credential change, session revocation. The surface where a defect is
most expensive was the least exercised.

The seeder's premise ("the OTP is random and reaches only SMS") is **out of date**: mock OTP
`123456` validates over plain REST on this host. `freshUser()` now runs sendOTP → validateOTP →
signup, with a 429 retry because dispatch is throttled at ~1 per 6s. Verified: the destructive
slice went from 14 skips to **30 passed, 0 skipped**.

## Gate corrections

- **CI never ran the Excel gate.** Added to `ci.yml`. Without it the contract could drift while
  every other gate stayed green.
- **`lint:ui` was failing, so CI was red.** `ts-api-utils` hoisted to the root resolved the root's
  TypeScript 7, while the UI's `@typescript-eslint` needs TS 5.x (`TypeFlags.Intrinsic` is gone in
  7). Fixed by pinning `ts-api-utils@2.4.0` in `kpost-ui` — a version deliberately different from
  the root's, because npm only nests a dependency when the hoisted copy does not satisfy the
  range. All ten CI gates now pass.
- **Table-driven specs are invisible to both gates.** They read `test.describe('<literal>')` and
  the builder calls inside it, so a loop hides the endpoint behind a template literal and the
  payload behind `route.build()`. The first draft of `educationNested.spec.ts` was a loop; the
  Excel gate then reported all ten documented fields as never sent — a false finding against code
  that does send them. Unrolled into three literal describes. **Write specs one literal describe
  per endpoint**; the duplication is what makes coverage measurable.

## Skip audit

167 skips across the full run, every one carrying a stated reason. The 17 without one are a single
`test.describe.skip` on `/kword/documentsType1`, a developer-only endpoint — documented, and
correctly excluded from the vector gate's denominator (its regex requires `test.describe(`, which
`.skip` does not match). The rest are data-dependent ("lookup returned no data", "send did not
succeed") and shrink as the environment gains data.

## Are the failures real?

228 failures in the baseline run group into product-fault classes, not bench faults: 95 unhandled
500s, 25 envelope/status-parity, 19 the `getActiveSession`/`getLoginHistory` 409, 15 missing rate
limiting, 11 XSS reflections, 8 accepts-bad-input. The 404 group is the API answering 404 where a
400 belongs — also a finding, not the bench calling dead routes.
