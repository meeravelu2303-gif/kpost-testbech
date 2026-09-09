/**
 * How a defect's evidence is ordered and bounded before it is uploaded.
 *
 * Shared by both destinations — the Bugzilla ticket and the QA Dashboard — so a
 * developer sees the same proof, in the same order, wherever they open the
 * defect.
 *
 * ## The rule
 *
 * **Screenshots and videos are never limited.** Every one a defect's sightings
 * produced is uploaded. They are the proof a human actually looks at, they are
 * small (a screenshot ~0.7 MB, a video ~1.2 MB), and a bug report that shows
 * four of the sixty browsers/tests that hit a defect is a bug report that
 * understates it.
 *
 * **Traces are ordered last and share a byte budget.** A Playwright trace is
 * ~17 MB — twenty times a video — and it is a developer tool (a step-by-step
 * replay), not the evidence someone triages from. Left unbounded, a defect
 * sighted by sixty tests would push a gigabyte of traces into the tracker,
 * taking hours and crowding out nothing useful, because the screenshots and
 * videos already told the story. So traces go at the back of the queue and stop
 * at `TRACE_BUDGET_BYTES`; whatever is skipped is reported, never dropped
 * silently, and every trace remains in `playwright-report/` locally.
 *
 * Both numbers are env-overridable, so "actually, upload all the traces too" is
 * one variable away rather than a code change.
 */
import type { DefectFile } from './dashboard-reporter';

/**
 * Total bytes of TRACES uploaded per defect. Screenshots and videos do not
 * count against it and are never capped. `BUGZILLA_MAX_TRACE_MB=0` disables
 * trace upload entirely; a large value effectively removes the bound.
 */
export const TRACE_BUDGET_BYTES =
  Number.parseInt(process.env.BUGZILLA_MAX_TRACE_MB ?? '200', 10) * 1024 * 1024;

/** Screenshots first (what you look at), then videos, then traces. */
const KIND_ORDER: Record<string, number> = { screenshot: 0, video: 1, trace: 2 };

function kindRank(kind: string): number {
  return KIND_ORDER[kind] ?? KIND_ORDER.trace;
}

/**
 * Distinct files, screenshots and videos first, traces last.
 *
 * Deduplicates by artifact path: a retried test can report the same file twice,
 * and uploading it twice makes an evidence list harder to read without adding
 * anything to it.
 */
export function orderEvidence(files: readonly DefectFile[]): DefectFile[] {
  const seen = new Set<string>();
  const distinct = files.filter((file) =>
    seen.has(file.path) ? false : (seen.add(file.path), true),
  );
  // Stable within a kind, so files stay in the order their tests ran.
  return distinct
    .map((file, index) => ({ file, index }))
    .sort((a, b) => kindRank(a.file.kind) - kindRank(b.file.kind) || a.index - b.index)
    .map((entry) => entry.file);
}

/** Tracks the trace budget for one defect. Screenshots and videos always pass. */
export function createTraceBudget(): { allows(kind: string, bytes: number): boolean; skipped: number } {
  let spent = 0;
  let skipped = 0;
  return {
    allows(kind: string, bytes: number): boolean {
      if (kind !== 'trace') return true;
      if (spent + bytes > TRACE_BUDGET_BYTES) {
        skipped += 1;
        return false;
      }
      spent += bytes;
      return true;
    },
    get skipped() {
      return skipped;
    },
  };
}
