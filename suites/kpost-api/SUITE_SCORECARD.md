# KPOST API Test Suite — Quality Scorecard

> Generated 2026-08-14 06:10:25 UTC by `reporters/generate-scorecard.ts`.
> **Every figure below is measured from a run artifact.** Where a rubric criterion
> could not be measured, the scorecard says so and deducts rather than assuming credit.

## Verdict: PRODUCTION-READY — 99/100

| Category | Score | Basis |
| --- | --- | --- |
| 1. Architecture & Maintenance | 25/25 | tsc 10/10 · no duplicate signatures 10/10 · legacy purged 5/5 |
| 2. Bug Detection & Resilience | 24/25 | 10-case floor 15/15 · active coverage 9/10 |
| 3. Zero Redundancy & Efficiency | 25/25 | no duplicates 15/15 · V1 purged 10/10 |
| 4. Reporting & Actionability | 25/25 | curl 8/8 · snippet 5/5 · owner 4/4 · artifacts 8/8 |
| **Total** | **99/100** | |

## Measured evidence

| Metric | Value |
| --- | --- |
| TypeScript compilation | tsc --noEmit exited 0 |
| Test cases enumerated | 4583 |
| Describe blocks | 301 |
| Unique METHOD+PATH signatures | 298 |
| Duplicate signatures | 0 |
| Signatures under the 10-case floor | 0 |
| Active (non-deprecated) operations in swagger.json | 310 |
| Deprecated operations in swagger.json | 98 |
| Active operations with no test signature | 12 |
| Active coverage | 96.1% |
| `tests/legacy/` present | no — purged |
| Defects in ledger | 99 |
| Critical / Major / Medium / Low | 22 / 26 / 47 / 4 |
| Defects carrying a curl reproduction | 99 (100%) |
| Defects carrying a Playwright snippet | 99 (100%) |
| Defects carrying an owning team | 99 (100%) |

## Artifacts

| Artifact | State |
| --- | --- |
| BUG_REPORT.md | present |
| BUG_REPORT.json | present |
| DEV_DIGEST.md | present |
| DEV_DIGEST.json | present |
| Playwright HTML (trace viewer) | present |
| JUnit XML for CI | present |
| Executive HTML (tier 2) | present |
| Trend history (tier 3) | present |
| Bug payload stream (tier 4) | present |

## Active operations with no test signature

Matched by normalising path variables away, so an endpoint covered under a templated
describe still counts. **These are not wholly untested** — the bare `@RequestMapping`
RedBus routes answer every verb, and the alternate verbs are exercised together in one
shared verb-binding block rather than one describe each. They are listed because they
have no *dedicated* signature, which is a real reporting gap even where the assertion
exists: a failure on `PUT /redbus/getTicket` surfaces under a generic block title.

- `PUT /redbus/getTicket`
- `POST /redbus/getTicket`
- `DELETE /redbus/getTicket`
- `PATCH /redbus/getTicket`
- `GET /redbus/checkBookedTicket`
- `PUT /redbus/checkBookedTicket`
- `DELETE /redbus/checkBookedTicket`
- `PATCH /redbus/checkBookedTicket`
- `GET /redbus/boardingPoint`
- `PUT /redbus/boardingPoint`
- `DELETE /redbus/boardingPoint`
- `PATCH /redbus/boardingPoint`

## How to disagree with this score

Each category is arithmetic on the evidence table, not a judgement:

- **Architecture** rewards a clean compile, zero duplicate route signatures, and the
  absence of `tests/legacy/`. It does *not* attempt to score "clean structure" — that
  is a code-review judgement a generator has no business awarding itself.
- **Bug detection** scores the 10-case floor and coverage breadth. It cannot measure
  whether the assertions are *good*, only that they exist and are numerous, so a high
  score here is necessary but not sufficient.
- **Redundancy** is fully mechanical.
- **Reporting** counts the proportion of ledger entries that carry a curl command, a
  Playwright snippet and an owning team, plus the proportion of expected artifacts that
  actually exist on disk.

A verdict of PRODUCTION-READY requires 90+. That threshold is about the *test suite*,
not the API under test — the API itself is failing its own release gate, and the
defect counts above are the reason.
