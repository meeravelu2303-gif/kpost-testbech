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
