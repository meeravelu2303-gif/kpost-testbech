/**
 * Files known application defects into the "KPost UI" Bugzilla product — a
 * fifth projection of the same `RunModel` that `bug-report.ts`, `dev-digest.ts`
 * and the QA-Dashboard push are built from. It is called from
 * `DashboardReporter.onEnd()` with the model already in hand, never by
 * re-reading `BUG_REPORT.json` — the run-model.ts header explains why that
 * matters: one model means the projections cannot disagree about what ran.
 *
 * Mirrors the API bench's `reporters/dashboard-bugzilla.ts` — same Bugzilla
 * instance, same REST contract, same `[cat:Xxx]` `status_whiteboard` tag the
 * BUGZILLA-UI dashboard's `categoryIndex.ts` reads — but files into its own
 * product ("KPost UI", product id 3) with its own component set, so the two
 * benches' tickets never collide. Every component in that product already
 * carries a default assignee (Ayyappan Ashok), so bug creation deliberately
 * does not set `assigned_to` — Bugzilla applies the component default, which
 * keeps the assignee in one place (the Bugzilla component config) instead of
 * duplicated into this bench's env too.
 *
 * Behaviour:
 *  - `BUGZILLA_URL` / `BUGZILLA_API_KEY` unset → clean no-op, one log line.
 *  - `BUGZILLA_DRY_RUN` (default `true`) → logs what would be filed, files
 *    nothing. Set `BUGZILLA_DRY_RUN=false` to file for real.
 *  - Dedup: before creating a bug, searches the target component for an open
 *    bug whose summary already contains `[<defect.id>]`; found → no second bug
 *    is created. The existing bug still receives whatever evidence THIS run has
 *    that it does not already carry (matched on attachment name + size), so a
 *    ticket first filed by a chromium-only run gains the webkit and firefox
 *    proof on the next full run — and nothing is ever uploaded twice.
 *  - Every bug — new or backfilled — gets **all** of its evidence attached:
 *    every screenshot, video and trace its sightings produced, with no count
 *    limit. Byte-identical duplicates and repeated artifact paths are dropped
 *    first, so what lands is distinct proof rather than the same failure four
 *    times. The only thing that stops a file is Bugzilla's per-attachment size
 *    limit (`maxattachmentsize`, 50 MB here — an admin-panel setting the REST
 *    API cannot change); an oversized file is skipped with a warning naming it,
 *    and never fails the run.
 *  - Never fails the run: a Bugzilla outage or rejection is logged and
 *    swallowed, same as the dashboard push. The committed BUG_REPORT.* files
 *    and the dashboard payload already captured everything.
 */
import { createHash } from 'node:crypto';
import fs from 'node:fs/promises';
import { env } from '../config/env';
import type { DefectFile } from './dashboard-reporter';
import { TRACE_BUDGET_BYTES, createTraceBudget, orderEvidence } from './evidence';
import type { BugzillaLink, DefectRecord, RunModel } from './run-model';

const REQUEST_TIMEOUT_MS = 15_000;
/**
 * Uploading an 8 MB trace takes longer than a 2 KB search, so attachments get
 * their own, much larger budget. Without it a big trace aborts mid-upload and
 * the bug loses evidence that was perfectly attachable.
 */
const ATTACHMENT_TIMEOUT_MS = 120_000;
/**
 * **There is no cap on how many evidence files a bug receives.** Every
 * screenshot, video and trace the defect's sightings produced is attached — that
 * is a deliberate instruction, not an oversight: the point of this bench is that
 * a developer opening a ticket finds the whole proof, not a sample of it.
 *
 * The only thing that stops a file is Bugzilla's own per-attachment size limit
 * (`maxattachmentsize`, 51200 KB / 50 MB on this instance — an admin-panel
 * setting the REST API cannot change). A file over it is skipped with a warning
 * naming the file and its size, because a silently dropped attachment is a lie
 * about the evidence. Override with `BUGZILLA_MAX_ATTACHMENT_MB` if the
 * instance's limit is set differently.
 */
const MAX_ATTACHMENT_BYTES =
  Number.parseInt(process.env.BUGZILLA_MAX_ATTACHMENT_MB ?? '50', 10) * 1024 * 1024;

const SEVERITY_TO_BUGZILLA: Record<string, { severity: string; priority: string }> = {
  High: { severity: 'major', priority: 'High' },
  Medium: { severity: 'normal', priority: 'Normal' },
  Low: { severity: 'minor', priority: 'Low' },
};

/** Modules with a dedicated component in the "KPost UI" Bugzilla product. */
const KNOWN_COMPONENTS = new Set([
  'Auth',
  'Home',
  'KMail',
  'WriteMail',
  'KDirectory',
  'Katchup',
  'Settings',
  'KEcommerce',
  'KNews',
  'KPay',
  'Accessibility',
]);
const FALLBACK_COMPONENT = 'General';

function resolveComponent(module: string): string {
  return KNOWN_COMPONENTS.has(module) ? module : FALLBACK_COMPONENT;
}

/**
 * `[KPOST-GENERAL-001][webkit] Firebase Messaging crashes the app.`
 *
 * The affected browsers go in the SUMMARY because that is the only field a bug
 * list shows — a developer scanning twenty tickets can see which are theirs
 * without opening any. Kept compact: one browser is named, every browser is
 * "all browsers", and anything between is joined with "+".
 */
function summaryFor(defect: DefectRecord): string {
  return `[${defect.id}][${browserTag(defect)}] ${defect.title}`;
}

/** `webkit` · `all browsers` · `chromium+firefox` — whichever is shortest and true. */
function browserTag(defect: DefectRecord): string {
  const affected = Object.keys(defect.browsers).sort();
  if (affected.length === 0) return 'unknown';
  if (affected.length === 1) return affected[0];
  return defect.unaffectedBrowsers.length === 0 ? 'all browsers' : affected.join('+');
}

function descriptionFor(defect: DefectRecord, model: RunModel): string {
  const { publicUrl } = env.dashboard;
  return [
    `Environment: ${model.environment} (${model.baseURL})`,
    `Module: ${defect.module}`,
    `Severity: ${defect.severity} · Priority: ${defect.priority} · Category: ${defect.category}`,
    '',
    'Evidence:',
    defect.description,
    '',
    'Expected:',
    defect.expected,
    '',
    'Actual:',
    defect.actual,
    '',
    ...browserSection(defect),
    'HOW TO READ THE ATTACHMENTS: every screenshot, video and trace this run captured for this ' +
      'defect is attached below — nothing is sampled or capped. Each is named ' +
      '"<browser>--<test>--<artifact>--<kind>" and its summary reads ' +
      '"<Kind> · <browser> · <test> · <artifact>", so you can tell which browser, which test and ' +
      'which moment produced it without opening it. Screenshots show the page ' +
      'at the moment of failure; the .webm is a video of the whole test; the .zip is a Playwright ' +
      'trace — open it at https://trace.playwright.dev or with `npx playwright show-trace <file>` ' +
      'for a step-by-step replay with DOM snapshots and network. Bugzilla has no built-in video ' +
      'player, so a .webm will download rather than play here; the same evidence plays inline on ' +
      'the QA Dashboard' +
      /*
       * Deliberately NOT a `/defects/<KPOST-…>` deep link. The dashboard's
       * `/defects/:id` route takes its own NUMERIC defect id and answers
       * "Invalid defect id" for this bench's string id, so that link was dead
       * every time it was clicked. The dashboard reaches back the other way
       * instead: the ingest payload now carries this bug's number, so the
       * defect page there links straight to this ticket.
       */
      (publicUrl ? `: ${publicUrl}/dashboard (search for ${defect.id}).` : '.') +
      ' Everything is also in the local Playwright HTML report (`npm run report`).',
  ].join('\n');
}

/**
 * Record a fresh sighting on a bug that already exists.
 *
 * Bugzilla cannot rewrite a bug's opening description, so a ticket filed by an
 * early partial run would otherwise keep describing that run forever. A comment
 * says what THIS run saw and what evidence it just added, which is what makes
 * one long-lived ticket per defect better than a new ticket each time.
 */
async function commentOnBug(
  url: string,
  apiKey: string,
  bugId: number,
  defect: DefectRecord,
  model: RunModel,
  addedFiles: number,
): Promise<void> {
  const body = [
    `Still reproducing — seen again on ${model.generatedAtHuman}.`,
    '',
    `Environment: ${model.environment} (${model.baseURL})`,
    `Browsers in this run: ${model.run.projects.join(', ') || '—'}`,
    `Run outcome: ${model.run.passed} passed / ${model.run.failed} failed / ` +
      `${model.run.skipped} skipped of ${model.run.totalTests} planned` +
      (model.run.incomplete ? ' (INCOMPLETE — the run did not finish its plan)' : ''),
    '',
    defect.actual,
    '',
    `${addedFiles} new evidence file(s) attached from this run. Evidence already on this bug was ` +
      'not re-uploaded.',
  ].join('\n');

  try {
    await bugzillaCall(url, `/bug/${bugId}/comment`, 'POST', apiKey, { comment: body });
  } catch (error) {
    if (error instanceof BugzillaMailDeliveryError) {
      warnAboutMailOnce(error.message);
      return; // The comment posted; only its notification mail failed.
    }
    console.warn(`[bugzilla] could not comment on bug #${bugId}: ${messageOf(error)}`);
  }
}

/**
 * "Which browser?" answered at the top of the ticket, not inferred from
 * attachment filenames.
 *
 * A defect that only fires on WebKit is a different bug from one that fires on
 * all four, and that difference decides who picks the ticket up and how urgent
 * it is. Bugzilla has no field for it, so it goes in the description — plain
 * text, aligned, readable in the raw comment view where Bugzilla renders no
 * markup.
 */
function browserSection(defect: DefectRecord): string[] {
  const affected = Object.entries(defect.browsers).sort(
    (a, b) => b[1] - a[1] || a[0].localeCompare(b[0]),
  );
  if (affected.length === 0) return [];

  const width = Math.max(...affected.map(([name]) => name.length));
  const unaffected = defect.unaffectedBrowsers;

  return [
    'BROWSERS',
    `  Affected     : ${affected.map(([name]) => name).join(', ')}`,
    ...affected.map(([name, count]) => `                   - ${name.padEnd(width)}  ${count} failing test(s)`),
    /*
     * The other half of the answer, and the one that turns a bug report into a
     * diagnosis. "Affected: webkit" alone leaves the reader wondering whether
     * the other browsers were simply never tried. Naming the browsers that ran
     * the SAME suite and stayed green says the fault is browser-specific — and
     * on a single-project run this list is empty rather than vouching for
     * browsers nobody opened.
     */
    unaffected.length > 0
      ? `  Not affected : ${unaffected.join(', ')} — ran the same suite in this run and did NOT hit it.`
      : '  Not affected : none — every browser in this run hit this defect.',
    '',
    affected.length === 1 && unaffected.length > 0
      ? `=> ${affected[0][0]}-SPECIFIC. The other browsers behave correctly, so look for a ` +
        'browser-API or platform difference rather than shared application logic.'
      : affected.length > 1 && unaffected.length === 0
        ? '=> Affects EVERY browser tested, which points at shared application code rather ' +
          'than any one browser.'
        : '=> Affects some browsers but not others — compare the two sets when reproducing.',
    '',
    'Which tests, per browser:',
    ...Object.entries(defect.sightingsByBrowser)
      .sort(([a], [b]) => a.localeCompare(b))
      .flatMap(([browser, titles]) => [
        `  [${browser}]`,
        ...titles.map((title) => `      · ${title}`),
      ]),
    '',
  ];
}

/**
 * The browsable address of a bug, derived from the REST base.
 *
 * `BUGZILLA_URL` points at the REST endpoint (`http://host/rest`); a person
 * needs `http://host/show_bug.cgi?id=N`. Stripping the trailing `/rest` is the
 * whole conversion — and when the base does not end in `/rest`, it is left
 * alone rather than guessed at.
 */
function browsableBugUrl(restBaseUrl: string, bugId: number): string {
  const base = restBaseUrl.replace(/\/+$/, '').replace(/\/rest$/i, '');
  return `${base}/show_bug.cgi?id=${bugId}`;
}

/**
 * Bugzilla's error code for "I could not send the notification e-mail".
 *
 * This one is special, and getting it wrong is expensive. Bugzilla writes the
 * bug (or the attachment) FIRST and mails afterwards, inside the same request —
 * so when its mail is misconfigured, the write **succeeds** and the API still
 * answers HTTP 400. Verified 2026-08-27 against this instance, whose `mailfrom`
 * parameter is the bare token `bugzilla-daemon` rather than an address, making
 * every write answer `{"code":68000,"message":"There was an error sending mail
 * from 'bugzilla-daemon' to '…': no sender"}`. Bug #111 and its three
 * attachments were all created and stored byte-identically by calls that
 * "failed" exactly this way.
 *
 * Treating that as a failure is what a naive client does, and the result is the
 * worst of both worlds: tickets pile up in the tracker while the bench reports
 * "0 filed, 14 failed" and never attaches a single screenshot to any of them.
 * So the code below tells this apart from a real rejection and recovers.
 *
 * The proper fix is on the Bugzilla side — set `mailfrom` to a real address, or
 * set `mail_delivery_method` to `None`, in Administration → Parameters → Email.
 * This handling stays regardless: a tracker's mail configuration is not a good
 * reason to lose a bug report.
 */
const MAIL_DELIVERY_ERROR_CODE = 68000;

/** A write that Bugzilla committed and then failed to send mail about. */
class BugzillaMailDeliveryError extends Error {}

/** Whether a Bugzilla error body is the post-commit mail failure above. */
function isMailDeliveryFailure(json: Record<string, unknown>): boolean {
  return (
    json.code === MAIL_DELIVERY_ERROR_CODE ||
    /error sending mail/i.test(String(json.message ?? ''))
  );
}

/** Warned about once per run — it is one instance-wide misconfiguration, not 14 problems. */
let warnedAboutMail = false;
function warnAboutMailOnce(detail: string): void {
  if (warnedAboutMail) return;
  warnedAboutMail = true;
  console.warn(
    `[bugzilla] NOTE: Bugzilla accepted the write but could not send its notification mail ` +
      `("${detail}"). The bug and its attachments ARE stored — this run works around it. Fix it ` +
      `properly in Administration → Parameters → Email: set "mailfrom" to a real address, or set ` +
      `"mail_delivery_method" to None if this instance is not meant to send mail.`,
  );
}

async function bugzillaCall(
  baseUrl: string,
  path: string,
  method: 'GET' | 'POST',
  apiKey: string,
  body?: Record<string, unknown>,
  timeoutMs: number = REQUEST_TIMEOUT_MS,
): Promise<Record<string, unknown>> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const url = new URL(`${baseUrl.replace(/\/+$/, '')}${path}`);
    const init: RequestInit = { method, signal: controller.signal };
    if (method === 'GET') {
      url.searchParams.set('api_key', apiKey);
    } else {
      init.headers = { 'Content-Type': 'application/json' };
      init.body = JSON.stringify({ ...body, api_key: apiKey });
    }
    const response = await fetch(url, init);
    const json = (await response.json().catch(() => ({}))) as Record<string, unknown>;
    if (!response.ok) {
      const message = (json.message as string) ?? JSON.stringify(json);
      if (isMailDeliveryFailure(json)) throw new BugzillaMailDeliveryError(message);
      throw new Error(`HTTP ${response.status}: ${message}`);
    }
    return json;
  } finally {
    clearTimeout(timer);
  }
}

/** Finds an open bug (resolution `---`) already tagged with this defect's id. */
async function findExistingOpenBug(
  defect: DefectRecord,
  component: string,
  baseUrl: string,
  apiKey: string,
  product: string,
): Promise<number | undefined> {
  const query =
    `/bug?product=${encodeURIComponent(product)}` +
    `&component=${encodeURIComponent(component)}` +
    `&summary=${encodeURIComponent(`[${defect.id}]`)}&summary_type=substring` +
    `&resolution=---`;
  const result = await bugzillaCall(baseUrl, query, 'GET', apiKey);
  const bugs = (result.bugs as Array<{ id: number }> | undefined) ?? [];
  return bugs[0]?.id;
}

/**
 * What a bug already has attached, as `"<file_name>:<bytes>"` keys.
 *
 * This is how evidence stays complete AND duplicate-free across runs. The old
 * rule was "backfill only a bug with zero attachments", which is duplicate-free
 * but leaves a bug filed by a partial run stuck with partial proof forever — the
 * chromium screenshots and none of the webkit ones, because the second run sees
 * "it already has attachments" and adds nothing. Comparing name and size instead
 * lets a later run contribute the evidence the earlier one could not, while
 * re-uploading nothing that is already there. Names are deterministic
 * (`<browser>--<test>--<kind>--<artifact>`), so the same artifact from the same
 * test on the same browser matches itself.
 *
 * `exclude_fields=data` matters: without it Bugzilla base64s every attachment
 * into the response, which for a bug carrying three 17 MB traces is a ~70 MB
 * download to answer a question about filenames.
 */
async function getExistingAttachmentKeys(
  baseUrl: string,
  apiKey: string,
  bugId: number,
): Promise<Set<string>> {
  const result = await bugzillaCall(
    baseUrl,
    `/bug/${bugId}/attachment?exclude_fields=data`,
    'GET',
    apiKey,
  );
  const bugs = (result.bugs as Record<string, Array<{ file_name?: string; size?: number }>>) ?? {};
  return new Set((bugs[String(bugId)] ?? []).map((a) => `${a.file_name}:${a.size}`));
}

async function createBug(
  defect: DefectRecord,
  component: string,
  model: RunModel,
): Promise<number> {
  const { url, apiKey, product, version } = env.bugzilla;
  const mapping = SEVERITY_TO_BUGZILLA[defect.severity] ?? SEVERITY_TO_BUGZILLA.Medium;
  try {
    const result = await bugzillaCall(url!, '/bug', 'POST', apiKey!, {
      product,
      component,
      version,
      summary: summaryFor(defect),
      description: descriptionFor(defect, model),
      severity: mapping.severity,
      priority: mapping.priority,
      op_sys: 'All',
      platform: 'All',
      // The `[cat:Xxx]` contract BUGZILLA-UI's categoryIndex.ts reads. Every
      // defect this bench finds is a functional conformance gap (a control
      // missing a name, a route not guarding, a feed rendering empty) rather
      // than a performance or compatibility finding, so the tag is constant.
        // `[browser:a,b]` alongside the category tag so a bug list can be
      // filtered by browser, not only read. BUGZILLA-UI renders each as a chip.
      status_whiteboard: `[cat:Functional][browser:${Object.keys(defect.browsers).sort().join(',')}]`,
    });
    return result.id as number;
  } catch (error) {
    if (!(error instanceof BugzillaMailDeliveryError)) throw error;
    /*
     * The bug exists — Bugzilla committed it and then failed to mail about it,
     * so the error body carries a mail message instead of the new bug's id. The
     * summary is tagged `[<defect id>]`, which is exactly what the dedup search
     * looks for, so ask for it back the same way the next run would.
     */
    warnAboutMailOnce(error.message);
    const recovered = await findExistingOpenBug(defect, component, url!, apiKey!, product);
    if (recovered === undefined) {
      throw new Error(
        'Bugzilla reported a mail-delivery failure while creating this bug, and no bug tagged ' +
          `[${defect.id}] could be found afterwards — so it genuinely was not created. ` +
          `Underlying error: ${error.message}`,
      );
    }
    return recovered;
  }
}

/**
 * Attaches **every** evidence file this defect's sightings produced —
 * screenshots, videos and traces — to a bug. No count limit; see
 * `MAX_ATTACHMENT_BYTES` for the single thing that can stop a file.
 *
 * Called both for a freshly created bug and, once, to backfill an existing bug
 * that has no attachments yet.
 *
 * Two kinds of duplicate are removed before uploading, because an evidence panel
 * full of the same file three times is worse than a short one:
 *  - the identical artifact path reported twice (a retry re-reporting a file
 *    that was never rewritten), and
 *  - byte-identical files under different names, which is what four browser
 *    projects hitting the same blank page produce.
 * Everything that survives is genuinely distinct proof.
 */
async function uploadAttachments(
  url: string,
  apiKey: string,
  bugId: number,
  defectId: string,
  files: readonly DefectFile[],
): Promise<number> {
  // Screenshots and videos first and without limit; traces last, sharing a byte
  // budget. See `evidence.ts` for why.
  const unique = orderEvidence(files);
  if (unique.length === 0) return 0;

  // What the bug already carries, so a re-run adds only what is new.
  const alreadyThere = await getExistingAttachmentKeys(url, apiKey, bugId).catch(
    () => new Set<string>(),
  );

  const budget = createTraceBudget();
  let uploaded = 0;
  let skipped = 0;
  const seenContent = new Set<string>();

  for (const file of unique) {
    try {
      const bytes = await fs.readFile(file.path);

      if (alreadyThere.has(`${attachmentName(file)}:${bytes.length}`)) {
        skipped += 1;
        continue;
      }

      if (bytes.length > MAX_ATTACHMENT_BYTES) {
        skipped += 1;
        console.warn(
          `[bugzilla] ${defectId}: skipped a ${file.kind} of ` +
            `${(bytes.length / 1024 / 1024).toFixed(1)} MB (${file.testTitle} [${file.project}]) — ` +
            `over Bugzilla's ${(MAX_ATTACHMENT_BYTES / 1024 / 1024).toFixed(0)} MB per-attachment ` +
            'limit. Raise maxattachmentsize in Administration → Parameters → Attachments to keep it.',
        );
        continue;
      }

      /*
       * Deduplicate content PER BROWSER, not globally.
       *
       * The point of the dedupe is to stop one failure's screenshot being
       * uploaded sixty times. But the browser is part of what an attachment
       * proves — a ticket saying "affects chromium and firefox" needs evidence
       * from both — and a global content hash would silently drop the second
       * browser's copy if the two files happened to be byte-identical, leaving
       * that browser's claim unevidenced. Scoping the hash to the project keeps
       * one copy per browser while still collapsing repeats within a browser.
       */
      const fingerprint = `${file.project}:${createHash('sha256').update(bytes).digest('hex')}`;
      if (seenContent.has(fingerprint)) {
        skipped += 1;
        continue;
      }
      seenContent.add(fingerprint);

      if (!budget.allows(file.kind, bytes.length)) {
        skipped += 1;
        continue;
      }

      await bugzillaCall(url, `/bug/${bugId}/attachment`, 'POST', apiKey, {
        ids: [bugId],
        data: bytes.toString('base64'),
        file_name: attachmentName(file),
        // The summary is what a person reads in Bugzilla's attachment list, so
        // it names the browser, the test and the artifact — enough to know what
        // you are about to open without downloading it first.
        summary: `${capitalize(file.kind)} · ${file.project} · ${file.testTitle} · ${baseNameOf(file.path)}`,
        content_type: file.contentType || 'application/octet-stream',
        is_patch: 0,
      }, ATTACHMENT_TIMEOUT_MS);
      uploaded += 1;
    } catch (error) {
      if (error instanceof BugzillaMailDeliveryError) {
        // The attachment stored; only the notification mail failed. Counting
        // this as a loss would under-report evidence that is genuinely there —
        // read back byte-identical on this instance (see MAIL_DELIVERY_ERROR_CODE).
        warnAboutMailOnce(error.message);
        uploaded += 1;
        continue;
      }
      // A retried test can report an artifact cleaned up between attempts, or
      // the file can simply exceed Bugzilla's size cap — either way, this is
      // not worth failing the run over.
      console.warn(`[bugzilla] could not attach a ${file.kind} for ${defectId}: ${messageOf(error)}`);
    }
  }
  if (uploaded > 0 || skipped > 0) {
    const traceNote =
      budget.skipped > 0
        ? ` ${budget.skipped} trace(s) exceeded the ${(TRACE_BUDGET_BYTES / 1024 / 1024).toFixed(0)} MB ` +
          'per-bug trace budget and stayed in playwright-report/ only — raise BUGZILLA_MAX_TRACE_MB to ' +
          'attach them. Screenshots and videos are never limited.'
        : '';
    console.info(
      `[bugzilla] ${defectId}: attached ${uploaded} of ${unique.length} evidence file(s) to ` +
        `bug #${bugId}` +
        (skipped > 0
          ? ` (${skipped} skipped: already attached, oversized, or byte-identical duplicates).`
          : '.') +
        traceNote,
    );
  }
  return uploaded;
}

/**
 * The filename an evidence file is attached under.
 *
 * Includes the artifact's own base name (`test-failed-1`, `test-failed-2`, …)
 * because one test can produce several screenshots, and two attachments called
 * `chromium--opening-kmail--screenshot.png` on the same bug tell a reader
 * nothing about which is which. It is also the dedup key against what the bug
 * already has, so it must be derived only from stable facts.
 */
function attachmentName(file: DefectFile): string {
  return `${slug(file.project)}--${slug(file.testTitle)}--${slug(baseNameOf(file.path))}--${file.kind}${extensionOf(file.path)}`;
}

/** `test-failed-1` from `…/test-failed-1.png`. */
function baseNameOf(filePath: string): string {
  const name = filePath.split(/[\\/]/).pop() ?? '';
  const dot = name.lastIndexOf('.');
  return dot > 0 ? name.slice(0, dot) : name;
}


/** Filename-safe fragment of a project or test title, short enough to stay readable. */
function slug(value: string): string {
  return (
    value
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '')
      .slice(0, 40) || 'unknown'
  );
}

/** `.webm` from `…/video.webm`; empty when the artifact has no extension. */
function extensionOf(filePath: string): string {
  const name = filePath.split(/[\\/]/).pop() ?? '';
  const dot = name.lastIndexOf('.');
  return dot > 0 ? name.slice(dot) : '';
}

function capitalize(value: string): string {
  return value.length > 0 ? value[0].toUpperCase() + value.slice(1) : value;
}

/**
 * Files (or verifies) one bug per observed defect and returns the ticket each
 * one lives in, keyed by defect id.
 *
 * The return value is what lets `dashboard-reporter.ts` push a defect that
 * links to its Bugzilla ticket — which is also why this now runs BEFORE the
 * dashboard push rather than after it. A dry run, an unset Bugzilla, or a
 * failure returns an empty (or partial) map, and the push simply carries no
 * link for those defects.
 */
export async function fileBugzillaDefects(
  model: RunModel,
  filesByDefect: ReadonlyMap<string, readonly DefectFile[]>,
): Promise<Map<string, BugzillaLink>> {
  const links = new Map<string, BugzillaLink>();
  const { url, apiKey, dryRun, product } = env.bugzilla;
  if (!url || !apiKey) {
    console.info('[bugzilla] BUGZILLA_URL not set — this run will not file defects into Bugzilla.');
    return links;
  }
  if (model.defects.length === 0) return links;

  let filed = 0;
  let skipped = 0;
  let failed = 0;

  for (const defect of model.defects) {
    const component = resolveComponent(defect.module);
    try {
      if (dryRun) {
        console.info(
          `[bugzilla] DRY RUN — would file/verify ${defect.id} in "${product}" / "${component}".`,
        );
        continue;
      }
      const existing = await findExistingOpenBug(defect, component, url, apiKey, product);
      if (existing) {
        skipped += 1;
        // An already-open ticket is still THIS defect's ticket, so it is linked
        // exactly like a freshly filed one — otherwise the dashboard would lose
        // the link on every run after the first.
        links.set(defect.id, { id: existing, url: browsableBugUrl(url, existing) });
        console.info(
          `[bugzilla] ${defect.id} already open as bug #${existing} — not re-filed; ` +
            'checking whether this run has evidence it does not already carry.',
        );
        /*
         * Contribute this run's evidence to the existing ticket. `uploadAttachments`
         * skips anything already on the bug (same name, same size), so a bug first
         * filed by a chromium-only run gains the webkit and firefox proof on the
         * next full run instead of being frozen with partial evidence — and nothing
         * is uploaded twice.
         */
        const added = await uploadAttachments(
          url,
          apiKey,
          existing,
          defect.id,
          filesByDefect.get(defect.id) ?? [],
        );
        /*
         * Keep the ticket current. Its opening description describes whichever
         * run first filed it — which may have been a partial one — so a later
         * run that saw the defect again says so in a comment rather than
         * leaving a reader to assume the ticket is stale. Only when this run
         * actually contributed something, so re-running the suite does not
         * bury the bug under identical "still happening" notes.
         */
        if (added > 0) await commentOnBug(url, apiKey, existing, defect, model, added);
        continue;
      }
      const id = await createBug(defect, component, model);
      filed += 1;
      links.set(defect.id, { id, url: browsableBugUrl(url, id) });
      console.info(`[bugzilla] filed ${defect.id} as bug #${id} (component "${component}").`);
      await uploadAttachments(url, apiKey, id, defect.id, filesByDefect.get(defect.id) ?? []);
    } catch (error) {
      failed += 1;
      console.warn(`[bugzilla] could not file ${defect.id}: ${messageOf(error)}`);
    }
  }

  if (!dryRun) {
    console.info(`[bugzilla] done: ${filed} filed, ${skipped} already open, ${failed} failed.`);
  }
  return links;
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
