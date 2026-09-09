# V1 / legacy routes — decommission risk register

> Written 2026-08-11, at the point the V1 test suite was removed from the automation run.
> **This file is the surviving record of what those tests found.** It is not generated; do not
> delete it until the routes themselves are gone from the deployed artifact.

## Why this file exists

The V1 test suite (`tests/legacy/`, 98 operations, ~1,300 cases) was deleted so that execution
capacity goes to active V2 routes. That is a reasonable call about **where to spend test time**.

It is not a fix. Deleting a test removes the alarm, not the fault. Every route listed below was
reachable and answering on `http://localhost:8989` at the time of deletion, and the audit that
preceded the V1 suite established three things that still hold:

1. **No V1 path collides with a V2 path.** They are separate routes with separate handlers.
   Superseding them in the product did not unmount them from the application.
2. **None of them appear in `api.json`,** the development team's own 543-row QA tracker export.
   They were untested from both sides before this suite existed, and are again now.
3. They include the platform's most sensitive verbs — a second login, a second password change,
   a second credential-recovery route, and a group-admin grant.

The risk of removing the tests is therefore specific and worth stating plainly: **these routes
remain exploitable, and nothing now watches them.** Traffic to a V1 endpoint generates no test
failure, no report entry, and no alert.

## What closes this register

Deleting the tests does not. The register is closed when the **controllers are removed from the
deployed artifact** (or the paths are blocked at the gateway) and that removal is verified by a
request returning 404. Until then, treat this as an open finding list.

A single verification is enough per route:

```bash
curl -s -o /dev/null -w '%{http_code}\n' -X POST http://localhost:8989/signupLogin/userLogin
# 404 = decommissioned.  Anything else = still live.
```

## Findings at deletion time

The V1 surface produced **491 distinct defects**: 73 Critical, 91 Major, 270 Medium, 57 Low.
Roughly two-thirds trace to the same root cause as the V2 findings — **no bean validation on
request DTOs** — which means a `@Valid` rollout that covers only V2 controllers leaves all of
these standing.

### The ones that are not just missing validation

| Route | Finding |
| --- | --- |
| `POST /signupLogin/setAccessCode` | Accepts a **null, empty, or single-digit access code**. The V1 route silently strips or trivialises an account's second factor. |
| `POST /kall/katchupKall` | **Stored XSS** — a script payload was accepted and persisted unescaped. |
| `POST /signupLogin/userLogin` | A second, unmonitored login implementation. Any password-policy or lockout hardening applied to `/v2/signupLogin/userLogin` does not apply here. |
| `POST /profile/changePassword` | A second, unmonitored password-change implementation. |
| `POST /profile/forgotPWDorIDorAccessCode` | Combined credential-recovery route that takes both the target identity and the replacement secret from one unauthenticated body. |
| `POST /group/addOrRemoveAdminAccess` | Group-administrator grant that takes both the group and the target member from the request body. |
| `GET /kall/clearKallHistory` | Destructive wipe exposed on a GET, mirroring the confirmed V2 defect. |
| `POST /contacts/deleteContact`, `blockOrUnBlockContact` | Accept a null or omitted `contactID`. |
| `POST /dashboard/homeDashboardMsgs`, `katchupDashboardMsg` | Accept an unbounded `pageSize` — a paged read becomes a full export. |
| `POST /profile/update*` (9 routes) | Accept null, empty and omitted values on every field; an empty body is a full-record overwrite with nulls. |

### The abandoned tree

`unusedv2/kall` (15 operations) is labelled abandoned in its own base path. The suite's first
assertion on each of those routes was simply *does it answer at all* — because `unusedv2` is a
developer's note, not an access control. If those controllers are still component-scanned they
are still routable, and an abandoned route is one nobody has patched.

## Recommendation

**Delete the controllers rather than fix them.** Every one of these routes duplicates a live V2
route that already exists. Fixing them doubles the maintenance surface permanently; removing
them closes 491 findings in one commit and makes this register obsolete.

If they cannot be removed immediately, block the nine path prefixes at the gateway —
`/signupLogin/`, `/profile/`, `/common/`, `/contacts/`, `/katchup/`, `/kall/`, `/group/`,
`/dashboard/`, `/unusedv2/` — noting that these are the **unversioned** prefixes and must not
match the `/v2/...` routes that carry live traffic.

## Restoring the tests

The V1 suite is recoverable from git history if the decommission slips and monitoring is wanted
again. It was four spec files under `tests/legacy/`, plus `src/api/clients/legacy.client.ts` and
`src/api/payloads/legacy.payload.ts`, and a `legacy` project entry in `playwright.config.ts`.
Its distinguishing feature was `compareWithV2()`, which fired one payload at a V1 route and its
V2 counterpart concurrently — so the finding read "V1 accepted what V2 refused" and named the
implementation to delete.
