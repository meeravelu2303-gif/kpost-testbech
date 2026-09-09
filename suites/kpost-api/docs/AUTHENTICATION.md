# Authentication — how the bench gets a session, and what to do when it can't

> Written 2026-08-19, after a run that executed 4,583 scenarios, published a report and filed
> 387 defects **without ever having authenticated**. 296 of those defects were assertion
> failures downstream of the auth outage. This document exists so that cannot happen quietly
> again.

---

## 1. The rule

**Credentials are configuration. Tokens are derived state.**

| | Where it lives | Lifetime | Who sets it |
|---|---|---|---|
| `QA_KPOST_ID` / `QA_PASSWORD` | `.env` | until the account changes | you, once |
| access token | `.auth/session.json` | 24h, refreshed automatically | the bench, every run |

If you are pasting a bearer token into `.env`, something upstream is broken and this document
is about fixing that instead.

---

## 2. What was actually wrong

Three independent faults, stacked. They presented as one symptom ("the token expires and I
can't run the scripts"), which is why they were hard to separate.

### 2.1 `QA_AUTH_TOKEN` was a hand-carried token, and it was dead

Decoded, the value in `.env` read:

```
sub       qavf91dlmz@kpostindia.com
role      member
deviceID  41dd08eb-b2ec-4536-a5e9-3f06d1724055
iat       2026-08-17T14:22:12Z
exp       2026-08-18T14:22:12Z     <- exactly 24h TTL
```

By the time the suite was next run it was ~27 hours past expiry. This is not a mistake that
can be avoided by being careful; a 24-hour secret pasted into a config file is stale by
construction the following morning. The suite's response to the dead token was to continue
unauthenticated, which is fault 2's amplifier.

### 2.2 The credential fallback was pointed at a different backend

`authSession.ts` already had a fallback: log in with `QA_KPOST_ID` / `QA_PASSWORD`. It failed
with:

```json
{"statusCode":500,"status":"FAILURE","message":"Invalid Credential","urlPath":"/userLogin/"}
```

That message is the trap. `swagger.json` documents it explicitly: *"rejected credentials and
genuine server faults both report the same message — this does not distinguish a wrong
password from an outage."* In practice it also covers **no such account**, **account not
active**, and **wrong environment**.

Two facts settle which one it was:

- `qavf91dlmz@kpostindia.com` is not a UI account. It is `"qa" + 8 lowercase alphanumerics` —
  the exact output of `randomKpostId()` — and `Qa@Passw0rd123` is the string literal in
  `buildSignupPayload()`. The account was minted **by the bench itself**, against whatever
  `BASE_URL` was set at the time.
- `BASE_URL` has moved four times in this repository's history (`git log -p -- .env.example`):
  `localhost:8989` → `192.168.0.158:8989` → `192.168.1.58:8989` → `192.168.1.1:8989`, and
  `.env` today reads `localhost:8989`.

A KPOST account exists in exactly one backend's MySQL. A credential minted against one host is
not a credential against another, and the API reports that as a bad password. Days went into
debugging a password that was never wrong.

> Run `npm run auth:diagnose:all` to see this directly: it probes every host this repo has
> pointed at and tells you which one your account actually lives in.

### 2.3 The suite revoked its own session, mid-run, on every run

`tests/auth/signupLogin.spec.ts` exercised `userLogout` and `userLogoutFromAllDevices` — 
including an idempotency case firing two revoke-all calls concurrently — using
`staticToken`, **the run's live shared session**.

`AuthenticationFilter` matches a token's `deviceID` claim against the login-session table on
every request. Revoking that session therefore took every other worker's authentication down
with it. The 401s that followed were filed as defects against unrelated modules.

The same shape existed in `tests/profile/userProfile.spec.ts`: the `deactivateAccount` block
fires "this must be refused" cases at the shared identity. The entire purpose of this bench is
to find the case where the API does *not* refuse — and the first time that succeeds, the
account everything depends on is gone.

---

## 3. What now happens instead

```
globalSetup                     once per run
  └─ establishSession()
       1. cached session        .auth/session.json, scoped to BASE_URL
       2. refresh               generateJWTokens with the stored refresh token
       3. credential login      QA_KPOST_ID / QA_PASSWORD, stable device id
       4. static override       QA_AUTH_TOKEN, if you really must
       5. throwaway signup      last resort; owns no data
       └─ no session?           RUN ABORTS (unless ALLOW_UNAUTHENTICATED_RUN=1)
```

Five things changed, each fixing one of the failures above:

1. **Tokens are cached, not configured.** `.auth/session.json` (gitignored, mode 0600) records
   the token *and the environment it was minted against*. A cache entry from a different
   `BASE_URL` is discarded, never reused — 2.2 is now structurally impossible.
2. **Tokens refresh.** `exp` is read before use; anything with under
   `TOKEN_REFRESH_SKEW_SECONDS` (default 600) left is exchanged via `generateJWTokens` rather
   than carried into a 250-second run.
3. **One device, not one per login.** `deviceIdentity_primary` is derived deterministically
   from (`BASE_URL`, `QA_KPOST_ID`) instead of `faker.string.uuid()` per call. The bench used
   to open a new login-session row on every login by every worker.
4. **One login per run, not one per worker.** `globalSetup` mints; workers read the cache.
5. **No silent unauthenticated runs.** If no session can be established, the run aborts before
   a single assertion executes, instead of publishing a report about coverage it never ran.

Destructive tests were re-pointed at throwaway identities:

| Test block | Token it uses now | Why |
|---|---|---|
| `userLogout`, `userLogoutFromAllDevices` | `revocableToken` — same account, throwaway device | revoking is the thing under test |
| `deactivateAccount` | `disposableToken` — a freshly registered account | success would destroy the QA account |

Both skip with an explicit reason when no disposable session can be minted, rather than
falling back to the shared one.

---

## 4. Setting it up

```bash
cp .env.example .env
```

Then set three things:

```dotenv
BASE_URL=http://localhost:8989           # the backend you are testing
QA_KPOST_ID=youraccount@kpostindia.com   # an account that exists on THAT backend
QA_PASSWORD=...
QA_USER_TYPE=PERSONAL                    # BUSINESS_M etc. for a company identity
```

`QA_USER_TYPE` is not decoration. It is sent as `loginRO.userType`, and the wrong tier fails
*before* credential validation on some accounts — a correct password still cannot
authenticate, and the error names neither field.

Then:

```bash
npm run auth:check      # ~5s: will the suite authenticate?
npm test                # full run
```

That is the whole workflow. `npm run seed` still exists for bootstrapping an empty database,
but it is no longer part of the normal path, and it no longer needs to write a token into
`.env`.

### Getting a QA account onto this backend

In order of preference:

1. **Sign up through the UI that talks to this backend.** Confirm the UI's API host first —
   open devtools → Network → any request → check the origin. A UI pointed at
   `192.168.0.158:8989` does not create accounts on `localhost:8989`.
2. **`npm run seed`** — registers a throwaway account against `BASE_URL` and reports each step.
3. **Ask a developer to create one**, and to mark it non-expiring / exempt from lockout if the
   platform supports that.

---

## 5. When login is still refused

`npm run auth:diagnose` walks the causes in order and names the one that fits. It probes
public (`permitAll`) endpoints only, needs no token, and does not depend on the framework
compiling.

```bash
npm run auth:diagnose            # against BASE_URL
npm run auth:diagnose:all        # sweep every host this repo has pointed at
node scripts/auth/diagnose-login.js --host http://192.168.0.158:8989
```

It reports: reachability, whether the account exists on that host (`kpostIdExist`, which
`userLogin` refuses to tell you), which of four documented login body shapes works, and
whether the resulting token survives a protected read.

### Confirming in MySQL

The API cannot distinguish these; the database can.

```sql
-- 1. Does the account exist on THIS backend at all?
SELECT kpostID, activeStatus, userType, countryID, createdDate
FROM   user
WHERE  kpostID = 'youraccount@kpostindia.com';
```

*No row* → wrong environment, or signup never committed. This is the single most likely
answer. Fix `BASE_URL`, or create the account here.

*Row with `activeStatus` not active* → signup writes the row before mobile verification
clears, so an unverified account authenticates as "Invalid Credential" indefinitely.

*Row with a `userType` that differs from `QA_USER_TYPE`* → the tier mismatch described above.

```sql
-- 2. How many device sessions is this account carrying?
SELECT deviceIdentity_primary, deviceType, logintime
FROM   login_session
WHERE  kpostID = 'youraccount@kpostindia.com'
ORDER  BY logintime DESC;
```

Hundreds of rows is the fingerprint of the old per-login random device id. If the platform
caps devices, that cap is a login failure reported as — again — "Invalid Credential". Clearing
old rows for the QA account is safe; the bench now adds exactly one.

> Table and column names follow `swagger.json`'s descriptions of the user and login-session
> tables. Confirm them against the schema before running these — this bench has never had a
> database connection and does not want one.

### If everything above checks out

One possibility remains, and it is worth knowing about: **the password may be expected
encrypted, not plaintext.** `docs/api.json` records a real `adminUserLogin` body from
2025-08-08 carrying

```json
"password": "0FPnV+OKhDGGXMkQjtj1eQ=="
```

That is 16 bytes of base64 — one AES block — not a plaintext password. If the web client
encrypts before POSTing, a plaintext password can never authenticate no matter how correct it
is. `/crypto/public-key` (RSA, for `PayloadDecryptionFilter`) is a separate mechanism and
currently answers HTTP 400 on this build, so it is not the blocker today.

To settle it: log in through the browser with devtools open, find the `userLogin` request, and
compare its `password` field byte for byte with what `buildLoginPayload` sends. If they
differ, the encryption scheme and its key are the missing piece and a developer has to supply
them.

---

## 6. Reference

| Command | Does |
|---|---|
| `npm run auth:check` | preflight — will the suite authenticate? |
| `npm run auth:diagnose` | why not? names the exact cause |
| `npm run auth:diagnose:all` | same, swept across every known host |
| `npm run auth:reset` | discard the cached session and re-mint next run |
| `npm run seed` | register a throwaway account on `BASE_URL` |

| Variable | Default | Notes |
|---|---|---|
| `BASE_URL` | `http://localhost:8989` | the account must exist **here** |
| `QA_KPOST_ID` / `QA_PASSWORD` | — | the only auth config that belongs in `.env` |
| `QA_USER_TYPE` | `PERSONAL` | `loginRO.userType`; `BUSINESS_M` etc. for companies |
| `QA_COUNTRY_ID` | `1` | `loginRO.countryID` |
| `QA_DEVICE_ID` | derived | pin only if you need a specific device identity |
| `TOKEN_REFRESH_SKEW_SECONDS` | `600` | refresh anything with less life than this |
| `ALLOW_UNAUTHENTICATED_RUN` | `0` | `1` to measure the unauthenticated surface on purpose |
| `AUTH_STATE_FILE` | `.auth/session.json` | gitignored, mode 0600 |
| `QA_AUTH_TOKEN` | unset | escape hatch; never refreshed, never cached |
