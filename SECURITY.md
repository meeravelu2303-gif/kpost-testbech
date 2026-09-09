# Security

This is an internal, proprietary QA repository that **targets and probes internal KPost
systems** (auth, KMail, Admin). Treat it accordingly.

## Secrets — never commit them

- Every credential (KPost accounts, Bugzilla API key, database password, dashboard key) lives
  **only** in each suite's gitignored `.env` file. The checked-in `.env.example` is the template.
- `.env` is ignored at the repo root (`.gitignore`) — verify with `git check-ignore <path>/.env`
  before your first commit.
- **Do not** put credentials in committed files — including `docs/`, READMEs, code comments, or
  test fixtures. The account notes under `docs/context/` name accounts by id only; the password
  is referenced as `<QA_PASSWORD — see the suite .env>`.
- If a secret is ever committed, **rotate it** (it is compromised the moment it lands in git
  history) and scrub the history.

## Safe testing

- Run only against environments and accounts you are authorised to test. The target host is set
  per suite via `.env` (`BASE_URL` / `KMAIL_BASE_URL` / `KPOST_AUTH_BASE_URL`).
- The suites are adversarial (they inject payloads and probe auth). Never point them at
  production or at systems outside the authorised test scope.
- Destructive operations are constrained on purpose (refusal-path only, disposable identities,
  no real OTP). Do not relax those guards — see each suite's `CLAUDE.md`.

## Reporting

Report a security concern in this automation to the KPost QA lead. Confirmed **product**
defects the suites find are filed to Bugzilla per suite; this file is about the security of the
automation itself.
