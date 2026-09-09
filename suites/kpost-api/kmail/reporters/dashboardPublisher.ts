import { BugReport } from './findingsModel';

/**
 * Publishes the run to the QA Dashboard's `/api/ingest` endpoint.
 *
 * The dashboard resolves the application from the API key alone (the key embeds the slug,
 * `qa.kmail.<random>`), so there is nothing to configure but the URL and key. One POST, no
 * database driver — the dashboard owns its own storage. Skips cleanly with one log line when
 * `DASHBOARD_INGEST_URL` / `DASHBOARD_API_KEY` are unset.
 *
 * Never throws: a dashboard that is down must not fail the test run.
 */

export interface DashboardConfig {
  url: string;
  apiKey: string;
}

const TIMEOUT_MS = 20_000;
const LOG = '[kmail-dashboard]';

export function readDashboardConfig(env: NodeJS.ProcessEnv): DashboardConfig | null {
  const url = env.DASHBOARD_INGEST_URL ?? '';
  const apiKey = env.DASHBOARD_API_KEY ?? '';
  if (!url || !apiKey) return null;
  return { url, apiKey };
}

export async function publishToDashboard(
  report: BugReport,
  config: DashboardConfig,
  bugIdByDefect: Record<string, number>,
  bugzillaUiBase?: string
): Promise<void> {
  const payload = {
    generatedAt: report.run.generatedAt,
    environment: report.run.environment,
    run: {
      totalTests: report.run.totalTests,
      passed: report.run.passed,
      failed: report.run.failed,
      skipped: report.run.skipped,
      durationMs: report.run.durationMs,
    },
    defects: report.defects.map((d) => {
      const bugId = bugIdByDefect[d.id];
      return {
        id: d.id,
        displayId: d.id,
        title: d.title,
        severity: d.severity,
        category: d.category,
        priority: d.priority,
        module: d.module,
        owner: 'Jitendra Kumar',
        method: d.method,
        endpointPath: d.endpointPath,
        description: d.description,
        requestBody: d.requestBody ?? '',
        expected: d.expected,
        actual: d.actual,
        type: 'api' as const,
        ...(bugId
          ? {
              bugzillaId: bugId,
              ...(bugzillaUiBase ? { bugzillaUrl: `${bugzillaUiBase.replace(/\/+$/, '')}/bugs/${bugId}` } : {}),
            }
          : {}),
      };
    }),
  };

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
  try {
    const response = await fetch(config.url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${config.apiKey}`,
      },
      body: JSON.stringify(payload),
      signal: controller.signal,
    });
    const text = await response.text().catch(() => '');
    if (response.ok) {
      // eslint-disable-next-line no-console
      console.log(
        `${LOG} ingested run — ${report.run.passed} passed / ${report.run.failed} failed / ${report.run.skipped} skipped, ${report.defects.length} defect(s).`
      );
    } else {
      // eslint-disable-next-line no-console
      console.warn(`${LOG} ingest rejected (HTTP ${response.status}): ${text.slice(0, 200)}`);
    }
  } catch (error) {
    const reason =
      error instanceof Error && error.name === 'AbortError'
        ? `no response within ${TIMEOUT_MS / 1000}s`
        : error instanceof Error
          ? error.message
          : String(error);
    // eslint-disable-next-line no-console
    console.warn(`${LOG} ingest failed: ${reason}`);
  } finally {
    clearTimeout(timer);
  }
}
