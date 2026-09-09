/**
 * File the login blocker (KPOST-AUTH-004) into Bugzilla.
 *
 * WHY THIS EXISTS AS A SCRIPT. Every other defect this bench reports is filed
 * by `dashboard-reporter.ts` at the end of a run. This one cannot be: it stops
 * a user signing in at all, so global setup aborts before a single test
 * executes and there is no run for the reporter to project. A blocker that
 * suppresses its own bug report is the one case that needs a hand-crank.
 *
 * It is NOT a second filing path. It builds the same `DefectRecord` from the
 * same registry entry and hands it to the same `fileBugzillaDefects()` — so the
 * ticket carries the identical summary tag, whiteboard tags, browser section
 * and evidence naming a normal run would produce, and a later run that files
 * the same defect id will dedup against it rather than duplicating it.
 *
 * The run totals below describe the verification run that produced the
 * evidence — 2 tests, chromium, both failed — and nothing more. They are not
 * dressed up as a full-suite run, and `unaffectedBrowsers` is deliberately
 * empty: only chromium ran, so the ticket vouches for no other browser.
 *
 * Run with:  npx vitest run --config /dev/null  (no) — see package.json script.
 */
import { fileBugzillaDefects } from '../src/reporting/bugzilla-reporter';
import type { DefectFile } from '../src/reporting/dashboard-reporter';
import type { DefectRecord, RunModel } from '../src/reporting/run-model';
import { KNOWN_APP_DEFECTS } from '../src/utils/known-defects';
import { env } from '../src/config/env';

const DEFECT = KNOWN_APP_DEFECTS.LOGIN_COUNTRY_LIST_NEVER_POPULATES;

/** The two tests that observed it, and the artifacts each produced. */
const SIGHTINGS = [
  {
    title: 'Login form readiness @smoke @auth › the login form is usable — the KPOST ID field accepts input',
    dir: 'test-results/auth-login-form-Login-form-4ee73-POST-ID-field-accepts-input-chromium',
  },
  {
    title: 'Login form readiness @smoke @auth › the country list offers a country to sign in with',
    dir: 'test-results/auth-login-form-Login-form-731ae-s-a-country-to-sign-in-with-chromium',
  },
] as const;

const ARTIFACTS = [
  { file: 'test-failed-1.png', kind: 'screenshot', contentType: 'image/png' },
  { file: 'video.webm', kind: 'video', contentType: 'video/webm' },
  { file: 'trace.zip', kind: 'trace', contentType: 'application/zip' },
] as const;

const files: DefectFile[] = SIGHTINGS.flatMap((sighting) =>
  ARTIFACTS.map((artifact) => ({
    kind: artifact.kind,
    path: `${sighting.dir}/${artifact.file}`,
    contentType: artifact.contentType,
    project: 'chromium',
    testTitle: sighting.title,
  })),
);

const defect: DefectRecord = {
  id: DEFECT.id,
  displayId: DEFECT.id,
  title: DEFECT.summary,
  severity: DEFECT.severity,
  module: DEFECT.module,
  owner: env.defectOwner,
  method: 'GET',
  endpointPath: '/v2/common/countries',
  description: DEFECT.evidence,
  requestBody: '—',
  expected: DEFECT.expected,
  actual:
    'The Country combobox renders "No options" and the KPOST ID field stays disabled, so the ' +
    'login flow cannot be started at all. Observed on chromium against ' +
    `${env.baseURL} on 2026-08-28.`,
  category: 'Functional',
  priority: 'P1',
  unaffectedBrowsers: [],
  browsers: { chromium: SIGHTINGS.length },
  sightingsByBrowser: { chromium: SIGHTINGS.map((s) => s.title) },
  type: 'WEBSITE',
};

const model: RunModel = {
  generatedAt: new Date().toISOString(),
  generatedAtHuman: new Date().toUTCString(),
  environment: env.testEnv,
  baseURL: env.baseURL,
  run: {
    status: 'blocked',
    projects: ['chromium'],
    totalTests: 2,
    passed: 0,
    failed: 2,
    skipped: 0,
    interrupted: 0,
    accounted: 2,
    unaccounted: 0,
    incomplete: false,
    incompleteReasons: [],
    unattributedFailures: [],
  },
  summary: {
    total: 1,
    bySeverity: { [DEFECT.severity]: 1 },
    byModule: { [DEFECT.module]: 1 },
  },
  defects: [defect],
} as unknown as RunModel;

async function main(): Promise<void> {
  const links = await fileBugzillaDefects(model, new Map([[defect.id, files]]));
  const link = links.get(defect.id);
  console.info(
    link ? `\nFiled as ${link.url}` : '\nNo ticket link returned — see the log above.',
  );
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
