import type { Credentials } from '../config/env';
import { env } from '../config/env';

/**
 * A pool of QA accounts, checked out one per Playwright worker.
 *
 * ## The constraint this exists for
 *
 * KPost allows **one active session per account**. Every spec in this suite currently starts
 * from one shared `storageState` minted for `STANDARD_USER_EMAIL` in global setup, so two
 * workers that both authenticate on that account overwrite each other's login-session row and
 * the loser is silently signed out — reported several layers from the cause. That is why
 * `playwright.config.ts` pins `workers: 1`.
 *
 * A pool lifts that cap without lifting the constraint: give each worker its **own** account
 * and the sessions never collide. Playwright guarantees `TEST_PARALLEL_INDEX` is stable and
 * unique for the lifetime of a worker, which is exactly the checkout key this needs — no lock
 * file, no coordination, no cleanup on crash.
 *
 * ## Configuring it
 *
 * ```
 * POOL_USER_EMAILS=qa1@kpostindia.com,qa2@kpostindia.com,qa3@kpostindia.com
 * POOL_USER_PASSWORD=<shared password>
 * TEST_WORKERS=3          # never more than the pool size
 * ```
 *
 * Unset the emails and this falls back to the standard user, which is correct for a
 * single-worker run and keeps the suite working with no configuration.
 *
 * ## Provisioning the accounts
 *
 * Blocked at the time of writing: creating fresh accounts needs a host where signup works
 * (`docs/context/qa-accounts-949.md` records the DB-schema breakage that stops it). Until then
 * the pool is one account deep and the worker cap stands.
 */

function parsePool(): Credentials[] {
  const emails = (process.env.POOL_USER_EMAILS ?? '')
    .split(',')
    .map((value) => value.trim())
    .filter(Boolean);
  const password = process.env.POOL_USER_PASSWORD ?? '';

  // A pool with no shared password is a misconfiguration, not an empty pool — say so rather
  // than silently running every worker as the standard user and colliding anyway.
  if (emails.length > 0 && !password) {
    throw new Error(
      'POOL_USER_EMAILS is set but POOL_USER_PASSWORD is not. Set both, or neither.'
    );
  }
  return emails.map((email) => ({ email, password }));
}

const POOL: Credentials[] = parsePool();

/** How many distinct accounts are available. 1 means "no pool configured". */
export function poolSize(): number {
  return POOL.length || 1;
}

/**
 * The account this worker owns.
 *
 * Keyed on `TEST_PARALLEL_INDEX` (0-based, one per worker) rather than a counter, so a worker
 * that restarts after a crash reclaims the same account instead of leaking one.
 */
export function accountForWorker(workerIndex = Number(process.env.TEST_PARALLEL_INDEX ?? 0)): Credentials {
  if (POOL.length === 0) return env.users.standard;

  // Wrapping rather than throwing keeps a misconfigured TEST_WORKERS from failing the whole
  // run — but two workers on one account is the exact collision this module prevents, so it
  // is loud about it.
  if (workerIndex >= POOL.length) {
    throw new Error(
      `Worker ${workerIndex} has no account: the pool holds ${POOL.length}. ` +
        `Set TEST_WORKERS to at most ${POOL.length}, or add more accounts to POOL_USER_EMAILS.`
    );
  }
  return POOL[workerIndex]!;
}

/** Where this worker's session is cached, so pooled workers never share a storageState file. */
export function storageStateForWorker(
  workerIndex = Number(process.env.TEST_PARALLEL_INDEX ?? 0)
): string {
  return POOL.length === 0
    ? '.auth/standard.json'
    : `.auth/pool-${workerIndex}.json`;
}
