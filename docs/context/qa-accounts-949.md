---
name: qa-accounts-949
description: "The meera949 QA accounts for all four usertypes on host 192.168.1.96, with tier member caps"
metadata: 
  node_type: memory
  type: project
  originSessionId: b67c8dde-d115-46a2-b4d6-3797ba8e08c1
  modified: 2026-09-09T06:14:39.339Z
---

QA test accounts created on host **192.168.1.96:8989** (all password `<QA_PASSWORD — see the suite .env>`,
created via mock OTP `123456` which this host honors; old host 192.168.0.66 did not).
Creation flow: `/v2/common/sendOTP` â†’ `/v2/common/validateOTP` â†’ registration.

| Usertype | kpostID | Mobile | Register endpoint | maximumMembersCount |
|---|---|---|---|---|
| PERSONAL (BROKEN) | meera949@kpostindia.com | 9000000949 | `/v2/signupLogin/signup` | â€” |
| PERSONAL (PRIMARY) | meera951@kpostindia.com | 9000000955 | `/v2/signupLogin/signup` | â€” |
| BUSINESS_S | meera@m949s.kpost.in | 9000000950 | `/v2/signupLogin/adminRegistration` | 10 |
| BUSINESS_M | meera@m949m.kpost.in | 9000000951 | `/v2/signupLogin/adminRegistration` | 250 |
| BUSINESS_L | meera@m949l.kpost.in | 9000000952 | `/v2/signupLogin/adminRegistration` | 2000 |
| PERSONAL (victim) | meera950@kpostindia.com | 9000000953 | `/v2/signupLogin/signup` | â€” |

**Receivers/IDOR counterparties (in .env + kmail/.env):** the OLD victim `qabenchnwvfb@kpostindia.com`
and business receiver `md@qaadmv29531.kpost.in` were from the old host and don't exist on 192.168.1.96
(same as meeravelu23). Replaced: `QA_VICTIM_KPOST_ID` = **meera950@kpostindia.com** (created as the
IDOR/messaging counterparty â€” fresh, owns a profile; seed it with mail/messages later for richer
message/mail-IDOR); `QA_BUSINESS_RECEIVER_KPOST_ID` = **meera@m949m.kpost.in** (our verified BUSINESS_M).

**Tier member caps are exact per-tier values the backend validates** â€” S=10, M=250, L=2000.
Any other count returns HTTP 400 `"Invalid maximumMembersCount for userType"`. All three
business tiers use the SAME `adminRegistration` endpoint (not the mediumAndLarge signup â€” that
one rejects with `"Domain is not available"` unless the domain is pre-reserved). Login: PERSONAL
+ BUSINESS_S via `/v2/signupLogin/userLogin`; all business via `/signupLoginForMediumAndLarge/adminUserLogin`.
All four verified TOKEN OK, and PERSONAL + BUSINESS_S confirmed through the suite's own
`scripts/auth/diagnose-login.js` path.

**meera949 BROKE 2026-09-08 (~after the 12:32 run) â€” ROOT CAUSE CONFIRMED DB-WISE 2026-09-09: its
LOGIN PASSWORD WAS CHANGED, NOT locked/deactivated.** DB proof (`tbl_kpost_user_master` on
127.0.0.1:3306/kpost_testdb, the live KPost app DB): meera949 `active_status=yes`, same domain_id=29 /
user_type=PERSONAL as the working accounts â€” fully healthy. The `password` column is reversible AES,
**deterministic** (same plaintext â†’ byte-identical ciphertext): meera950/meera951/m949s/m949m/m949l ALL
share ciphertext `rcGAFVCq1nz5WDfkyzogNg==` (= `<QA_PASSWORD — see the suite .env>`), but meera949 alone holds a different
value `AtpYv2vxusSdprsxe3N9iA==` â†’ its password is no longer <QA_PASSWORD — see the suite .env>. Cause: meera949 was the
shared QA_KPOST_ID (created 08:15:07, earliest of the batch) when a `changePassword` test fired at the
shared session during the 12:32 run â€” BEFORE the safety fix routed changePassword/deactivate to
disposable accounts. **One-line fix (deterministic cipher, no AES key needed):**
`UPDATE tbl_kpost_user_master SET password='rcGAFVCq1nz5WDfkyzogNg==' WHERE kpost_id='meera949@kpostindia.com';`
then <QA_PASSWORD — see the suite .env> works again. **APPLIED & VERIFIED 2026-09-09:** user ran the UPDATE; meera949 logs in again. (The two `password` vs `kmail_password` columns: KPost login reads the
AES `password`; `kmail_password` is a separate bcrypt hash.) Replaced by **meera951@kpostindia.com** (9000000955) as the
SHARED primary in BOTH `.env` (QA_KPOST_ID) and `kmail/.env` (QA_KPOST_ID) â€” the user requires the SAME
user in both modules. QA_ADMIN=meera@m949s, victim=meera950 unchanged. Cleared stale `.auth/session.json`
in both suites (KMail cache still held the old meeravelu23 â†’ caused KMail to run WITHOUT a session, 491
"failures" that were setup-not-bugs). Cause of meera949 lockout unconfirmed; the changePassword safety
fix is in place so it shouldn't recur from that path. **KMAIL BLOCKED ON BACKEND (2026-09-08):** the KMail service (`:9081`) rejects EVERY JWT issued by KPost
auth (`:8989`) with `401 "Invalid Data"` on protected routes â€” on BOTH hosts (192.168.0.66 and
192.168.1.96), for every account incl. brand-new signups (meera951/950/952). Token is valid HS512
(sub/deviceID/exp) and login creates a matching device session, yet KMail refuses it. Root cause = KMail
and KPost-auth don't share the JWT signing secret / login-session store (or account needs KMail mailbox
provisioning). Reported to developers. Signup/OTP(mock 123456)/login/KPost all WORK. **KMAIL TOKEN-TRUST FULLY WORKING
(verified 2026-09-09) â€” EVERY account opens KMail.** Clean unique-device probes (login @ :8989 â†’ token â†’
`GET :9081/v2/kmailData/getKloudUsedData`) = **HTTP 200 for meera949, meera950, meera951, meera952 AND
the business accounts meera@m949s/m949m** (all "PROVISIONED"). **The earlier "401 UNAUTHORIZED USER" was
a PROBING ARTIFACT, NOT a real block:** reusing ONE deviceIdentity across several accounts made each
login overwrite the shared login-session row (KMail matches the token's deviceID claim against that
row), so only the currently-active account authorized and results flipped by order. Give each account
its OWN device and every one returns 200. **So there is NO KMail block and NO provisioning gap** â€” the
whole "KMail blocked on backend" saga is resolved (developers fixed the 9081â†”8989 JWT trust). **KMail
suite is RUNNABLE now.** Env: BOTH .env and kmail/.env use **meera949** as the shared QA_KPOST_ID
(same user in both modules, per the standing rule) + meera950 victim; meera951/meera952 are equivalent
spares. Suite is worker-scoped (default 4 workers) and logs in once per worker as the SAME user/device,
sharing one session via .auth/session.json (verified by tokenOpensKmail before reuse) â€” same-user
workers do NOT collide (unlike the cross-account hand-probe); only risk is a brief cold-start login
rate-limit ("Too many requests, retry in 6s"), harmless. Next: `npm run test:kmail`
(BUGZILLA_DRY_RUN=true), review report, then file. **When the dev fix
lands, re-verify in seconds:** login any account at 8989 â†’ present token to `GET :9081/v2/kmailData/getKloudUsedData`;
non-401 = fixed â†’ run `npm run test:kmail` (still BUGZILLA_DRY_RUN=true). KMail suite/accounts/payloads all ready.

`admin/.env` was NOT changed â€” that bench is a different backend
(:9595, self-minted HS256 JWT, companyID-scoped) and the user's new-IP note only covered KPost
(8989) and KMail (9081). Create scripts live in scratchpad (create-personal-949.cjs,
create-business-949.cjs, create-ml-final.cjs). See [[working-constraints]] [[excel-alignment-task]].
