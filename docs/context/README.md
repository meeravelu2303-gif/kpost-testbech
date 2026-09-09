# Context & history — the "why" behind this test bench

This folder is the **accumulated operational knowledge** of the KPost test-bench automation,
carried over from the working sessions that built it. It is the memory a fresh Claude Code
session (or a new engineer) would otherwise not have. Read the root `CLAUDE.md` first; come
here for the detail behind any decision.

These are working notes, not polished docs — they record what was done, why, and what was
non-obvious. Where a note names a file, flag or account, **verify it still exists** before
relying on it: the environment moves (hosts change, developers reset databases).

| File | What it holds |
| --- | --- |
| [working-constraints.md](working-constraints.md) | **Read this first.** The standing rules: no commit/push, no real OTP (mock `123456` is the intentional dev bypass), Excel is authoritative for payloads, never aim destructive calls at the shared session, comment style, record every change. |
| [qa-accounts-949.md](qa-accounts-949.md) | The `meera949/950/951` + business `m949s/m/l` QA accounts, per-tier member caps, hosts, the KMail token-trust fix, and the mail-provisioning blocker. |
| [kmail-alignment.md](kmail-alignment.md) | The full KMail record: payload↔Excel alignment, the 5-agent coverage audit, the `postMail` 500 root cause (missing mail-server credentials), and the payload realignment. |
| [excel-alignment-task.md](excel-alignment-task.md) | The KPost API payload↔Excel alignment work. |
| [excel-dumps-location.md](excel-dumps-location.md) | Where the Excel workbook tab-dumps live and which tab maps to which module. |
| [bugzilla-tracker-state.md](bugzilla-tracker-state.md) | The Bugzilla tracker state (valid/open bug counts, dedup safety). |
| [suite-audit-findings.md](suite-audit-findings.md) | Findings from a full-suite audit (desync fixes, phantom-field fixes, safety). |
| [monorepo-migration.md](monorepo-migration.md) | How this monorepo was assembled (Phase 1) and the Phase 2 roadmap. |

## The reference points we build against

- **The Excel workbooks are the authoritative source for request payloads** — not swagger.
  Swagger (`swagger.json`, `kmail.swagger.json`, `adminmodule.swagger.json`) gives paths and
  *documented* behaviour, which frequently diverges from actual behaviour. When they disagree,
  **match the Excel.** See `excel-dumps-location.md` for where the dumps are.
- **The QA Dashboard** (external) holds trends across every run and bench.
- **Bugzilla** (shared instance) holds one ticket per fault, per-suite product.
