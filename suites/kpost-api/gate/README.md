# The gate suite

Behaviour that has been **agreed** and must never regress.

Every spec under `tests/` is `@audit`: it surveys a live system whose behaviour is still being
settled. Tolerant assertions (`toBeLessThan(500)`), broad status sets and acquire-or-skip guards
are the *correct* choice there — the job is to observe and report, not to block a build.

The gate is the opposite contract:

| | `@audit` (`tests/`) | `@gate` (`gate/`) |
| --- | --- | --- |
| Question | "what does it do?" | "does it still do the agreed thing?" |
| Status assertion | a set of plausible outcomes | exactly one |
| `test.skip(` | correct — acquire-or-skip | forbidden |
| `toBeLessThan(500)` | correct — survey tolerance | forbidden |
| Requirement id | encouraged | **required** |
| Retries | as configured | `0` |
| On failure | a report entry | a red build |

`npm run audit:gate` enforces the four rules offline, with no run and no network, and sits in CI
beside `audit:excel` and `audit:vectors`. It judges **only** `@gate` tests — reporting the
tolerance in `@audit` tests would be noise, because there the tolerance is right.

## Why the split exists

Tolerance spreads. When a test goes red the cheapest repair is to widen what it accepts, so the
survey style leaks into the regression suite and the suite quietly loses the ability to fail. The
measured drift on this bench: 754 `toBeLessThan(500)`, 472 status sets accepting both a 2xx and a
4xx, 478 `test.skip(`. None of those are wrong in an audit sweep. All of them are fatal in a gate.

## Adding a gate test

A finding qualifies once it is **confirmed against the live API** and the expected behaviour is
agreed. Assert the correct behaviour, not the current one — so it is red until the fix lands and
green forever after. Tag it with its requirement id; `npm run trace` then reports it.

A test that cannot always run does not belong here. Move it to `tests/` and let the audit sweep
report it.
