# KPost Test Bench

Production-grade **monorepo** for the KPost platform's test automation. It houses every test
bench for the product in one place, so the tooling, conventions, reporting and defect tracking
that they share have a single home instead of drifting across separate repositories.

## What's here

```
kpost-testbench/
├─ package.json              npm workspaces root — delegates to each suite
├─ suites/
│  ├─ kpost-api/             KPost API bench (Playwright + TS, adversarial API testing)
│  │  ├─ kmail/              KMail API bench   (sister suite, own config + Bugzilla product)
│  │  └─ admin/              KPost Admin bench (sister suite, own config + Bugzilla product)
│  └─ kpost-ui/             KPost UI bench   (Playwright + TS, cross-browser + accessibility)
├─ packages/                shared internal packages (see "Roadmap")
└─ docs/                     cross-suite documentation
```

Each **suite** is an independent Playwright project with its own `playwright.config.ts`,
its own source/test tree, and its own Bugzilla product — because API and UI testing are
genuinely different disciplines (a Playwright *project* means a Swagger tag in the API bench
and a *browser* in the UI bench, and their auth artifacts are not interchangeable). The
monorepo co-locates them so they can share plumbing without duplicating it.

## The test pyramid — read this before adding tests

The bulk of coverage lives at the **API layer** (fast, stable, cheap): contracts, payloads,
security, business rules, edge cases. The **UI layer is deliberately thin** — it covers only
what the browser can prove that the API cannot: rendering, navigation, forms, client-side
session behaviour, accessibility and cross-browser crashes. **Do not re-test API business
logic through the UI.** Roughly ~4,600 API cases sit under ~80 UI cases, and that ratio is
correct.

## Install

One install at the root sets up every suite (npm workspaces hoists shared dependencies):

```bash
npm install
```

> The suites currently pin **different major versions** of some dev-dependencies (the API
> bench requires TypeScript 7 + faker 10 ESM per its own `CLAUDE.md`; the UI bench uses
> TypeScript 5.7 + faker 9). npm workspaces install both — aligning them is a Roadmap item,
> not a blocker.

## Run

From the repo root:

| Command | Runs |
| --- | --- |
| `npm run test:api` | the KPost API suite (~4,600 cases) |
| `npm run test:kmail` | the KMail API sister suite |
| `npm run test:admin` | the KPost Admin sister suite |
| `npm run test:ui` | the KPost UI suite (cross-browser) |
| `npm run typecheck` | type-check every suite |
| `npm run typecheck:api` / `:kmail` / `:admin` / `:ui` | one suite |

Each suite can also be run from its own directory exactly as before
(`cd suites/kpost-api && npm test`). Per-suite conventions, safety rules and known API
behaviours live in each suite's own `CLAUDE.md` and `OPERATIONS.md` — **read them before
editing that suite.**

## Configuration

Every suite reads its own gitignored `.env` (template in each suite's `.env.example`).
Credentials live in `.env`; tokens are minted and cached per run and never committed.

## Reporting & defect tracking

Every suite produces the same artifact family — `BUG_REPORT.md`/`.json`, `DEV_DIGEST.md`/`.json`
— and files one ticket per fault into its own Bugzilla product (`KPost API`, `KMail API`,
`KPost Admin`, `KPost UI`) on the shared instance, and pushes to the shared QA Dashboard under
its own application slug. These are generated per run and are gitignored.

## Roadmap (Phase 2 — shared-package extraction)

The migration into this monorepo is **Phase 1**: every suite is co-located, cleaned of
generated artifacts, and runs unchanged. **Phase 2** removes the remaining duplication:

1. **`packages/reporting`** — extract the run-model → `BUG_REPORT`/`DEV_DIGEST` → Bugzilla →
   dashboard pipeline (the API and UI benches each re-implement it "to the same schema";
   ~2,800 LOC of parallel maintenance). Both suites consume one package; the Bugzilla product
   and dashboard slug stay per-suite config.
2. **`packages/config`** — one typed env loader shared by all suites.
3. **Dependency alignment** — converge the shared dev-dependencies (Playwright, faker,
   TypeScript, `@types/node`) onto single versions where each suite allows it.
4. **UI capability gaps** — visual-regression baselines, and a pool of test accounts so the
   UI suite can parallelize safely (KPost allows one active session per account).

Auth and API payloads are **not** shared: the UI bench needs a full browser `storageState`
(plus an encrypted redux-persist blob) while the API bench needs a bearer token, and the UI
bench correctly does not re-declare the API's Excel-aligned payloads.
