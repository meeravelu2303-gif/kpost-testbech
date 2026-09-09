import fs from 'fs';
import path from 'path';
import type { FullConfig, FullResult, Reporter, Suite, TestError } from '@playwright/test/reporter';
import { countExercisedEndpoints } from '../src/utils/bugTracker';
import { assessRunValidity, writeRunValidity, type RunValidity } from './run-validity';
import { dispatchBugsToTracker } from './dispatch-bugs-to-tracker';
import { writeExecutiveReport } from './generate-executive-html';
import { writeBugPayloads } from './kpost-bug-payloads';
import { appendTrendPoint } from './kpost-trend-logger';
import {
  EXECUTIVE_FILENAME,
  LATEST_DIR,
  LIVE_DIAGNOSTIC_DIR,
  PAYLOADS_FILENAME,
  REPORTS_DIR,
  TREND_HISTORY,
  captureDiagnostic,
  pruneOldRuns,
  relativeToRoot,
  retentionSetting,
  runLocation,
  writeLatestPointer,
} from './run-paths';
import { buildRunModel, type RunModel } from './run-model';
import { sendEmailReport } from './send-email-report';
import { sendWebhookAlert } from './send-webhook-alert';
import { clearTelemetry, resetTelemetry } from './telemetry';

/**
 * KPOST master reporter — the single wiring point for the reporting engine.
 *
 *   Tier 1  Diagnostic          Playwright's own HTML report + traces, archived per run
 *   Tier 2  Executive delivery  kpost-executive-summary.html
 *   Tier 3  Historical trend    reports/kpost-trend-history.json  (root, append-only)
 *   Tier 4  Auto-bug stream     kpost-bug-payloads.json
 *
 * Tiers 1, 2 and 4 are written into a timestamped run folder, so a re-run never destroys the
 * evidence from the run before it; tier 3 stays in the root because its whole value is being
 * one continuous series. `reports/latest/` mirrors the newest run for instant local access
 * and is what the dispatchers resolve through.
 *
 * A reporter rather than a global teardown, for the reason `bugReporter` is one too: the
 * dashboard needs the run's outcome counts and duration, which teardown cannot see.
 *
 * Ordering matters twice over:
 *  - this must run BEFORE `bugReporter`, which deletes `.bug-cache/` — the defect ledger both
 *    of them read — once it has compiled BUG_REPORT.md;
 *  - it must run AFTER the `html` reporter, whose `onEnd` writes the diagnostic report this
 *    one archives. Both hold in the configured order.
 */

const LOG = '[KPOST Reporter]';

/** Runs one artifact step, reporting failure by name instead of taking the others down. */
function tier(label: string, produce: () => unknown): void {
  try {
    produce();
  } catch (error) {
    console.error(`${LOG} ${label} failed:`, error);
  }
}

export default class KpostMasterReporter implements Reporter {
  private startedAt = Date.now();
  private suite?: Suite;
  /**
   * Errors raised outside any test — a spec file that failed to import, a global-setup fault.
   * These are the signal that the suite never ran at all, as opposed to running and failing,
   * and Playwright reports them only through `onError`.
   */
  private loadErrors = 0;
  /**
   * Tests that actually produced a result.
   *
   * This is counted here rather than read from `model.totals.total`, which is derived from the
   * *suite* and therefore reports every test Playwright knows about whether or not it ran. Under
   * `npx playwright test --list` the suite is fully populated while nothing executes, so a gate
   * trusting that total sees "4583 executed" and cheerfully publishes a listing to the QA
   * Dashboard — which is exactly what runIds 6 and 10 were. `onTestEnd` fires once per test that
   * reached a verdict, so it cannot report work that never happened.
   */
  private executed = 0;

  onBegin(_config: FullConfig, suite: Suite): void {
    this.startedAt = Date.now();
    this.suite = suite;
    this.executed = 0;
    fs.mkdirSync(REPORTS_DIR, { recursive: true });
    // Workers are spawned after this point, so clearing here cannot discard live telemetry.
    resetTelemetry();
  }

  onTestEnd(): void {
    this.executed += 1;
  }

  onError(_error: TestError): void {
    this.loadErrors += 1;
  }

  async onEnd(result: FullResult): Promise<{ status?: FullResult['status'] } | void> {
    try {
      const model = buildRunModel({
        suite: this.suite,
        startedAt: this.startedAt,
        durationMs: Date.now() - this.startedAt,
        endpointsExercised: countExercisedEndpoints(),
      });

      /*
       * The validity verdict is decided and written FIRST, before any artifact is produced
       * and long before the dispatchers further down `playwright.config.ts` read it. A run
       * that never happened must not reach the QA Dashboard or Bugzilla, and those two
       * reporters consult this file rather than re-deriving the judgement themselves.
       */
      const validity = assessRunValidity({
        executed: this.executed,
        collected: this.suite?.allTests().length ?? 0,
        loadErrors: this.loadErrors,
        status: result.status,
      });
      writeRunValidity(validity);

      const run = runLocation(new Date(model.generatedAt));
      model.runId = run.runId;
      model.modelPath = relativeToRoot(run.runModel);
      fs.mkdirSync(run.dir, { recursive: true });

      fs.writeFileSync(run.runModel, `${JSON.stringify(model, null, 2)}\n`, 'utf-8');

      tier('Tier 2 executive HTML', () => writeExecutiveReport(model, run.executiveHtml));
      tier('Tier 3 trend history', () => appendTrendPoint(model, TREND_HISTORY));
      tier('Tier 4 bug payloads', () => writeBugPayloads(model, run.bugPayloads));
      tier('Tier 1 diagnostic archive', () =>
        captureDiagnostic(LIVE_DIAGNOSTIC_DIR, run.diagnosticDir)
      );
      tier('Latest mirror', () => this.mirrorLatest(model, run.runId, run.dir));

      tier('Run retention', () => {
        const pruned = pruneOldRuns(retentionSetting());
        if (pruned.length > 0) {
          console.log(
            `${LOG} Pruned ${pruned.length} old run folder(s) beyond KPOST_RUN_RETENTION=${retentionSetting()}: ${pruned.join(', ')}`
          );
        }
      });

      this.printSummary(model, run.dir);

      if (!validity.valid) {
        /*
         * Local artifacts are still written above — they are what a developer debugs the
         * collapse with. What stops here is everything that leaves this machine: no email
         * claiming a clean run, no webhook, no tracker tickets derived from a defect list
         * that was never gathered.
         */
        this.printInvalidRunBanner(validity);
        return { status: 'failed' };
      }

      // Dispatchers are awaited so the process does not exit mid-request. Each one resolves
      // rather than throws, so a missing SMTP host or an unreachable tracker cannot fail a run.
      await sendEmailReport({ model, htmlPath: run.executiveHtml });
      await sendWebhookAlert({ model });
      await dispatchBugsToTracker({ payloadsPath: run.bugPayloads });
    } catch (error) {
      // A reporting failure must never mask the run's own result.
      console.error(`${LOG} reporting engine could not complete:`, error);
    } finally {
      clearTelemetry();
    }
  }

  /**
   * The loud half of the rule "a bench that cannot run must be loud, never clean".
   *
   * Printed instead of the dispatch lines, and paired with a `failed` run status so the exit
   * code is non-zero — CI, cron and a human watching the terminal all learn the same thing.
   */
  private printInvalidRunBanner(validity: RunValidity): void {
    console.error(
      [
        '',
        '='.repeat(78),
        `${LOG} RUN REJECTED — NOT PUBLISHED`,
        '='.repeat(78),
        `  Reason        ${validity.reason}`,
        `  Executed      ${validity.executed} of ${validity.collected} collected`,
        `  Load errors   ${validity.loadErrors}`,
        '',
        '  This run was NOT sent to the QA Dashboard and NOT filed to Bugzilla.',
        '  A run that did not happen is not evidence that the API is healthy, so it is',
        '  reported as a failure rather than as a clean result.',
        '='.repeat(78),
        '',
      ].join('\n')
    );
  }

  /**
   * Mirrors the newest run into `reports/latest/`.
   *
   * The executive HTML is re-rendered rather than copied because its trace-viewer link is
   * relative: inside the run folder `./diagnostic/` is a sibling, from `latest/` it is not.
   * Copying the file would ship a dead link on the copy everybody actually opens.
   */
  private mirrorLatest(model: RunModel, runId: string, runDir: string): void {
    fs.rmSync(LATEST_DIR, { recursive: true, force: true });
    fs.mkdirSync(LATEST_DIR, { recursive: true });

    const mirrored: RunModel = {
      ...model,
      environment: {
        ...model.environment,
        traceReport: `../runs/${runId}/diagnostic/index.html`,
      },
    };
    writeExecutiveReport(mirrored, path.join(LATEST_DIR, EXECUTIVE_FILENAME));

    fs.copyFileSync(
      path.join(runDir, PAYLOADS_FILENAME),
      path.join(LATEST_DIR, PAYLOADS_FILENAME)
    );

    writeLatestPointer({
      runId,
      generatedAt: model.generatedAt,
      runDir: relativeToRoot(runDir),
      executiveHtml: relativeToRoot(path.join(runDir, EXECUTIVE_FILENAME)),
      bugPayloads: relativeToRoot(path.join(runDir, PAYLOADS_FILENAME)),
      runModel: relativeToRoot(path.join(runDir, 'kpost-run-model.json')),
      environment: model.environment.name,
      totals: {
        total: model.totals.total,
        passed: model.totals.passed,
        failed: model.totals.failed,
        skipped: model.totals.skipped,
      },
      defectIds: model.defects.map((defect) => defect.id),
    });
  }

  private printSummary(model: RunModel, runDir: string): void {
    const critical = model.defects.filter((defect) => defect.severity === 'Critical').length;
    console.log(
      [
        '',
        `KPOST reporting engine — ${model.totals.failed} failed, ${model.defects.length} defects (${critical} critical)`,
        `  Run folder   ${relativeToRoot(runDir)}/`,
        `  Tier 1  diagnostic   ${relativeToRoot(runDir)}/diagnostic/index.html`,
        `  Tier 2  executive    ${relativeToRoot(runDir)}/${EXECUTIVE_FILENAME}`,
        `  Tier 3  trend        ${relativeToRoot(TREND_HISTORY)}`,
        `  Tier 4  bug stream   ${relativeToRoot(runDir)}/${PAYLOADS_FILENAME}`,
        `  Latest       reports/latest/${EXECUTIVE_FILENAME}`,
      ].join('\n')
    );
  }
}
