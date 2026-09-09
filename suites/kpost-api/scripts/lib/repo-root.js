/**
 * Locates the repository root.
 *
 * Scripts used to find it with `path.resolve(__dirname, '..')`, which silently encodes how
 * deep the script happens to sit. Moving a script one directory down then makes every path it
 * builds point one level too high - and because most of those paths are read targets, the
 * failure surfaces as "file not found" or, worse, as an empty result that looks like a clean
 * answer.
 *
 * This walks up looking for `swagger.json`, the same marker `audit-vectors.ts` and
 * `generate-scorecard.ts` already use, so a script can be moved anywhere under the repo
 * without touching its path handling.
 */
const fs = require('fs');
const path = require('path');

/** The marker file that identifies the repo root. See the note above. */
const MARKER = 'swagger.json';

/**
 * @param {string} [from] directory to start from; defaults to the calling script's directory
 *   is not knowable here, so callers pass `__dirname`.
 * @returns {string} absolute path to the repository root
 */
function repoRoot(from = process.cwd()) {
  let dir = path.resolve(from);
  for (;;) {
    if (fs.existsSync(path.join(dir, MARKER))) return dir;
    const parent = path.dirname(dir);
    // Reached the filesystem root without finding the marker.
    if (parent === dir) {
      throw new Error(
        `repoRoot: walked up from ${from} without finding ${MARKER}. ` +
          'Run this from inside the repository.'
      );
    }
    dir = parent;
  }
}

module.exports = { repoRoot };
