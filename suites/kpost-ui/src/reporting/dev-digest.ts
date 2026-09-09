/**
 * Writes `DEV_DIGEST.md` and `DEV_DIGEST.json` — the one-screen triage summary.
 *
 * Mirrors the API bench's Developer Digest in role and shape: `BUG_REPORT.md` is the
 * full case file, this is what someone reads in the ten seconds before deciding
 * whether to open it. Both are gitignored here for the same reason they are there —
 * the digest is a view of `BUG_REPORT.*`, and committing a derived file only creates
 * a second thing that can be stale.
 *
 * It reads the in-memory run model rather than re-parsing `BUG_REPORT.json`, so the
 * digest and the report cannot describe different runs.
 */
import fs from 'fs';
import path from 'path';
import { type RunModel, passRate, severityRank, verdict } from './run-model';

const ROOT = path.resolve(__dirname, '..', '..');

export interface WrittenDigest {
  readonly markdown: string;
  readonly json: string;
}

export function writeDevDigest(model: RunModel, root = ROOT): WrittenDigest {
  const markdownPath = path.join(root, 'DEV_DIGEST.md');
  const jsonPath = path.join(root, 'DEV_DIGEST.json');

  fs.writeFileSync(markdownPath, renderDigest(model), 'utf-8');
  fs.writeFileSync(jsonPath, `${JSON.stringify(buildDigestJson(model), null, 2)}\n`, 'utf-8');

  return { markdown: markdownPath, json: jsonPath };
}

function buildDigestJson(model: RunModel): Record<string, unknown> {
  return {
    generatedAt: model.generatedAt,
    environment: model.environment,
    baseURL: model.baseURL,
    verdict: verdict(model),
    incomplete: model.run.incomplete,
    incompleteReasons: model.run.incompleteReasons,
    run: {
      ...model.run,
      passRate: passRate(model),
      // Explicit, so a machine reading the digest can check the same thing a
      // person does: is every failure accounted for?
      attributedFailures: model.run.failed - model.run.unattributedFailures.length,
    },
    bySeverity: model.summary.bySeverity,
    byModule: model.summary.byModule,
    defects: model.defects.map((defect) => ({
      id: defect.displayId,
      title: defect.title,
      severity: defect.severity,
      module: defect.module,
    })),
  };
}

function renderDigest(model: RunModel): string {
  const rate = passRate(model);
  const lines: string[] = [
    '# KPost UI — Developer Digest',
    '',
    `> ${model.generatedAtHuman} · target \`${model.environment}\` · \`${model.baseURL}\``,
    '',
    `**${verdict(model)}**`,
    '',
  ];

  if (model.run.incomplete) {
    lines.push(
      '## ⚠ This run did not finish',
      '',
      ...model.run.incompleteReasons.map((reason) => `- ${reason}`),
      '',
      'What to do: check whether the app under test was up and healthy, then re-run.',
      'The counts below are honest but partial — a green pass rate here does NOT mean the',
      'suite passed. See `OPERATIONS.md` → "When a run comes back incomplete".',
      '',
    );
  }

  lines.push(
    '## Execution',
    '',
    '| Metric | Value |',
    '| --- | --- |',
    `| Tests planned | ${model.run.totalTests} |`,
    `| Reached a result | ${model.run.accounted} |`,
    `| Passed | ${model.run.passed} |`,
    `| Failed | ${model.run.failed} |`,
    `| Skipped | ${model.run.skipped} |`,
    ...(model.run.interrupted > 0 ? [`| Interrupted | ${model.run.interrupted} |`] : []),
    ...(model.run.unaccounted > 0 ? [`| Never ran | ${model.run.unaccounted} |`] : []),
    `| Pass rate (of tests that ran) | ${rate === null ? 'n/a' : `${rate.toFixed(1)}%`} |`,
    `| Duration | ${model.run.durationSeconds}s |`,
    `| Projects | ${model.run.projects.join(', ') || '—'} |`,
    // The number that makes the defect count checkable: how much of the red is
    // explained. On a one-screen triage doc this belongs in the table, not
    // three sections down.
    ...(model.run.failed > 0
      ? [
          `| Failures explained by a defect | ${model.run.failed - model.run.unattributedFailures.length} of ${model.run.failed} |`,
          `| Failures with NO defect | ${model.run.unattributedFailures.length} |`,
        ]
      : []),
    '',
  );

  if (model.run.unattributedFailures.length > 0) {
    lines.push(
      '## ⚠ Unexplained failures — triage these first',
      '',
      'These failed with no entry in `known-defects.ts`, so no ticket exists for them. Each is',
      'either an app defect nobody has registered yet or a test that needs fixing.',
      '',
      '| Browser | Spec | Test | Error |',
      '| --- | --- | --- | --- |',
      ...model.run.unattributedFailures.map(
        (f) =>
          `| \`${f.project}\` | \`${f.file}\` | ${f.testTitle.replace(/\|/g, '\\|')} | ` +
          `${f.error.replace(/\|/g, '\\|')} |`,
      ),
      '',
    );
  }

  if (model.defects.length === 0) {
    lines.push('## Known application defects observed', '', 'None in this run.', '');
  } else {
    lines.push(
      '## Known application defects observed',
      '',
      '| ID | Severity | Module | Title |',
      '| --- | --- | --- | --- |',
      ...[...model.defects]
        .sort((a, b) => severityRank(a.severity) - severityRank(b.severity))
        .map(
          (defect) =>
            `| ${defect.displayId} | ${defect.severity} | ${defect.module} | ${defect.title.replace(/\|/g, '\\|')} |`,
        ),
      '',
      '_Application defects, documented — never suppressed. A test that observes one may',
      'FAIL (it asserts the behaviour the app should have) or PASS (it pins the broken',
      'behaviour as a contract, so it turns red the day the app changes). `BUG_REPORT.md`',
      'records which tests saw each defect and with what outcome._',
      '',
    );
  }

  lines.push('_Full detail: `BUG_REPORT.md`. Traces and video: `npm run report`._');

  return `${lines.join('\n')}\n`;
}
