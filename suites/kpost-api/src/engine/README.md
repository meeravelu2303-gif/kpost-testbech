# API validation engine

Centralized validation. An endpoint is **declared**; the pipeline runs every check against the
declaration. No endpoint test re-implements auth, status, schema, header, error, performance,
injection or database logic.

```
src/
├── engine/                     the framework — you rarely touch this
│   ├── index.ts                apiEngine, public exports
│   ├── pipeline.ts             stage order + orchestration
│   ├── registry.ts             endpoint registry, Excel-contract merge, coverage
│   ├── types.ts                EndpointDefinition, Validator, results
│   └── validators/
│       ├── index.ts            ← ADD A NEW VALIDATION HERE (applies to every endpoint)
│       ├── authentication.ts   8 credential shapes; public routes asserted reachable
│       ├── authorization.ts    role matrix; ALLOW and DENY both asserted
│       ├── request.ts          omitted / null / empty / wrong-type / oversized per field
│       ├── execution.ts        the one well-formed request later stages read
│       ├── response.ts         status · structure · schema · content-type · headers
│       ├── errorContract.ts    error shape + no internals leaked
│       ├── performance.ts      latency vs declared budget
│       ├── security.ts         XSS · SQLi · path traversal · NoSQL
│       └── database.ts         MySQL row/audit/soft-delete verification
└── endpoints/                  ← ADD A NEW ENDPOINT HERE (gets every validation)
    ├── index.ts
    └── katchup.ts
```

## Adding an endpoint

Declare it. That is the whole task.

```ts
{
  id: 'katchup.sendMessage',
  method: 'POST',
  path: '/v2/katchup/sendMessage',
  auth: 'secured',
  expectedStatuses: [200, 400],
  buildRequest: () => buildKatchupMessagePayload({ receiver: FOREIGN.victimKpostID }),
  responseSchema: katchupMessageResponseSchema,
  requiredFields: ['subject', 'receiver'],
  performance: 'write',
  authorization: { USER: 'ALLOW', UNAUTHENTICATED: 'DENY' },
  skip: { businessRules: 'covered by tests/katchupV2/businessRules.spec.ts' },
}
```

## Adding a validation

Write the validator, register it in `validators/index.ts`. It now runs against every declared
endpoint. No endpoint file changes.

## Rules that keep it honest

- **`expectedStatuses` has no default.** `defineEndpoint` throws on an empty list — an endpoint
  that accepts anything can never fail.
- **Every skip needs a reason**, enforced by the type, and appears in the report.
- **Validators delegate to `src/utils/apiAssertions.ts`**, which owns throttle tolerance,
  token-derived-field exemptions, severity grading and the ledger dedupe that collapses many
  failing stages into one ticket per fault.
- **A missing role token reports "matrix partially unexercised"** — never a silent pass.
- **Assertion failures are not bench faults.** The helpers throw by design on a finding; the
  pipeline separates an `expect` failure from a validator exception via `matcherResult`.

## Out of scope, deliberately

- **Business rules** stay in `tests/` — "a Confidential Copy recipient must stay hidden" is not
  derivable from a contract. The `businessRules` stage reports an explicit skip naming the spec.
- **Load testing** — `performance` is a single-request guard. Use k6/JMeter for throughput.

## Database

MySQL/MariaDB (`kpostaurora`), not PostgreSQL. SELECT only, via the `mysql` client. Configure with
`KPOST_DB_HOST`, `KPOST_DB_NAME`, `KPOST_DB_USER`, `KPOST_DB_PASSWORD`, `KPOST_DB_PORT`; absent
values disable the stage. An unreachable database reports *unverified*, never a defect.

## Running

```
npx playwright test --project=engine
```

The registry line reports how much of the 301-endpoint Excel contract is declared. The engine runs
alongside the 58 module specs — it does not replace them.
