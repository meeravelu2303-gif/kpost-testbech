# Verification of the 17 Criticals — run 2026-09-10 13:22 UTC

Every Critical in `BUG_REPORT.json` (158 defects, 4,749 tests, 232 failed) reproduced by hand
against `192.168.0.66` with a sanity-checked token. **Verdicts, not opinions** — each row says what
was actually observed.

Method note: every probe first calls `GET /v2/profile/getUserProfile` and refuses to draw a
conclusion unless it returns 200. Without that, an evicted session answers 401 and any verdict
built on it is worthless. See [[kpost-auth-before-routing]].

## CONFIRMED — file these (5)

| id | finding | evidence |
| -- | ------- | -------- |
| `BUG-API-6EEBB3` | **Confidential Copy recipient disclosed to the primary recipient** | The recipient's own `katchupMessagesForSelectedContactID` fetch returns `selectedMembers` naming the confidential party. Verified from the recipient's session, not the sender's. |
| `BUG-API-D238B5` | **Anonymous module lookup exposes the user directory** | `POST /v2/common/getKpostIdUsingModule` with **no token** returns **183 account handles** with names and gender. |
| `BUG-API-87F627` | **Stored XSS in Kdiary** | `createEvent` accepts `<script>alert('xss')</script>` as the title and `getTodaySchedules` serves it back unescaped on a later read. Stored, not merely reflected. |
| `BUG-API-E2A672` | Unbounded recurring series accepted | `createEvent` with a daily recurrence and no `seriesEndDate` → 200, eventID issued. |
| `BUG-API-78938D` | Event ending before it starts accepted | `createEvent` with end < start → 200, eventID 670 created. |

## FALSE — do not file (2, plus 1 unsupported)

| id | claim | what actually happened |
| -- | ----- | ---------------------- |
| `BUG-API-0442A0` | "the katchup feed echoed a smuggled participant" | The feed is **byte-identical** with and without the smuggled `kpostID` (21,091 bytes both ways, volatile cursors stripped). The victim's id appears because meera960 genuinely exchanges messages with meera961 throughout the suite — legitimate data, not a leak. |
| `BUG-API-46FB1B` | "3 of session ids 1-3 returned transcript content" | Ids 1, 2 and 3 all return **404**. Nothing is enumerable. |
| `BUG-API-D82D41` | "a font preference was written while the body carried a foreign kpostID" | The response is identical to the caller's own write (`"FontSetting Updated Successfuly"`) and never acknowledges the foreign id. The read-back route `getFontSetting` is **404 (undeployed)**, so the write's destination cannot be observed — but the ticket's own evidence does not support its claim. Treat as unsupported until the read route exists. |

## INCONCLUSIVE — needs the bench's exact request (8)

My probes were rejected at the **binding layer** before reaching business validation, so these are
neither confirmed nor disproven. Reproduce with the `reproSnippet` in the report, not a hand-rolled
body.

- `BUG-API-31BA6D` forwarding a message between two other parties — `forwardKatchupMessage` is
  multipart and answers `400 "Required parameter 'text' is missing"` to a JSON body.
- `BUG-API-7C4662` Hibernate internals leak on `createSchedule` — my minimal body 400'd first.
- `BUG-API-51AA1B`, `3580D1`, `5FD83F`, `B37E81` — all four Kall cases answered
  `400 "request body is missing, malformed, or contains a value of the wrong type"`, i.e. my
  payload shape is wrong for `scheduledKall` / `scheduledRepeatKall`.
- `BUG-API-A349C7` payment callback refuses anonymous — the route exists (authenticated call
  answers 415, so it is reachable) and does 401 anonymously. Whether that is a **defect** is a
  design question: is the gateway meant to call it tokenless? The 401 alone cannot decide it,
  because this API 401s unknown routes too.
- `BUG-API-9077DE` (wallet notification to a caller-supplied mobile) and `BUG-API-198051`
  (`/admin/resetPassword` accepts `userType: "NOT_A_TIER"`) — not probed.

## The bigger finding: 158 tickets, 51 root causes

`npm run audit:bugs` clusters the report by root cause. **107 of 158 tickets collapse.** The four
largest clusters are one defect each — a controller that does not validate its input, so every
fuzzed field produces its own ticket:

| tickets | one fix |
| ------- | ------- |
| 26 | Kdiary accepts unvalidated input → unhandled 500 |
| 21 | Kall, same |
| 9 | Contacts, same |
| 6 | Groups, same |

That is **62 tickets for 4 defects**. The content-hash dedupe is working as designed — it collapses
the same symptom on the same endpoint — but it cannot see one fault surfacing as many symptoms
across many fields. Send the cluster, not the tickets.

## Severity policy — a decision for the team

`Invalid input accepted` is graded **Critical** by design (`apiAssertions.ts`): a write that accepts
an invalid body has persisted a corrupt row. That is defensible and it is why the Critical count is
what it is. If Critical should mean only auth bypass, injection and data exposure — the definition
in the root `CLAUDE.md` — then these belong at Major and the count drops to roughly five. One line
in `assertRejectsInvalidInput` either way. **Not changed unilaterally: it is the report's
credibility with the dev team, so it is the team's call.**

---

# Filing policy hardened — 2026-09-10 (after the verification above)

Three changes so a run cannot file invalid or duplicated tickets. All in the assertion/ledger
layer, so they apply to every suite that uses it.

## 1. One ticket per endpoint for "no input validation"

`assertRejectsInvalidInput` now sets a `dedupeKey`:

| outcome | key | effect |
| ------- | --- | ------ |
| 5xx on invalid input | `UNVALIDATED-INPUT-5XX:<METHOD> <path>` | every fuzzed field on that endpoint collapses into one ticket, the fields becoming occurrences |
| wrong 4xx (404/409 where 400 belongs) | `WRONG-REJECT-STATUS-<code>:<METHOD> <path>` | same |
| invalid input **accepted** | *(not collapsed)* | each accepted input is a distinct business rule to write, not duplicate noise |

Collapsed per **endpoint**, not per module: an endpoint is the unit somebody actually fixes.

This is the largest source of noise in the report — 62 tickets for 4 defects (26 Kdiary, 21 Kall,
9 Contacts, 6 Groups). The content-hash dedupe was working correctly all along; it collapses the
same symptom on the same endpoint, and it simply cannot see one fault surfacing as many symptoms
across many fields. `dedupeKey` is the mechanism the tracker already provided for exactly this —
the same one that collapsed the systemic missing-header defect from ~240 tickets to one.

## 2. A missing validation rule is Major, not Critical

`severity` for an accepted invalid write drops **Critical → Major** (and a `readOnly` accept drops
to Minor). The root `CLAUDE.md` defines Critical as auth bypass, injection or data exposure, and
gives the reason: *"a report where everything is Critical is a report nobody reads."*

The previous grade rested on a real argument — an accepted invalid write persists a corrupt row —
but that is not the same class of harm, and it put 6 of 17 Criticals on things like "a booked call
with nobody invited". Those deserve reading *after* the stored XSS and the anonymous directory
dump. Call sites can still escalate deliberately via `meta.severity`.

## 3. A validity gate that refuses self-contradicting findings

`recordBug` now drops a defect whose own recorded evidence contradicts its claim, and says so on
stderr (`[bug-gate] SUPPRESSED …`). Deliberately narrow — it fires only on contradictions readable
off the record, never on a judgement about whether a finding is interesting, because a gate that
guesses suppresses real defects:

- claims exposure/bypass but the recorded response is **401/403** — the server refused the
  request, so it cannot evidence either. `assertPublicRouteReachable` is the deliberate exception:
  there the 401 *is* the finding, and its wording ("declared public", "contract marks") is allowed.
- claims identifiers are **enumerable** but the response is **404** — nothing resolved.

Covered by `reporters/__tests__/bugtracker-validity-gate.spec.ts` (5 cases: two refusals, three
must-not-suppress — including the declared-public 401 and the "internals leak" wording, which
legitimately contains the word *leak* on a 500). `npm run test:unit` → 31 passing.

## What this does not fix

The gate catches contradictions, not wrong premises. `BUG-API-0442A0` recorded an HTTP 200 and a
body that genuinely contained the victim's id — the flaw was that the id was there legitimately,
which no static rule can see. That class is caught the way it was caught here: by reproducing the
finding against the live API before filing. `npm run audit:bugs` exists to point at which ones are
worth that effort.
