---
name: working-constraints
description: Standing user constraints for how to work in this KPost test-bench repo
metadata: 
  node_type: memory
  type: feedback
  originSessionId: b67c8dde-d115-46a2-b4d6-3797ba8e08c1
  modified: 2026-09-08T12:16:39.747Z
---

Meera's standing rules for this repo (stated repeatedly across the project):

- **Do NOT commit and do NOT push.** The user commits and pushes manually. Just make the changes.
- **Do NOT test with real OTP.** OTP builders stay pinned to `TEST_MOBILE`/`TEST_EMAIL`, never faker.
- **The Excel is authoritative for payloads**, not swagger. When they disagree, match the Excel.
- **No concern-files** — merge `businessRules.spec`/`publicRouteAccess.spec` style files into the
  per-endpoint describe blocks. Spec files are domain-grouped with valid names, bare `METHOD /path` describes.
- **Never aim destructive calls at the shared session** — use synthetic/non-existent identities
  (`nonExistentKpostId()`, `revocableToken`, `disposableToken`, `FOREIGN.victimKpostID`).
- Work through modules **one by one, line by line, without asking permission**; if context runs out,
  checkpoint to memory and resume.
- Production-grade quality bar = how common/auth were done: Excel-exact payloads, per-endpoint token
  handling, false-finding prevention, clean structure, `npm run typecheck` clean.
- **Record EVERY code change in memory** — the user relies on the memory files to understand what was
  changed without re-reading the diff. After any edit, capture what/why in the relevant memory file
  (module status in [[excel-alignment-task]], accounts in [[qa-accounts-949]], etc.). Keep it readable.
- **Comment style: "trim verbose, keep safety"** — concise 1–2 line doc comments; keep safety facts,
  Excel/API-behaviour facts, and non-obvious "why"; drop narrative prose.
- **OTP bypass is INTENTIONAL (dev-added for this bench): `123456` (+ `000000` fallback) always
  validate.** Tests MUST accept it — never file it as a bug, never fail on it. OTP-rejection tests must
  EXCLUDE the mock values (`MOCK_OTP_CANDIDATES` in env.config) and only assert/ file on a genuinely
  un-issued NON-mock OTP being accepted (a real validation break). The signup happy-path uses
  `env.mockOtp` (123456) deliberately. Fixed in verificationAndRecovery.spec (validateOTP/validateMailOTP/
  forgotPasswordUpdate/wrong-target ×2) + userProfile.spec (deactivateAccount).

**Why:** the backend is live/stateful and this bench files real Bugzilla tickets, so a wrong payload
or a destructive call has real consequences. **How to apply:** before editing a builder, pull its
Excel row; after changing a builder's fields, grep the tests for the old field names and re-point fuzz.

See [[excel-alignment-task]], [[bugzilla-tracker-state]].
