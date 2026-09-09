---
name: excel-alignment-task
description: "Ongoing task — align 6 KPost test modules' payloads to the \"KPost API\" Excel, production-grade"
metadata: 
  node_type: memory
  type: project
  originSessionId: b67c8dde-d115-46a2-b4d6-3797ba8e08c1
  modified: 2026-09-08T10:20:15.133Z
---

Aligning KPost API test-bench payload builders + tests to the authoritative "KPost API" Excel
spreadsheet, module by module, same production-grade pass done earlier for auth/common/companyAdministration.

**Method per module** (mirrors how common/auth were done):
1. Extract the module's request payloads from the Excel dump (see [[excel-dumps-location]]).
2. Make each payload builder match the Excel body EXACTLY (drop extra swagger-era fields, add missing ones, fix nested shapes).
3. **False-finding prevention:** re-point every fuzz test (`assertRejectsInvalidInput`, SQLI/XSS) that targeted a now-removed/renamed field to a REAL Excel field — otherwise a phantom field is ignored, the real payload stays valid, the call succeeds, and `assertRejectsInvalidInput` files a FALSE "invalid input accepted" defect.
4. Per-endpoint token handling per swagger `security` (public → `assertPublicRouteReachable`, protected → `assertUnauthorized`).
5. `npm run typecheck` must stay CLEAN.

**6 target modules & status — ALL DONE (typecheck CLEAN, all collect):**
- redbus — DONE. tripDetails→`{tripID}`, tripDetailsV2→`{inventoryId}`, blockTicket→Excel passenger shape (seatName INSIDE passenger); re-pointed serviceCharge→inventoryItems[].fare, bookingType→availableTripId.
- kwordDocuments — DONE. Decoupled create=`{titleOfDocument,subject,topic,subTopic}`, saveContent=`{docTitle,compose,docId}`, share=`{docId,kWordDocshares:[{kpostId,role,validUpto}]}`, added `buildJoinDocumentPayload`. Re-pointed create fuzz docTitle→titleOfDocument, heading/compose→subject.
- kpresentation — DONE. create=`{titleOfPresentation,subject,topic,subTopic}`, save=`{presentationTitle,slides,presentationId}`; re-pointed create fuzz off save-only fields.
- knews — DONE. updateKnewsSettings dropped kpostId + fixed subscriptionDetails to stringified JSON; split lookup into `{categoryId}`/`{languageId}` (buildPublicationPayload added); kept kpostId IDOR tests, re-pointed required-field tests to real fields.
- kdiary — done earlier (createSchedule +kallSession/meetingLink/snoozeDetails; createEvent +snoozeDetails/seriesEndDate).
- kallV2 — DONE (main gaps). User confirmed Q1: kallStatus is NUMERIC per v2 routes (our `2` is correct). scheduledKall/scheduledRepeatKall now Excel-exact: scheduledStartTime/End are EPOCH MILLIS (added `kallEpoch`/`kallDate` helpers), added meetingLink/repeatType/repeatedDate(stringified {start_date,end_date}), kallDetails→`{receiver}`. buildKallROPayload stays a superset workhorse (KallROV3 DTO).

**Q2 RESOLVED (developer):** kall `kallID` is shared across the whole call; `id` is unique PER RECEIVER
(multi-receiver call = one kallID, distinct id per receiver). Added Excel-exact builders in kallV2.payload.ts:
`buildUpdateKallStatusPayload` = `{id, kallStatus:2, kallID}`; `buildSenderKallStatusPayload` = `{sender,
kallStatus:2, kallID}`; `buildReceiverKallStatusPayload` = `{id, kallStatus:2, receiver, kallID}` (statuses
2/3/9 only). Re-pointed the updateKallStatus describe → buildUpdateKallStatusPayload and the
updateSenderAndReceiverKallStatus describe → sender builder, plus added a [1b] receiver-variant happy path.

**Q3 RESOLVED (developer):** kword create trailing `""` in Excel is a spreadsheet artifact — the 4 named
fields (titleOfDocument, subject, topic, subTopic) are correct as aligned.

**Q4 RESOLVED (developers added to "KPOST API (4).xlsx", dumped to scratchpad/xls4/):** kword `update`
= `{docId, heading:[{topic,children:[...]}]}` (recursive outline tree → added `buildUpdateHeadingPayload`,
re-pointed update describe + docTitle fuzz→heading); `isConvertToKad`=`{docId,convertToKad}` and
`deleteHeading`=`{docId,headingId}` already matched. Diff (3)→(4) confirmed those 3 kword rows were the
ONLY change. Redbus `bookticket/cancelticket/ticketdetails/getUpdatedFare/seatLayout/getTicket/checkBookedTicket`
remain NOT in the Excel — kept swagger shape (developer confirmation still welcome but not blocking).

**Q6 RESOLVED:** redbus tripdetailsV2 = `{inventoryId}` only (Excel flow) — removed the clientIp spoofing
test, re-pointed clientIp SQLI/XSS → inventoryId.

**ALL 6 MODULES COMPLETE. Q1–Q6 all resolved. typecheck CLEAN, all specs collect. Nothing committed
(user commits manually). Latest Excel = "KPOST API (4).xlsx" (scratchpad/xls4/).**

**Also verified/aligned earlier this project:** companyAdministration (11 builders → Excel "Admin" rows in KatchupAPI.txt), plus the Types-tab enum fix (KMail `KMAIL_TYPE` was using Katchup values; corrected forward 15→2, note 5→6, share 2→11).

**KMail suite Excel alignment + coverage + comment cleanup — DONE.** Full readable record moved to
[[kmail-alignment]] (5 payload fixes, count-days-limit coverage added, all 66 endpoints verified
covered, comments trimmed; 834 tests, typecheck CLEAN). Latest workbook = "KPOST API (5).xlsx"
(xls5/); v4→v5 KMail diff = only `getMailCountDaysLimit` POST→GET. KatchupAPI/KDIARY/Types tabs in
v5 not yet diffed vs v4.
