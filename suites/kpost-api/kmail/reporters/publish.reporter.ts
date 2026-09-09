import type {
  FullConfig,
  FullResult,
  Reporter,
  Suite,
  TestCase,
  TestResult,
} from '@playwright/test/reporter';
import fs from 'fs';
import path from 'path';
import { env } from '../src/config/env.config';
import { hostOf } from '../src/config/env.config';
import {
  BugReport,
  RawFinding,
  RunSummary,
  buildDefects,
} from './findingsModel';
import { publishToBugzilla, readBugzillaConfig } from './bugzillaPublisher';
import { publishToDashboard, readDashboardConfig } from './dashboardPublisher';

/**
 * The KMail suite's publisher.
 *
 * It reads the finding attachments the specs emit (see `src/utils/findings.ts`), compiles them
 * into a deduplicated defect ledger, writes `BUG_REPORT.json` / `BUG_REPORT.md` as the durable
 * deliverable, and then — only when the relevant env is configured — files the defects into the
 * `KMail API` Bugzilla product (auto-assigned to Jitendra Kumar via component defaults) and
 * ingests the run into the QA Dashboard.
 *
 * Everything after the report files is best-effort and gated: an unconfigured or unreachable
 * tracker changes nothing about the run and prints one explanatory line. The report files are
 * always written, so the suite produces its deliverable with or without a tracker.
 */
export default class PublishReporter implements Reporter {
  private readonly findings: RawFinding[] = [];
  private passed = 0;
  private failed = 0;
  private skipped = 0;
  private total = 0;
  private startedAt = Date.now();

  onBegin(_config: FullConfig, suite: Suite): void {
    this.startedAt = Date.now();
    this.total = suite.allTests().length;
  }

  onTestEnd(_test: TestCase, result: TestResult): void {
    if (result.status === 'passed') this.passed += 1;
    else if (result.status === 'skipped') this.skipped += 1;
    else this.failed += 1;

    for (const attachment of result.attachments) {
      if (!attachment.name.startsWith('finding —')) continue;
      const raw = this.readAttachment(attachment);
      if (!raw) continue;
      try {
        const parsed = JSON.parse(raw) as RawFinding;
        if (parsed && parsed.title && parsed.endpoint && parsed.classification) {
          this.findings.push(parsed);
        }
      } catch {
        // A single unreadable finding must not abort reporting.
      }
    }
  }

  private readAttachment(attachment: TestResult['attachments'][number]): string | null {
    try {
      if (attachment.body) return attachment.body.toString('utf-8');
      if (attachment.path && fs.existsSync(attachment.path)) {
        return fs.readFileSync(attachment.path, 'utf-8');
      }
    } catch {
      /* ignore */
    }
    return null;
  }

  async onEnd(result: FullResult): Promise<void> {
    const run: RunSummary = {
      generatedAt: new Date().toISOString(),
      environment: hostOf(env.kmailBaseURL),
      totalTests: this.total || this.passed + this.failed + this.skipped,
      passed: this.passed,
      failed: this.failed,
      skipped: this.skipped,
      durationMs: Date.now() - this.startedAt,
    };
    const report: BugReport = { run, defects: buildDefects(this.findings) };

    this.writeReportFiles(report, result.status);

    // eslint-disable-next-line no-console
    console.log(
      `[kmail-report] ${report.defects.length} distinct defect(s) from ${this.findings.length} finding(s) — ` +
        `${run.passed} passed / ${run.failed} failed / ${run.skipped} skipped.`
    );

    const bugzillaConfig = readBugzillaConfig(process.env);
    let bugIdByDefect: Record<string, number> = {};
    if (bugzillaConfig && report.defects.length > 0) {
      const outcome = await publishToBugzilla(report, bugzillaConfig);
      bugIdByDefect = outcome.bugIdByDefect;
    } else if (!bugzillaConfig) {
      // eslint-disable-next-line no-console
      console.log('[kmail-bugzilla] BUGZILLA_URL / BUGZILLA_API_KEY unset — not filing bugs.');
    }

    const dashboardConfig = readDashboardConfig(process.env);
    if (dashboardConfig) {
      await publishToDashboard(report, dashboardConfig, bugIdByDefect, process.env.BUGZILLA_UI_BASE_URL);
    } else {
      // eslint-disable-next-line no-console
      console.log('[kmail-dashboard] DASHBOARD_INGEST_URL / DASHBOARD_API_KEY unset — not ingesting.');
    }
  }

  private writeReportFiles(report: BugReport, runStatus: FullResult['status']): void {
    const root = path.resolve(__dirname, '..');
    try {
      fs.writeFileSync(
        path.join(root, 'BUG_REPORT.json'),
        JSON.stringify(report, null, 2),
        'utf-8'
      );
      fs.writeFileSync(path.join(root, 'BUG_REPORT.md'), this.renderMarkdown(report, runStatus), 'utf-8');
    } catch (error) {
      // eslint-disable-next-line no-console
      console.warn(`[kmail-report] could not write report files: ${(error as Error).message}`);
    }
  }

  private renderMarkdown(report: BugReport, runStatus: FullResult['status']): string {
    const { run, defects } = report;
    const bySeverity = (s: string): number => defects.filter((d) => d.severity === s).length;
    const lines: string[] = [
      '# KMail API — defect report',
      '',
      `**Run:** ${run.generatedAt} · environment \`${run.environment}\` · status **${runStatus}**`,
      '',
      `**Tests:** ${run.passed} passed · ${run.failed} failed · ${run.skipped} skipped ` +
        `(of ${run.totalTests}) in ${(run.durationMs / 1000).toFixed(1)}s`,
      '',
      `**Defects:** ${defects.length} — ` +
        `${bySeverity('Critical')} Critical · ${bySeverity('Major')} Major · ` +
        `${bySeverity('Minor')} Minor · ${bySeverity('Low')} Low`,
      '',
      'All defects are filed into the Bugzilla `KMail API` product and auto-assigned to',
      'Jitendra Kumar (every component defaults to him).',
      '',
    ];

    if (defects.length === 0) {
      lines.push('_No defects recorded in this run._', '');
      return lines.join('\n');
    }

    for (const d of defects) {
      lines.push(
        `## ${d.id} — ${d.title}`,
        '',
        `- **Severity:** ${d.severity}  |  **Category:** ${d.category}  |  **Priority:** ${d.priority}`,
        `- **Endpoint:** \`${d.method} ${d.endpointPath}\``,
        `- **Component:** ${d.module}`,
        `- **Classification:** ${d.classification}`,
        `- **Seen on:** ${d.occurrences} test case(s), ${d.affectedEndpoints.length} endpoint(s)`,
        '',
        `**What’s wrong:** ${d.description}`,
        '',
        `**Expected:** ${d.expected}`,
        '',
        `**Actual:** ${d.actual}`,
        '',
      );
      if (d.reproSnippet) {
        lines.push('**Reproduce:**', '', '```ts', d.reproSnippet, '```', '');
      }
    }
    return lines.join('\n');
  }
}
