/**
 * How a run's target is labelled, in one place.
 *
 * This mirrors `src/utils/environment.ts` in the API bench (`../KPOST-AUTOMATION-v1`)
 * deliberately, character for character in its rules. Both benches report into the
 * same QA Dashboard, which groups runs by this **string** — so a bench that says
 * `local` and a bench that says `Local` file the same environment under two rows.
 * Sharing the logic is what keeps one environment looking like one environment.
 *
 * Before this existed the UI bench sent `TEST_ENV` verbatim (defaulting to the
 * lowercase literal `local`), which meant the label was whatever a `.env` happened
 * to contain rather than a code from a known set.
 */

/** Host with its port, or the input unchanged when it is not a parseable URL. */
export function hostOf(baseURL: string): string {
  try {
    const url = new URL(baseURL);
    return url.port ? `${url.hostname}:${url.port}` : url.hostname;
  } catch {
    return baseURL;
  }
}

/**
 * The environment label. An explicit `TEST_ENV` always wins; otherwise the target
 * host is the only evidence available, and a wrong guess on a production URL is the
 * expensive one, so anything unrecognised is reported as Unknown rather than assumed
 * safe.
 *
 * `ENVIRONMENT` is accepted as an alias because CI systems commonly set that name
 * already.
 *
 * The override is normalised — `local`, `LOCAL` and `Local` are the same
 * environment, and only the canonical spelling reaches the dashboard. An override
 * that is not one of the four known codes is passed through unchanged: someone who
 * writes `TEST_ENV=perf-lab` means it, and silently rewriting it to Unknown would
 * lose more than it protects.
 */
export function environmentName(baseURL: string): string {
  const explicit = process.env.TEST_ENV ?? process.env.ENVIRONMENT;
  if (explicit !== undefined && explicit !== '') return canonicalise(explicit);

  const host = hostOf(baseURL).split(':')[0].toLowerCase();
  if (host === 'localhost' || host === '127.0.0.1' || host.startsWith('192.168.')) return 'Local';
  /*
   * `staging` is spelled out rather than covered by `stag`: there is no word boundary
   * between "stag" and "ing", so a `\b(stag|stg|uat)\b` pattern reports the commonest
   * form of all — `staging.host` — as Unknown.
   */
  if (/\b(stag|stage|staging|stg|uat)\b/.test(host)) return 'Staging';
  if (/\b(qa|test|dev)\b/.test(host)) return 'QA';
  if (/\b(prod|live)\b/.test(host)) return 'Production';
  return 'Unknown';
}

/** Maps common spellings of the four known codes onto their canonical form. */
function canonicalise(label: string): string {
  switch (label.trim().toLowerCase()) {
    case 'local':
      return 'Local';
    case 'qa':
    case 'test':
    case 'dev':
      return 'QA';
    case 'stage':
    case 'staging':
    case 'stg':
    case 'uat':
      return 'Staging';
    case 'prod':
    case 'production':
    case 'live':
      return 'Production';
    default:
      return label.trim();
  }
}
