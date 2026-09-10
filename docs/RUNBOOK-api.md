# Running the API bench by hand

Step-by-step for a manual run of the KPost API benches. Everything below is run from the repo root
(`D:\TEST-BENCH-AUTOMATIONS\kpost-testbech`) unless a step says otherwise.

Read [`context/api-readiness-2026-09-10.md`](context/api-readiness-2026-09-10.md) first if you want
to know *why* the bench is in its current shape. Read
[`context/working-constraints.md`](context/working-constraints.md) for the rules that never change.

---

## 0. Before you start — the one thing that matters

`BUGZILLA_DRY_RUN=true` in `suites/kpost-api/.env`, `admin/.env` and `kmail/.env`. **Leave it
that way for your first run.** Defect ids are content-hashed from the finding's classification and
title, and the payload realignment changed those hashes — a live run would file a fresh set of
tickets duplicating what Bugzilla already holds. Dry run reports everything to the console and the
local report files and files nothing.

Turn it off only when the team has agreed to accept the re-filing.

```powershell
Select-String -Path suites/kpost-api/.env, suites/kpost-api/admin/.env, suites/kpost-api/kmail/.env -Pattern "BUGZILLA_DRY_RUN"
```

All three must read `BUGZILLA_DRY_RUN=true`.

---

## 1. Install (first time, or after a `git pull` that touched a package.json)

```powershell
npm install
```

One install at the root covers every suite — they are npm workspaces. The suites pin **different
major versions** of TypeScript and faker on purpose; do not try to align them.

---

## 2. Preflight — can we reach the environment and log in?

Do this before every session. It is 30 seconds and it tells you whether a later failure is the
product or the environment.

```powershell
cd suites/kpost-api
npx playwright test --config=scripts/auth-check/auth-check.config.ts --reporter=line
```

**Expect:** `2 passed`, and a banner naming the target host and both accounts with a token valid
for ~24h.

- `meera960@kpostindia.com` (PERSONAL)
- `meera@m960s.kpost.in` (BUSINESS_S)

**If this fails, stop.** Nothing downstream will be meaningful. The usual causes are the host having
moved (check `BASE_URL` in `suites/kpost-api/.env` — recent hosts are `192.168.0.66` and
`192.168.1.38`) or the developers having reset the database.

> The banner says `role: undefined ⚠ expected admin`. That is expected and not a failure — the
> KPost admin account is a business-tier user, not a role-bearing admin; the separate Admin module
> on `:9595` mints its own token.

---

## 3. The static gates — run these before any test

They take seconds, need no backend, and catch a whole class of problems before you spend twenty
minutes on a run.

```powershell
cd D:\TEST-BENCH-AUTOMATIONS\kpost-testbech
npm run typecheck        # all four suites
npm run audit:excel      # payloads match the Excel contract
npm run audit:vectors    # every endpoint carries the mandatory test vectors
node scripts/traceability.js
```

**Expect, as of 2026-09-10:**

| Command          | Expected                                          |
| ---------------- | ------------------------------------------------- |
| `typecheck`      | silent, exit 0                                     |
| `audit:excel`    | `CONFORMANCE : 100.00%` · `[excel] PASS`           |
| `audit:vectors`  | `2029/2029 (100.00%)` · `[vectors] PASS`           |
| `traceability`   | `traced to a tagged test : 56 (87.5%)`             |

`audit:excel` failing means a payload no longer matches the workbook — fix the payload, don't lower
the threshold. The 8 requirements traceability still reports untraced are 7 UI-layer (the UI phase)
plus BR-X01, which is blocked on mail-server credentials.

---

## 4. Run the tests

### Start small — one module, watch it work

```powershell
cd D:\TEST-BENCH-AUTOMATIONS\kpost-testbech\suites\kpost-api
npx playwright test tests/crossModule --reporter=line   # 27 tests, ~3s, all should pass
npx playwright test --project=auth --reporter=line      # ~250 tests, ~1 min
```

`crossModule` is the best first run: it is fast, and if it passes you know auth, the fixtures and
the reporting chain are all working.

### The full API suite

```powershell
cd D:\TEST-BENCH-AUTOMATIONS\kpost-testbech
npm run test:api        # ~4,690 tests
npm run test:kmail      # ~929
npm run test:admin      # ~1,563  ⚠ see the warning below
```

> **`test:admin` points at the live admin module** (`192.168.0.66:9595`) which holds **real company
> HR data**. Read `suites/kpost-api/admin/CLAUDE.md` before running it.

Useful flags: `--reporter=line` (compact), `--project=<name>` (one module — the project names are
the directories under `tests/`), `--grep "FR-K05"` (one requirement), `--workers=2` (gentler on the
backend), `--headed` is meaningless here (no browser).

---

## 5. Reading the results

Generated per run, all gitignored: `BUG_REPORT.md` / `.json`, `DEV_DIGEST.md` / `.json`, and an
HTML report (`npm run report -w kpost-api`).

**A failing test is not automatically a bug in the product, and it is not automatically a bug in the
bench.** Work in this order:

1. **Group failures into faults.** Twenty failures on `getActiveSession` are one 409, not twenty
   defects. The digest already groups them; sanity-check the grouping.
2. **Reproduce the interesting ones by hand** with the `repro` line the report prints, against a
   valid token, before telling anyone. Several "failures" in this bench's history were the bench's
   own payload being wrong.
3. **Check it against the known list** in `context/api-readiness-2026-09-10.md` §"Live findings" and
   the root `CLAUDE.md` §"Known backend blockers" before filing anything.

### Failures you should expect right now (do not re-file these)

These are confirmed product faults on `192.168.0.66`, already characterised:

| Where                                                | What                                                  |
| ---------------------------------------------------- | ----------------------------------------------------- |
| Katchup `[NFR-SEC02]` confidential copy               | **Critical** — leaks the confidential recipient        |
| `getLoginHistory`, `getActiveSession`                | 409 to everyone, token or not (~12 tests)              |
| `userLogoutFromAllDevices`                           | 500 with a valid token (~6 tests)                      |
| `fetchUserDetails` / `fetchPersonalUserDetails`      | 500 on an unknown kpostID (2 tests)                    |
| `contacts/globalSearch`                              | no rate limiting                                       |
| KMail `postMail`                                     | 500 — QA accounts have no mail-server credentials      |
| KMail draft/settings/PDF routes                      | assorted 500s and missing validation                   |
| kdiary `updateEvent` / `editScheduleEvent`           | 500 on a non-existent event id                         |

**The mock OTP `123456` / `000000` is an intentional dev bypass.** Tests accept it. It is never a
bug. Only a genuinely un-issued *non-mock* OTP being accepted would be.

---

## 6. When you are ready to file

Set `BUGZILLA_DRY_RUN=false` in the suite you are filing for, re-run that suite, and check the
ticket count the reporter announces before walking away. One ticket per fault — if the count looks
like the failure count, something is wrong with the grouping.

Also outstanding for a human: existing Bugzilla tickets against `/generalSetting/changeTheme` should
be resolved **INVALID**; their content-hash ids no longer match anything the suite emits.
