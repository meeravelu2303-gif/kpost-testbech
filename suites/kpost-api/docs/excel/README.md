# The Excel contract, in machine-readable form

`endpoints.json` is the KPost API workbook (`KPOST API (5).xlsx`) parsed into JSON. It is the
input to the Excel conformance gate (`npm run audit:excel`, `scripts/excel-conformance.js`).

## Why it is checked in

The workbook is **authoritative for request payloads** — where it and swagger disagree, it wins
(root `CLAUDE.md`). Two consequences follow:

- **CI cannot depend on a spreadsheet on someone's D: drive.** The parsed form travels with the
  repo, so the gate runs anywhere.
- **A contract change should be reviewable.** When the workbook changes, regenerating this file
  produces a diff a human can read in a pull request — which field appeared on which endpoint —
  instead of an opaque binary.

## Record shape

```json
{
  "tab": "KatchupAPI",
  "row": 3,
  "module": "Signup",
  "url": "https://devapi2.kpostindia.com/v2/signupLogin/fetchUserDetails/",
  "path": "/v2/signupLogin/fetchUserDetails/",
  "request": "{\n    \"kpostID\": \"karans@kpost.in\",\n    \"countryID\":1\n}",
  "yellow": false
}
```

`row` is the 1-based worksheet row, so a finding can be traced back to the cell it came from.
`request` is the documented body **verbatim**, including the prose some cells mix into the JSON
(`"type": 1- Daily, 2 - Weekly`) — the gate reads field names out of it rather than parsing it as
JSON, so those cells still contribute.

## `yellow` — the single most important field

A yellow (`#FFFF00`) fill on the endpoint cell marks an endpoint that has been **superseded and is
no longer used**. Those rows are out of scope by instruction: the gate skips them entirely and
they count neither for nor against conformance. 21 of the 322 rows are yellow.

The flag comes from the cell's resolved fill colour, which means reading `styles.xml` and
following each cell's style index — the fill is not stored on the cell itself. Any regeneration
must preserve this, because losing it silently pulls 21 dead endpoints back into scope.

## Regenerating

Re-parse the workbook when it is updated, keeping records sorted by `(tab, row)` so the diff stays
readable. The parser must handle two OOXML details that are easy to get wrong:

1. **Self-closing cells.** `<c r="B4" s="2"/>` and `<c r="B4" s="2">…</c>` need separate
   alternatives in the pattern. A single greedy pattern consumes the `/` and then matches through
   to a later `</c>`, swallowing the cells in between and shifting every subsequent column — which
   silently misattributes payloads to the wrong endpoints.
2. **Shared strings.** Cell text is an index into `sharedStrings.xml`, not a literal.

After regenerating, run `npm run audit:excel`. A drop in conformance means the workbook documents
something the suite does not yet send; that is the gate doing its job, not a reason to lower the
threshold.
