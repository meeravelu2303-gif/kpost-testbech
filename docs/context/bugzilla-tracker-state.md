---
name: bugzilla-tracker-state
description: State of the KPost API Bugzilla product + .env cleanup done this project
metadata: 
  node_type: memory
  type: project
  originSessionId: b67c8dde-d115-46a2-b4d6-3797ba8e08c1
  modified: 2026-09-08T06:28:06.573Z
---

**Bugzilla "KPost API" product** was cleaned to **49 open, all valid, 0 duplicates** (from 92):
- 6 our-mistake "Route declared public rejects anonymous" tickets (defect 486AC0; profile/fetchUserDetails,
  katchup/downloadAttachment, katchup/mediaStreaming) resolved INVALID after the user confirmed those 3
  routes DO require auth. (Earlier, 9 common-tree forced-token tickets were already INVALID.)
- 37 tickets were **already-fixed** bugs (500-on-bad-input now returns 400) — resolved FIXED after a live
  re-probe confirmed each. Remaining 49 = 43 reproduce-in-fresh-run + bug 140 (userLogoutFromAllDevices still
  500s) + 572 (envelope-shape) + concurrency 201/222/223.
- Filer dedup (`reporters/dashboard-bugzilla.ts` `findExistingOpenBug`) is safe: open→comment, INVALID/
  WONTFIX/WORKSFORME/DUPLICATE→skip (never re-file), FIXED→reopen original, unseen→create. So a full run
  will NOT create duplicates or re-file WONTFIX/INVALID bugs. `JUDGED_NOT_A_DEFECT` = those 4 resolutions.
- Maintenance scripts: `scripts/bugzilla/` — resolve-invalid-common-auth.js, close-fixed-bugzilla-bugs.js,
  reconcile-bugzilla-duplicates.js, verify-open-bugs.js. All dry-run by default; `--apply --yes` to write.
- **`BUGZILLA_DRY_RUN=false` in root `.env` and `admin/.env`** — a normal `npm test` files live. Force
  `BUGZILLA_DRY_RUN=true` for verification/truth-generation runs.

**Public-route coverage added:** wired `assertPublicRouteReachable` (token-less reachability) into 11
genuinely-public endpoints (userLogin, signup, enterprise signup/adminUserLogin as Critical; kpostIdExist,
kpostIDsuggestionList, generateJWTokens, crypto/public-key, setAccessCode, adminRegistration, shareUserDetails
as Major). Login/signup endpoints must probe with an INVALID body (→400) not full fake creds (→401 cred-reject).

**All 6 `.env` files** (root, kmail/, admin/ + .env.example each) were cleaned to production structure,
war-story comments trimmed, admin/.env duplicate-`QA_PASSWORD` bug fixed. Real secret values preserved.

See [[working-constraints]], [[excel-alignment-task]].
