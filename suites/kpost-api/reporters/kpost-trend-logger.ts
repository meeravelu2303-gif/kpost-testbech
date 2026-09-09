import fs from 'fs';
import path from 'path';
import type { RunModel } from './run-model';

/**
 * TIER 3 — Historical trend logger.
 *
 * Appends one data point per run to `reports/kpost-trend-history.json` so quality dashboards
 * can chart pass rate, duration and failure churn across builds. The file is a plain JSON
 * array, which any spreadsheet, Grafana JSON datasource or notebook can read without a schema.
 */

export interface TrendDataPoint {
  runId: string;
  timestamp: string;
  totalTests: number;
  passCount: number;
  failCount: number;
  passRatePercentage: number;
  totalDurationMs: number;
  /** Stable identifiers of the tests that failed, so churn between builds is computable. */
  failedTestKeys: string[];

  /* ------------------------------------------------------------ schema v2
   * Every field below is optional, and readers must treat it as such: this file is
   * append-only and the points written before grouping existed will never have them. Nothing
   * here rewrites history — a chart spanning the change simply starts its defect series at the
   * first v2 point.
   */

  /** `2` once grouping and the category axis landed. Absent means v1. */
  schemaVersion?: number;
  /**
   * Distinct defects — the grouped figure.
   *
   * Not comparable to a pre-v2 point's defect count, which counted one entry per failing test.
   * The two series differ by roughly an order of magnitude on this API, so a dashboard that
   * plots them on one line without checking `schemaVersion` will draw a cliff that never
   * happened.
   */
  defectCount?: number;
  /** Observations before grouping, so the collapse ratio is visible in the trend. */
  defectOccurrences?: number;
  /** Distinct endpoints touched by at least one defect. */
  affectedEndpointCount?: number;
  bySeverity?: Record<string, number>;
  byCategory?: Record<string, number>;
}

/** Newest-run-last, capped so the file stays readable after months of nightly builds. */
const MAX_POINTS = 500;

/**
 * A run identifier that is stable within a build and unique across builds. CI build numbers
 * are preferred because they let a trend point be traced back to the pipeline that produced
 * it; a timestamp is the fallback for local runs.
 */
function resolveRunId(model: RunModel): string {
  const ci =
    process.env.BUILD_ID ??
    process.env.BUILD_NUMBER ??
    process.env.GITHUB_RUN_ID ??
    process.env.CI_PIPELINE_ID;
  const stamp = model.generatedAt.replace(/[-:]/g, '').replace(/\.\d+Z$/, 'Z');
  return ci ? `KPOST-${ci}` : `KPOST-${stamp}`;
}

/**
 * A test's identity across runs. The Playwright test id is derived from file position, so it
 * shifts when a spec is edited above the test; project + suite + title survives that.
 */
export function testKey(test: { project: string; describe: string; title: string }): string {
  return [test.project, test.describe, test.title].filter(Boolean).join(' › ');
}

function readHistory(historyPath: string): TrendDataPoint[] {
  try {
    const parsed: unknown = JSON.parse(fs.readFileSync(historyPath, 'utf-8'));
    return Array.isArray(parsed) ? (parsed as TrendDataPoint[]) : [];
  } catch {
    // Absent on the first run, and a corrupt file must not abort the run — a truncated
    // history is recoverable, a failed test suite report is not.
    return [];
  }
}

function tallyBy(model: RunModel, key: (d: RunModel['defects'][number]) => string | undefined): Record<string, number> {
  const out: Record<string, number> = {};
  for (const defect of model.defects) {
    const value = key(defect);
    if (!value) continue;
    out[value] = (out[value] ?? 0) + 1;
  }
  return out;
}

export function buildTrendPoint(model: RunModel): TrendDataPoint {
  const failed = model.tests.filter((test) => test.status === 'failed');
  const affectedEndpoints = new Set<string>();
  for (const defect of model.defects) {
    const endpoints = defect.affectedEndpoints ?? [
      { method: defect.method, endpointPath: defect.path },
    ];
    for (const endpoint of endpoints) {
      affectedEndpoints.add(`${endpoint.method} ${endpoint.endpointPath}`);
    }
  }

  return {
    runId: resolveRunId(model),
    timestamp: model.generatedAt,
    totalTests: model.totals.total,
    passCount: model.totals.passed,
    failCount: model.totals.failed,
    passRatePercentage: model.totals.total
      ? Math.round((model.totals.passed / model.totals.total) * 1000) / 10
      : 0,
    totalDurationMs: model.totals.durationMs,
    failedTestKeys: failed.map(testKey),
    schemaVersion: 2,
    defectCount: model.defects.length,
    defectOccurrences: model.defects.reduce(
      (sum, defect) => sum + (defect.ledgerOccurrences ?? defect.occurrences),
      0
    ),
    affectedEndpointCount: affectedEndpoints.size,
    bySeverity: tallyBy(model, (defect) => String(defect.severity)),
    byCategory: tallyBy(model, (defect) => defect.category),
  };
}

/** Appends this run to the history file, creating it if absent. Returns the written path. */
export function appendTrendPoint(model: RunModel, historyPath: string): string {
  const point = buildTrendPoint(model);
  const history = readHistory(historyPath);

  // Re-running the same build id replaces its point rather than double-counting it, which
  // matters when a pipeline retries a failed stage.
  const existing = history.findIndex((entry) => entry.runId === point.runId);
  if (existing === -1) history.push(point);
  else history[existing] = point;

  const trimmed = history.slice(-MAX_POINTS);

  fs.mkdirSync(path.dirname(historyPath), { recursive: true });
  fs.writeFileSync(historyPath, `${JSON.stringify(trimmed, null, 2)}\n`, 'utf-8');
  return historyPath;
}
