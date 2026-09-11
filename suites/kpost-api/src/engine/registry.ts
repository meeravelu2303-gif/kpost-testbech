import fs from 'fs';
import path from 'path';
import type { EndpointDefinition, HttpMethod } from './types';

/**
 * The endpoint registry: one place that knows every endpoint the engine can drive.
 *
 * ## Where definitions come from
 *
 * Three sources, merged in increasing order of authority:
 *
 * 1. **The Excel contract** (`docs/excel/endpoints.json`) — 322 rows, 301 of them mandatory. This
 *    is the authoritative source for request payloads (root `CLAUDE.md`), so it seeds the path,
 *    the module and the documented body. Yellow rows are superseded endpoints and are excluded.
 * 2. **swagger.json** — fills in the HTTP method and, where present, the response shape. Swagger
 *    is authoritative for *paths*, not for bodies; where the two disagree the Excel wins.
 * 3. **Per-endpoint overrides** (`src/engine/definitions/`) — everything a contract cannot state:
 *    the authorization matrix, the performance tier, the database expectation, the reasoned skips.
 *
 * A definition with no override still gets the full pipeline; it simply runs with derived
 * defaults. That is the property that makes this scale to hundreds of endpoints — coverage is
 * opt-out, not opt-in.
 *
 * ## Why defaults are conservative
 *
 * `expectedStatuses` has no global default. A permissive list is how a bench stops noticing
 * regressions: if every endpoint accepts "any 2xx or 4xx", nothing can ever fail. An endpoint with
 * no declared statuses is reported as **unregistered** and excluded from the driver, which is
 * visible, rather than being silently waved through.
 */

const ROOT = path.resolve(__dirname, '..', '..');
const EXCEL_CONTRACT = path.join(ROOT, 'docs', 'excel', 'endpoints.json');

interface ExcelRow {
  tab: string;
  row: number;
  module?: string;
  path: string;
  request?: string;
  yellow?: boolean;
}

/** Normalises a path for comparison — templated segments and trailing slashes are noise. */
export const normalisePath = (p: string): string =>
  String(p)
    .replace(/\{[^}]*\}/g, '{}')
    .replace(/\/+$/, '')
    .replace(/\/{2,}/g, '/')
    .toLowerCase();

/** The Excel contract, as the engine sees it. */
export function loadContract(): ExcelRow[] {
  if (!fs.existsSync(EXCEL_CONTRACT)) return [];
  const rows = JSON.parse(fs.readFileSync(EXCEL_CONTRACT, 'utf8')) as ExcelRow[];
  return rows.filter((r) => !r.yellow && typeof r.path === 'string' && r.path.startsWith('/'));
}

/**
 * Field names the Excel row documents for an endpoint.
 *
 * Read out of the documented body rather than parsed as JSON — several cells mix prose into the
 * JSON (`"type": 1- Daily, 2 - Weekly`), which would fail a parse but still names a real field.
 */
export function documentedFields(request: string | undefined): string[] {
  if (!request) return [];
  return [...new Set([...request.matchAll(/"([A-Za-z_][A-Za-z0-9_]*)"\s*:/g)].map((m) => m[1]))];
}

const definitions = new Map<string, EndpointDefinition>();

/**
 * Registers an endpoint. Later registrations for the same id replace earlier ones, so a
 * definition file can refine a derived default without editing the derivation.
 */
export function defineEndpoint(definition: EndpointDefinition): EndpointDefinition {
  if (!definition.expectedStatuses.length) {
    throw new Error(
      `${definition.id}: expectedStatuses must not be empty. An endpoint that accepts anything can never fail, which is worse than one that is untested — untested is at least visible.`
    );
  }
  definitions.set(definition.id, definition);
  return definition;
}

/** Registers several at once; returns them for a spec to iterate. */
export function defineEndpoints(list: EndpointDefinition[]): EndpointDefinition[] {
  return list.map(defineEndpoint);
}

export function registeredEndpoints(): EndpointDefinition[] {
  return [...definitions.values()];
}

export function endpointById(id: string): EndpointDefinition | undefined {
  return definitions.get(id);
}

/**
 * Coverage of the Excel contract by the engine registry.
 *
 * Reported rather than enforced here — the gate that enforces it is `npm run audit:excel`, which
 * already holds payloads to the workbook. This exists so the engine's own progress is visible:
 * how many of the 301 mandatory endpoints have a definition yet.
 */
export function registryCoverage(): {
  mandatory: number;
  registered: number;
  percent: number;
  unregistered: Array<{ path: string; module?: string }>;
} {
  const contract = loadContract();
  const registeredPaths = new Set(registeredEndpoints().map((d) => normalisePath(d.path)));
  const unregistered = contract
    .filter((row) => !registeredPaths.has(normalisePath(row.path)))
    .map((row) => ({ path: row.path, module: row.module }));

  return {
    mandatory: contract.length,
    registered: contract.length - unregistered.length,
    percent: contract.length ? ((contract.length - unregistered.length) / contract.length) * 100 : 0,
    unregistered,
  };
}

/**
 * Builds a definition from the contract with derived defaults.
 *
 * The caller supplies only what the contract cannot know. Everything else — the documented fields,
 * the module, the default statuses for the verb — comes from the Excel row.
 */
export function fromContract(
  contractPath: string,
  method: HttpMethod,
  overrides: Partial<EndpointDefinition> & Pick<EndpointDefinition, 'expectedStatuses' | 'auth'>
): EndpointDefinition {
  const row = loadContract().find((r) => normalisePath(r.path) === normalisePath(contractPath));

  return defineEndpoint({
    id: overrides.id ?? `${method} ${contractPath}`,
    method,
    path: contractPath,
    module: overrides.module ?? row?.module,
    requiredFields: overrides.requiredFields ?? documentedFields(row?.request),
    ...overrides,
  });
}
