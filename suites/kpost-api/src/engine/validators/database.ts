import { execFileSync } from 'child_process';
import { env } from '../../config/env.config';
import type { DatabaseExpectation, Validator } from '../types';

/**
 * Post-write verification against MySQL/MariaDB (`kpostaurora`) — not PostgreSQL.
 *
 * SELECT only, shelling out to the `mysql` client rather than taking a driver dependency, so the
 * one place the bench reaches past the API stays visible and cannot spread into `src/api/`.
 * Skips when the database is unreachable: that is "unverified", never a defect against the API.
 *
 * Proves what a response cannot — that the write landed. An API can answer 200 with an id and
 * persist nothing.
 */

interface DbConfig {
  client: string;
  host: string;
  port: string;
  user: string;
  password: string;
  database: string;
}

/** Reads DB connection details from the environment. Absent values disable the stage. */
function dbConfig(): DbConfig | null {
  const host = process.env.KPOST_DB_HOST;
  const database = process.env.KPOST_DB_NAME;
  const user = process.env.KPOST_DB_USER;
  const password = process.env.KPOST_DB_PASSWORD;
  if (!host || !database || !user) return null;
  return {
    client: process.env.KPOST_DB_CLIENT || 'mysql',
    host,
    port: process.env.KPOST_DB_PORT || '3306',
    user,
    password: password ?? '',
    database,
  };
}

/**
 * Runs one SELECT and returns the rows as objects.
 *
 * Values are passed as bound-looking literals through `--execute`, which is why
 * `assertRowMatches` escapes them: the `mysql` CLI has no parameter binding, and a test-supplied
 * value reaching a query unescaped is the same defect class this bench reports in the product.
 */
function query(config: DbConfig, sql: string): Array<Record<string, string>> {
  const output = execFileSync(
    config.client,
    [
      `-h${config.host}`,
      `-P${config.port}`,
      `-u${config.user}`,
      ...(config.password ? [`-p${config.password}`] : []),
      config.database,
      '--batch',
      '--raw',
      '--execute',
      sql,
    ],
    { encoding: 'utf8', timeout: 15_000, stdio: ['ignore', 'pipe', 'pipe'] }
  );

  const lines = output.trim().split('\n').filter(Boolean);
  if (lines.length < 2) return [];
  const columns = lines[0].split('\t');
  return lines.slice(1).map((line) => {
    const cells = line.split('\t');
    return Object.fromEntries(columns.map((c, i) => [c, cells[i]]));
  });
}

/** MySQL string literal escaping. Only ever applied to values, never to identifiers. */
const literal = (value: unknown): string =>
  `'${String(value).replace(/\\/g, '\\\\').replace(/'/g, "\\'")}'`;

/** Identifiers are validated rather than escaped — a table name is not user input. */
const identifier = (name: string): string => {
  if (!/^[A-Za-z0-9_]+$/.test(name)) {
    throw new Error(`refusing to interpolate "${name}" as a SQL identifier`);
  }
  return `\`${name}\``;
};

export const databaseValidator: Validator = {
  stage: 'database',

  appliesTo: (endpoint) => Boolean(endpoint.database),

  async run({ endpoint, response, responseBody }) {
    const expectation = endpoint.database as DatabaseExpectation;
    const config = dbConfig();

    if (!config) {
      return {
        outcome: 'skipped',
        detail:
          'database connection not configured (KPOST_DB_HOST / KPOST_DB_NAME / KPOST_DB_USER) — the write is unverified, not proven absent',
      };
    }
    if (!response || response.status() >= 400) {
      return {
        outcome: 'skipped',
        detail: `the write was not accepted (HTTP ${response?.status() ?? 'none'}), so there is no row to assert`,
      };
    }

    const where = Object.entries(expectation.match)
      .map(([column, derive]) => `${identifier(column)} = ${literal(derive(responseBody?.json))}`)
      .join(' AND ');

    const columns = [
      ...Object.keys(expectation.match),
      ...(expectation.auditColumns ?? []),
      ...(expectation.softDeleteColumn ? [expectation.softDeleteColumn] : []),
    ].map(identifier);

    let rows: Array<Record<string, string>>;
    try {
      rows = query(
        config,
        `SELECT ${columns.join(', ')} FROM ${identifier(expectation.table)} WHERE ${where} LIMIT 5;`
      );
    } catch (error) {
      /*
       * An unreachable database is an environment problem, never an API defect. Reporting it as a
       * failure would file a bug against the endpoint for something the endpoint did correctly.
       */
      return {
        outcome: 'skipped',
        detail: `database unreachable, so the write is unverified: ${(error as Error).message.split('\n')[0]}`,
      };
    }

    const expectedRows = expectation.expectedRows ?? 1;
    if (rows.length !== expectedRows) {
      return {
        outcome: 'failed',
        detail: `the API reported success but ${expectation.table} holds ${rows.length} matching row(s), expected ${expectedRows}. The response is the API's claim; the row is the evidence.`,
      };
    }

    const row = rows[0];

    const emptyAudit = (expectation.auditColumns ?? []).filter(
      (column) => row[column] === undefined || row[column] === '' || row[column] === 'NULL'
    );
    if (emptyAudit.length) {
      return {
        outcome: 'failed',
        detail: `row persisted but audit column(s) ${emptyAudit.join(', ')} are empty — the record cannot be attributed or aged`,
      };
    }

    if (expectation.softDeleteColumn) {
      const flag = row[expectation.softDeleteColumn];
      if (flag === '0' || flag === 'NULL' || flag === '') {
        return {
          outcome: 'failed',
          detail: `${expectation.softDeleteColumn} is "${flag}" — the delete was reported as successful but the row is not marked deleted`,
        };
      }
    }

    return { outcome: 'passed', detail: `verified in ${expectation.table} (${rows.length} row)` };
  },
};

/** Exposed so a spec can state the DB target in its own diagnostics. */
export const databaseTarget = (): string => {
  const config = dbConfig();
  return config ? `${config.database}@${config.host}:${config.port} (MySQL)` : 'not configured';
};

/** Kept for symmetry with the rest of the engine's config surface. */
export const databaseConfigured = (): boolean => dbConfig() !== null;

void env;
