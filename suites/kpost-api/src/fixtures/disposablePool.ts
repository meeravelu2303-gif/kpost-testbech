import fs from 'fs';
import path from 'path';

/**
 * Hands out pre-created throwaway accounts to the destructive-path tests.
 *
 * `freshUser()` mints an account over REST and cannot on this environment: signup requires a
 * verified OTP, the OTP is random and reaches only SMS and the database, so an HTTP client can
 * never complete `validateOTP`. `disposableToken` was therefore always null and roughly 13
 * tests skipped — the ones covering account deactivation and credential change.
 *
 * `npm run seed:disposable` creates a pool out-of-band (it may read the OTP from the database;
 * the bench itself still may not) and this module lends from it. Read-mostly and deliberately
 * dependency-free so it can be imported by a worker fixture without pulling anything in.
 *
 * When the pool is empty every caller gets `null` and the tests skip exactly as before — the
 * degradation is back to the previous behaviour, never to something worse.
 */

const POOL_FILE = path.resolve(__dirname, '..', '..', '.auth', 'disposable-pool.json');

export interface DisposableAccount {
  kpostID: string;
  password: string;
  mobileNumber: string;
  createdAt: string;
  /** Set when a run has taken this account; never handed out twice. */
  consumedAt?: string;
}

interface Pool {
  accounts: DisposableAccount[];
}

function read(): Pool {
  try {
    const parsed = JSON.parse(fs.readFileSync(POOL_FILE, 'utf-8')) as Pool;
    return Array.isArray(parsed.accounts) ? parsed : { accounts: [] };
  } catch {
    // Absent, unreadable, or corrupt: an empty pool, which degrades to the old skip behaviour.
    return { accounts: [] };
  }
}

/**
 * Takes one unused account and marks it consumed.
 *
 * ## Why the claim is written immediately, and with `wx`
 *
 * Playwright workers are separate processes. Two of them reaching a `deactivateAccount` block at
 * the same moment would otherwise be handed the same account, and the second test would assert
 * against an identity the first had already destroyed — a failure that looks like a product
 * defect and is not. Each account is claimed by atomically creating a marker file, the same
 * `wx` trick `bugTracker` uses for cross-worker dedup: the create either succeeds for exactly
 * one worker or fails for the rest, with no read-modify-write in between.
 *
 * An account is consumed on hand-out rather than on use, deliberately. Some of these tests
 * destroy the account they are given, and nothing can tell afterwards whether one survived, so
 * spending it up front is the only safe accounting.
 */
export function claimDisposableAccount(): DisposableAccount | null {
  const pool = read();
  const claimDir = path.join(path.dirname(POOL_FILE), 'disposable-claims');

  try {
    fs.mkdirSync(claimDir, { recursive: true });
  } catch {
    return null;
  }

  for (const account of pool.accounts) {
    if (account.consumedAt) continue;
    const marker = path.join(claimDir, `${account.kpostID.replace(/[^a-z0-9]/gi, '_')}.claim`);
    try {
      fs.writeFileSync(marker, new Date().toISOString(), { flag: 'wx' });
      return account;
    } catch {
      // Another worker already claimed it; try the next.
      continue;
    }
  }
  return null;
}

/** Unclaimed accounts left in the pool — for the preflight banner and `--status`. */
export function disposablePoolSize(): number {
  const claimDir = path.join(path.dirname(POOL_FILE), 'disposable-claims');
  let claimed = new Set<string>();
  try {
    claimed = new Set(fs.readdirSync(claimDir));
  } catch {
    /* no claims yet */
  }
  return read().accounts.filter(
    (a) => !a.consumedAt && !claimed.has(`${a.kpostID.replace(/[^a-z0-9]/gi, '_')}.claim`)
  ).length;
}

/**
 * Clears the per-run claim markers.
 *
 * Called from `globalSetup` so a claim never outlives the run that made it. Without this the
 * pool would appear exhausted on the second run even though its accounts were untouched — the
 * markers say "in use by a worker", not "spent", and no worker survives the run.
 *
 * Accounts genuinely destroyed by a test are a separate matter: they keep failing to log in and
 * are skipped, and `npm run seed:disposable` tops the pool back up.
 */
export function resetDisposableClaims(): void {
  try {
    fs.rmSync(path.join(path.dirname(POOL_FILE), 'disposable-claims'), { recursive: true, force: true });
  } catch {
    /* nothing to clear */
  }
}
