---
name: excel-dumps-location
description: "Where the \"KPost API\" Excel tab dumps live and which tab holds each module"
metadata: 
  node_type: memory
  type: reference
  originSessionId: b67c8dde-d115-46a2-b4d6-3797ba8e08c1
  modified: 2026-09-08T10:00:39.843Z
---

The authoritative "KPost API" Excel was dumped to text (shared strings resolved) under the
session scratchpad `xls/` dir. Path pattern (session-specific, may differ after resume):
`.../scratchpad/xls/*.txt`. Dump helper: `scratchpad/xlsx-dump.cjs <file.xlsx>`.

Available tab dumps and what they contain:
- `KatchupAPI.txt` — a LARGE combined tab; despite the name it holds Katchup **plus** Admin/`/admin`,
  Kword, KPresentation, Redbus, Knews, Common rows. Grep by endpoint URL `[A] https://...`.
- `KDIARY.txt` — kdiary endpoints.
- `Kool_Kall.txt` — kall (KallV2) endpoints.
- `KMAILAPI.txt` — KMail suite.
- `Types_Katchup_Kall_KDiary_.txt` — enum definitions (messageType, kmailType, kallStatus/Mode/Type/RepeatType, RECEIVER_TYPE, kdiary remarks, priority, USERTYPE).
- `Sheet3.txt` — common/auth reference rows (mobileNoExist, signupLogin, forgotPassword).
- `Sheet8.txt` — KMAIL_TYPE / message-content reference table.
- `V2_TESTED_APIS.txt` — general V2 API test sheet.

To find a module's rows: `grep -nE "\[A\] https?://[^ ]*/<pathfragment>" <tab>.txt`. Column `[L]`
holds the request body; `[M]` holds the sample response. The source `.xlsx` is NOT in the repo
(`data/kpostID_attribute_usages.xlsx` is a DIFFERENT generator input). The user keeps the real
workbook in **`C:\Users\Administrator\Downloads\KPOST API (N).xlsx`** (highest N = newest). Re-dump
with: `node <scratchpad>/xlsx-dump.cjs "<file.xlsx>" "<outdir>"`.

**LATEST = "KPOST API (5).xlsx" (Sep 8, dumped to scratchpad/xls5/).** Diff v4→v5 KMAILAPI: ONLY
change is `getMailCountDaysLimit` method POST→GET. (KatchupAPI/KDIARY/Types tabs not yet diffed v4→v5.)
Prefer xls5 over xls4/xls.

**IMPORTANT — KMAILAPI.txt column layout differs from the other tabs:** columns are `[C]` method,
`[D]` URL path, `[E]` Parameters/Request, `[F]` "After Token Implemented Parameters/Request", `[G]`
sample response. The current request body is in `[F]` for early rows but in `[E]` for later rows
(post-token, no before/after split). **Read `[E]` whenever `[F]` is blank.** (The OTHER tabs use
`[L]`=request body, `[M]`=response.)

**"KPOST API (4).xlsx" (dumped xls4/):** kword `update`=`{docId, heading:[{topic,children:[...]}]}`,
`isConvertToKad`=`{docId,convertToKad}`, `deleteHeading`=`{docId,headingId}` — the only v3→v4 change.

Related: [[excel-alignment-task]].
