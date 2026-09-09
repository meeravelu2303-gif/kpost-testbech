# KMail API Automation

Playwright API test automation for the **KPOST KMail API (v5.0)** — 813 tests across all 82
endpoints, mirroring the architecture of the `KPOST-AUTOMATION-v1` bench.

## Two hosts, and why it matters

KMail has **no login route**. Its OpenAPI document declares one security scheme, `bearerAuth`,
described as a *"JWT issued by the KPOST auth service"*. So the suite talks to two hosts:

| | |
|---|---|
| **Service under test** | `KMAIL_BASE_URL` — every request in `tests/` goes here |
| **Token issuer** | `KPOST_AUTH_BASE_URL` — the auth handler logs in here, and nowhere else |

This is the first thing to check when a run goes wrong. A token minted against one platform
deployment authenticates nothing against a KMail service from another, and the response is the
same `401` as a wrong password. `src/helpers/authSession.ts` verifies the minted token against
the KMail host before the run starts and says so explicitly when it fails.

## Getting started

```bash
npm install
cp .env.example .env        # then fill in QA_KPOST_ID / QA_PASSWORD
npm test
```

Every run prints what it is pointed at before the first test:

```
  KMail API automation
    service under test : http://192.168.0.66:9081  (KPOST KMail API (v5.0) v5.0)
    token issued by    : http://192.168.0.66:8989
    account            : qa...@kpostindia.com
    ownership victim   : qa...@kpostindia.com
    bulk send          : disabled (ALLOW_BULK_SEND)
```

The service identity in brackets is read from the KMail host's own `/v3/api-docs`, so a
mistyped port shows up as one line here rather than as 82 routes returning 404.

### Required configuration

| Variable | Purpose |
|---|---|
| `KMAIL_BASE_URL` | The KMail service. Default `http://localhost:9081`. |
| `KPOST_AUTH_BASE_URL` | The KPOST platform API that mints the bearer token. |
| `QA_KPOST_ID` / `QA_PASSWORD` | The bench account. Without these, authenticated tests skip. |
| `QA_USER_TYPE` | Account tier. A wrong value fails **before** the password is checked. |
| `QA_VICTIM_KPOST_ID` | A **second real account**, used as the victim in ownership assertions. |

`QA_VICTIM_KPOST_ID` is worth setting deliberately. An identity that does not exist is the
worst possible victim: the API ignores it and serves the caller's own data, so a test comparing
"mine" against "theirs" sees two identical reads and reports a breach that never happened.
Unset, those assertions skip with the reason stated rather than filing something they cannot
substantiate.

See `.env.example` for the full documented set.

## Running

```bash
npm test                    # everything
npm run test:folders        # one domain module
npm run typecheck           # tsc --noEmit
npm run report              # open the HTML report
```

One Playwright project per domain module, because they have genuinely different risk profiles:

| Project | Covers | Writes? |
|---|---|---|
| `auth` | The authentication matrix across all 45 secured routes | no |
| `compose` | `postMail`, multipart send, the legacy path, mail credentials | **sends mail** |
| `drafts` | Draft save / update / read / list / delete lifecycle | yes |
| `read` | Mail bodies, threads, batch metadata, recipient lists | no |
| `attachments` | Upload limits and the four UUID-addressed download routes | yes |
| `folders` | Inbox, bulk, Important, counts, follow-up buckets | no |
| `actions` | Flag important, delete, clear status, PDF export | **destructive** |
| `search` | Conversation lookup, subject search, date and read-state filters | no |
| `contacts` | External contacts, sync, unsubscribe | yes |
| `settings` | Signature, letterhead, salutations, instant replies | yes |
| `translator` | Translation, and the two extra send paths on that controller | **sends mail** |

`npm run test:folders` against a production-like environment is a reasonable thing to want.
`npm run test:compose` against one is not.

## Safety rails

**KMail delivers real mail**, and several routes are irreversible. Three rails, all in the
framework rather than in individual tests:

- **Every recipient is synthetic.** `syntheticRecipient()` builds an unguessable non-existent
  address; no builder in `src/api/payloads/` invents a recipient of its own.
- **Bulk send is opt-in.** `postBulkMail` generates one mail *per recipient* and cannot be
  undone in one action, so anything that actually fans out is gated behind `ALLOW_BULK_SEND`.
  The size-limit cases assert the documented cap rather than trying to exceed it.
- **Attachment sizes are capped** at `MAX_ATTACHMENT_MB`. A suite that doubles the upload size
  until something breaks *is* the outage it is looking for; the limit specs assert that a large
  upload is refused, and report honestly when the cap meant they tested less.

Destructive identifiers (`kmailID`, `transactionID`) are drawn from a range far above any
plausible auto-increment value, so a route that acts on whatever it is handed cannot hide real
mail while proving a point.

## Layout

```
src/
  config/
    env.config.ts          two base URLs, credentials, safety rails
    global-setup.ts        pre-flight: is the service reachable, and is it KMail?
  helpers/
    base.client.ts         transport; captures every request, attaches every exchange
    authSession.ts         logs in against the auth host, verifies against the KMail host
    tokenStore.ts          JWT expiry, environment scoping, session cache
  api/
    routes/kmail.routes.ts all 82 routes, plus the auth matrix registry
    clients/               one client per controller
    payloads/              request builders, transcribed from the entities
    schemas/               Zod contracts
  fixtures/api.fixture.ts  worker-scoped session, per-test clients, invalid-token set
  utils/
    apiAssertions.ts       graded assertions: status, auth, IDOR, injection, bounds
    findings.ts            the findings ledger
    attachments.ts         generated attachment fixtures
tests/                     one directory per domain module
```

### Notes for anyone editing the payloads

The KMail entities are **not** annotated `@JsonIgnoreProperties(ignoreUnknown = true)`. An
unrecognised field is a hard Jackson 400 carrying a stack trace, not a silently ignored one — so
a builder that invents a convenience field fails every test that uses it, for a reason unrelated
to the endpoint. Field names in `src/api/payloads/` are transcribed from the entities exactly.

Payload shapes are aligned to the **KMail API Excel** column `[F]` ("After Token Implemented
Parameters/Request"), which is authoritative for the current request bodies; swagger and the
entity field list only decide which fields are *recognised* (so a builder never introduces an
unknown-property 400). Where the Excel `[F]` is empty for a route, the builder keeps its
swagger-derived shape.

Shapes that catch people out — each transcribed from the Excel `[F]`:

- **`draftMail` takes the compose DTO; `deleteDraftMail` takes the `Draft` entity.** Different
  shapes, and mixing them never reaches the code under test. `deleteDraftMail` is keyed on
  `{ kmailID, draftMailID, kmailSendDate }` — `draftMailID` is the mail-server message id, and
  omitting it (or `kmailSendDate`) targets the wrong row.
- **A draft stores `cc`/`bcc` as delimited strings**, where the send DTO uses `ccList`/`bccList`
  arrays.
- **`common/*` deletion is keyed on `transactionIDs`, not `kmailID`.** A transaction is one
  recipient's copy of a mail. Sending a `kmailID` there targets nothing and passes for the wrong
  reason.
- **`getKmailDashboardMsg` pages on `kmailID` (a string keyset cursor), not `lastKmailID`.**
  `""` is the first page; the next page sends back the oldest id held. `firstKmailID` is the
  opposite direction (anything newer). `selectedContactMails`, by contrast, does use
  `lastKmailID`/`firstKmailID`.
- **`readMail/sentAndInboxMailContent`'s `kmailType` is a direction — `"received"` or `"sent"`,
  not a folder name.** The route reads one identifier from either the inbox or the sent side;
  `kmailType` picks which and is `@NotBlank`. Use `MAIL_DIRECTION`, not folder strings.
- **`readMail/draftMailContent` is located by `{ draftKmailID, kmailSendDate, kmailSubject,
  senderUniqueMailID }`** and does **not** take `kmailType` (unlike `sentAndInboxMailContent`).
- **`kmailType` (compose/send) is the KMail enum, not Katchup's** — `0` New, `1` Reply, `2`
  Forward, `3` Reminder, `4` Draft, `5` Edit, `6` Note, `7` Delete, `8` Comment, `9` Clarify,
  `10` forward-thread, `11` share, `12` mail-otp, `13` bulkmail (`KMAIL_TYPE`). Recipient class
  is `RECEIVER_TYPE` — `1` to, `2` copy, `3` confidential.
- **Signature blocks are flat on the per-block endpoints, nested on the whole-signature one.**
  Each `saveOrUpdateMailSignature<Block>` takes its fields directly (personal data is
  `{ firstName, lastName, designation, emailId, mobileNumber, alternateMobile }`), while
  `saveOrUpdateMailSignature` nests the same blocks under `personalData` / `companyData` /
  `graphics` / `style` / `socialMedialink`. The template field is `templateID` (capital ID).

> The KMail Excel keeps the current request body in **column [F]** ("After Token Implemented")
> for the early rows and in **column [E]** ("Parameters / Request") for the later ones (added
> after tokens, so there is no before/after split). When aligning a builder, read `[E]` whenever
> `[F]` is blank — several settings/bulk shapes live only in `[E]`.

Timestamps are JDBC form (`yyyy-MM-dd HH:mm:ss.SSS`), not ISO-8601 — use `jdbcTimestamp()`.

## How findings are reported

Assertion helpers record a graded finding *before* they fail, so the report carries what was
sent, what came back, what the contract said, and why it matters. Findings appear as Playwright
annotations and JSON attachments in the HTML report, next to the test that produced them — no
separate reporter, no shared file handle between workers.

Severity is graded rather than uniform. An authentication bypass that returns mail content is
Critical; the same filter answering `400` instead of `401` is Minor and described as one shared
component rather than as forty separate defects. A `429` is treated as inconclusive — the bench
observing its own load — everywhere except the cases that deliberately assert throttling.

## Bug tracking & the QA Dashboard

When configured, the `publish` reporter compiles the run's findings into a deduplicated defect
ledger (`BUG_REPORT.json` / `BUG_REPORT.md`), files each defect into Bugzilla, and ingests the
run into the QA Dashboard. Unconfigured, it just writes the report files and says so in one
line — so it is safe on every run.

**Bugzilla — `KMail API` product (auto-assigned to Jitendra Kumar).** The product has nine
components, one per KMail controller, and **every component's default assignee is
`jitendra@kpost.in`**. The reporter never sets `assigned_to`, so each filed bug falls to its
component's default — which means every KMail defect auto-assigns to Jitendra, wherever it is
routed. Defects are deduplicated: a defect carries a deterministic `[KM-XXXXXX]` tag in its
summary, and a re-run comments on the existing open bug instead of filing a duplicate.

Filing is irreversible (Bugzilla has no delete), so it is gated conservatively:

```
BUGZILLA_URL=http://192.168.0.50/rest
BUGZILLA_API_KEY=...
BUGZILLA_PRODUCT=KMail API
BUGZILLA_DRY_RUN=true      # logs what it would file, creates nothing — start here
BUGZILLA_MAX_FILE=0        # cap the first real run (e.g. 1) to inspect before lifting
```

Run once with `BUGZILLA_DRY_RUN=true`, confirm the components and severities look right, then
`BUGZILLA_DRY_RUN=false BUGZILLA_MAX_FILE=1` to file one and check it, then lift the cap.

**QA Dashboard.** The KMail application is registered (slug `kmail`, ticket prefix `KM`). Its
ingest key embeds the slug, so only the URL and key are needed:

```
DASHBOARD_INGEST_URL=http://localhost:8081/api/ingest
DASHBOARD_API_KEY=qa.kmail....
```

To (re)register the app on a fresh dashboard, from the `QA-Dashboard` repo:

```
SLUG=kmail DISPLAY_NAME="KMail API" TICKET_PREFIX=KM KIND=api npm run seed:application
```

## Current environment status

**Authenticated coverage runs.** Both hosts point at the same `192.168.0.66` deployment
(`KMAIL_BASE_URL=http://192.168.0.66:9081`, `KPOST_AUTH_BASE_URL=http://192.168.0.66:8989`), and a
token minted at `.66:8989` is accepted by `.66:9081` — verified end-to-end. The earlier blocker
(a token from `192.168.1.176:8989` rejected `401` by a `localhost:9081` KMail from a different
deployment) is resolved: it was the two-hosts mismatch described above, fixed by pointing both at
the same deployment.

Latest full diagnostic run (815 tests): **683 passed · 90 failed · 42 skipped**. The ~500 tests
that skipped while the suite ran unauthenticated now execute — only **42** conditional skips
remain (opt-in `ALLOW_BULK_SEND`, and data guards that skip when a read legitimately returns
nothing). The **90 failures are real defects** the now-running authenticated coverage surfaces —
notably an **auth bypass**: `POST /v2/sentMail/loadMail` (and several UUID-addressed download
routes) answer an expired / missing / malformed / `alg=none` / wrong-key token with HTTP `200`
and data instead of `401`/`403`. If you get a quiet report again, the two-hosts mismatch is the
first thing to check — `authSession.ts` verifies the minted token against the KMail host and says
so explicitly when it fails.
