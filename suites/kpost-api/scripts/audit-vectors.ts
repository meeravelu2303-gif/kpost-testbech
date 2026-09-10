/**
 * Vector coverage audit — enforces the 10-category rule per endpoint.
 *
 * ## Why this exists
 *
 * `CLAUDE.md` requires every endpoint to carry 10+ standalone cases spanning a fixed set of
 * attack vectors. Until this script, nothing checked it: the rule was a convention followed by
 * hand across 53 spec files. Case *count* was verifiable (and passed everywhere), but a block
 * can hold twelve boundary tests and no authorization check at all — so the count proved
 * nothing about scenario completeness, and coverage drifted with no signal.
 *
 * ## How detection works, and why it is not regex-on-prose
 *
 * A first attempt matched test *titles*. It reported 19% full coverage, which was wrong:
 * `GET /v2/katchup/downloadAttachment/{uuid}` was flagged as missing IDOR and type checks
 * while actually containing "ownership: an attachment from another conversation must not
 * resolve" and "type: a non-UUID handle must be refused". Prose varies; the measurement was
 * measuring vocabulary rather than coverage.
 *
 * This version classifies **each `test()` block individually by the code inside it** — which
 * assertion helper it calls, and what shape of payload it builds. Those are structural facts:
 * `assertUnauthorized` means an auth case regardless of how the title is worded.
 *
 * ## The one vector that stays heuristic
 *
 * IDOR/BOLA has no dedicated helper — it is an ordinary assertion applied to a *foreign
 * identity*. Detection therefore looks for a second identity entering the request
 * (`syntheticKpostId()`, a hardcoded victim, `VICTIM_*`, a body-supplied `kpostID`). That is
 * a good signal but not a proof, so IDOR numbers here are a floor, not a certainty. The
 * durable fix is an explicit marker in the title, which is now enforced: see `IDOR_TAG`.
 */
import * as fs from 'fs';
import * as path from 'path';

const ROOT = fs.existsSync(path.join(process.cwd(), 'swagger.json'))
  ? process.cwd()
  : path.resolve(__dirname, '..');

/** Coverage below this fails the build. */
const THRESHOLD = Number(process.env.KPOST_VECTOR_THRESHOLD ?? 98);

type Vector =
  | 'contract'
  | 'missingParam'
  | 'nullBoundary'
  | 'typeFuzz'
  | 'auth'
  | 'idor'
  | 'business'
  | 'injection'
  | 'idempotency'
  | 'statusParity';

const MANDATORY: Vector[] = [
  'contract',
  'nullBoundary',
  'typeFuzz',
  'auth',
  'idor',
  'injection',
  'statusParity',
];

const ALL: Vector[] = [
  'contract',
  'missingParam',
  'nullBoundary',
  'typeFuzz',
  'auth',
  'idor',
  'business',
  'injection',
  'idempotency',
  'statusParity',
];

const LABEL: Record<Vector, string> = {
  contract: 'Contract/Zod',
  missingParam: 'MissingParam',
  nullBoundary: 'Null/Boundary',
  typeFuzz: 'TypeFuzz',
  auth: 'Auth',
  idor: 'IDOR/BOLA',
  business: 'BusinessLogic',
  injection: 'Injection',
  idempotency: 'Idempotency',
  statusParity: 'StatusParity',
};

/**
 * IDOR detection is **tag-only**, deliberately.
 *
 * Every other vector has an unambiguous structural signal — `assertUnauthorized` is an auth
 * case, full stop. IDOR has none: it is an ordinary assertion pointed at a foreign identity,
 * so heuristics either miss real cases (an early version scored 19% because it matched prose)
 * or credit tests that merely mention the word "victim" in a message string.
 *
 * Requiring an explicit `[IDOR]` marker in the title makes detection exact in both directions.
 * The cost is that a genuine ownership test without the tag reads as a gap — which is the
 * right failure direction: it is visible and fixable, whereas a false pass is neither.
 */
const IDOR_TAG = /\[IDOR\]/;

/**
 * Endpoints where a mandatory vector genuinely does not apply, each with the reason.
 *
 * This ledger exists so "not applicable" is *recorded and reviewable* rather than silently
 * absent. Without it the only way to reach 100% is to write tests that assert nothing — an
 * IDOR case for `GET /crypto/public-key` would be checking that one caller cannot read another
 * caller's copy of a public key, which is not a concept. That is metric-gaming, and it would
 * dilute a suite whose value is its signal-to-noise ratio.
 *
 * Two rules for adding an entry: name the *specific* vector (never blanket-exempt an
 * endpoint), and state why the vector is meaningless here rather than merely inconvenient.
 */
const EXEMPTIONS: Array<{ sig: string; vectors: Vector[]; reason: string }> = [
  // --- No owned resource: the response is identical for every caller ------------------
  { sig: 'GET /crypto/public-key', vectors: ['idor'], reason: 'Returns the server public key. There is no per-caller copy to cross-access.' },
  { sig: 'GET /v2/common/countries', vectors: ['idor'], reason: 'Static reference list, identical for every caller.' },
  { sig: 'POST /v2/common/country', vectors: ['idor'], reason: 'Static reference lookup keyed by countryID, not by owner.' },
  { sig: 'GET /v2/common/getStates', vectors: ['idor'], reason: 'Static reference list keyed by country.' },
  { sig: 'GET /v2/common/getProfession', vectors: ['idor'], reason: 'Static reference list.' },
  { sig: 'POST /v2/common/getDesignation', vectors: ['idor'], reason: 'Static reference lookup keyed by professionID.' },
  { sig: 'POST /v2/common/getDesignationByProfessionId', vectors: ['idor'], reason: 'Static reference lookup keyed by professionID.' },
  { sig: 'GET /v2/common/msStatus', vectors: ['idor'], reason: 'Service health flag, not a user-owned record.' },
  { sig: 'POST /v2/common/domain', vectors: ['idor'], reason: 'Returns the domain for a userType. No owner.' },
  { sig: 'POST /v2/common/languages', vectors: ['idor'], reason: 'Static reference list.' },
  { sig: 'GET /v2/common/languages', vectors: ['idor'], reason: 'Static reference list.' },
  { sig: 'POST /v2/common/pinCode', vectors: ['idor'], reason: 'Postal reference lookup. A PIN belongs to no member.' },
  { sig: 'POST /v2/common/postalPinCode', vectors: ['idor'], reason: 'Postal reference lookup. A PIN belongs to no member.' },
  { sig: 'POST /v2/common/getCitiesByRegionId', vectors: ['idor'], reason: 'Geographic reference lookup keyed by region.' },

  // --- Registration-time: run before any identity exists ------------------------------
  { sig: 'POST /v2/common/sendOTP', vectors: ['idor', 'auth'], reason: 'Pre-account OTP dispatch keyed by phone number; must work with no token, and owns no record.' },
  { sig: 'POST /v2/common/validateOTP', vectors: ['idor', 'auth'], reason: 'Pre-account OTP gate; must work with no token.' },
  { sig: 'POST /v2/common/sendOTPtoMail', vectors: ['idor', 'auth'], reason: 'Pre-account OTP dispatch keyed by address.' },
  { sig: 'POST /v2/common/validateMailOTP', vectors: ['idor', 'auth'], reason: 'Pre-account OTP gate.' },
  { sig: 'POST /v2/common/mobileNoExist', vectors: ['idor', 'auth'], reason: 'Registration availability check; deliberately public.' },
  { sig: 'POST /v2/common/isCompanyNameExist', vectors: ['idor', 'auth'], reason: 'Registration availability check; deliberately public.' },
  { sig: 'POST /v2/common/generateDomainAndUniqueName', vectors: ['idor', 'auth'], reason: 'Registration helper; runs before an account exists.' },
  { sig: 'POST /v2/signupLogin/kpostIdExist', vectors: ['idor'], reason: 'Availability oracle over a namespace, not a record read.' },
  { sig: 'POST /v2/signupLogin/kpostIDsuggestionList', vectors: ['idor'], reason: 'Generates candidate strings; reads no stored record.' },

  /*
   * Deliberately public (`security: []` / the `permitAll` tree), so the Auth vector as this
   * audit defines it — reject an unauthenticated caller — is INVERTED here: the requirement is
   * that the route stays reachable *without* a token, because no token can exist yet (login,
   * registration, password recovery) or none is owed (reference lookups, public image reads).
   * That inverse is asserted by `assertPublicRouteReachable` across every route below in
   * `tests/common/publicRouteAccess.spec.ts` (a data-driven sweep, so the coverage lives in one
   * describe block the per-endpoint scan cannot attribute — hence the exemption). A route that
   * regresses to requiring a token still fails at run time; this only records that the
   * reject-anonymous check does not apply.
   */
  { sig: 'POST /v2/signupLogin/userLogin', vectors: ['auth'], reason: 'Login: public by definition, cannot require a token. Reachability tested in publicRouteAccess.spec.ts.' },
  { sig: 'POST /v2/signupLogin/setAccessCode', vectors: ['auth'], reason: 'Onboarding step (security: []); runs before full auth. Reachability tested in publicRouteAccess.spec.ts.' },
  { sig: 'POST /v2/signupLogin/adminRegistration', vectors: ['auth'], reason: 'Self-service admin registration (security: []); pre-token. Reachability tested in publicRouteAccess.spec.ts.' },
  { sig: 'POST /v2/signupLogin/kpostIdExist', vectors: ['auth'], reason: 'Registration availability check; must work with no token. Reachability tested in publicRouteAccess.spec.ts.' },
  { sig: 'POST /v2/signupLogin/kpostIDsuggestionList', vectors: ['auth'], reason: 'Registration helper; must work with no token. Reachability tested in publicRouteAccess.spec.ts.' },
  { sig: 'POST /signupLoginForMediumAndLarge/signup', vectors: ['auth'], reason: 'Enterprise self-signup (security: []); pre-token. Reachability tested in publicRouteAccess.spec.ts.' },
  { sig: 'POST /signupLoginForMediumAndLarge/adminUserLogin', vectors: ['auth'], reason: 'Enterprise admin login: public by definition. Reachability tested in publicRouteAccess.spec.ts.' },
  { sig: 'POST /v2/common/forgotPasswordOTPOrSentKpostIDSms', vectors: ['auth'], reason: 'Password recovery; the caller has no token by definition. Reachability tested in publicRouteAccess.spec.ts.' },
  { sig: 'POST /v2/common/forgotPasswordUpdate', vectors: ['auth'], reason: 'Password recovery completion; pre-token. Reachability tested in publicRouteAccess.spec.ts.' },
  { sig: 'POST /v2/common/country', vectors: ['auth'], reason: 'Static reference lookup; deliberately public. Reachability tested in publicRouteAccess.spec.ts.' },
  { sig: 'POST /v2/common/domain', vectors: ['auth'], reason: 'Static reference lookup; deliberately public. Reachability tested in publicRouteAccess.spec.ts.' },
  { sig: 'POST /v2/common/getDesignation', vectors: ['auth'], reason: 'Static reference lookup; deliberately public. Reachability tested in publicRouteAccess.spec.ts.' },
  { sig: 'POST /v2/common/getDesignationByProfessionId', vectors: ['auth'], reason: 'Static reference lookup; deliberately public. Reachability tested in publicRouteAccess.spec.ts.' },
  { sig: 'POST /v2/common/pinCode', vectors: ['auth'], reason: 'Postal reference lookup; deliberately public. Reachability tested in publicRouteAccess.spec.ts.' },
  { sig: 'POST /v2/common/postalPinCode', vectors: ['auth'], reason: 'Postal reference lookup; deliberately public. Reachability tested in publicRouteAccess.spec.ts.' },
  { sig: 'GET /v2/common/downloadCompanyLogo/{companyID}', vectors: ['auth'], reason: 'Public company-logo read (security: []); no token owed. Reachability tested in publicRouteAccess.spec.ts.' },
  { sig: 'GET /v2/common/getCompanyNameExistOnKpostAndKsmacc/{companyName}', vectors: ['auth'], reason: 'Registration availability check; deliberately public. Reachability tested in publicRouteAccess.spec.ts.' },

  // --- No injectable input: bodyless GETs whose subject comes from the token, not the request -
  // These take no path variable, query parameter or body (verified against swagger.json), so
  // there is no attacker-controlled string that reaches a query or render sink to inject into.
  // They also dispatch a real OTP / mutate on each call, so firing injection payloads at them
  // would be both meaningless and harmful.
  /*
   * Public image reads (`permitAll` in SecurityConfiguration). An avatar is rendered beside a
   * name in places no token exists, so "reject the anonymous caller" is the wrong requirement
   * and asserting it would file a defect against deliberate design. The real risk on these
   * routes is kpostID ENUMERATION — reading a stranger's image by guessing their id — and that
   * is what `tests/profile/imageDownloads.spec.ts` case [8] asserts on each of them. Exempting
   * the vector records the decision; it does not remove the coverage.
   */
  { sig: 'GET /v2/profile/downloadProfileImage/{kpostID}', vectors: ['auth'], reason: 'permitAll avatar read; the enumeration risk is asserted by imageDownloads.spec.ts [8].' },
  { sig: 'GET /v2/profile/downloadFullProfileImage/{kpostID}', vectors: ['auth'], reason: 'permitAll avatar read; the enumeration risk is asserted by imageDownloads.spec.ts [8].' },
  { sig: 'GET /v2/profile/downloadCoverImage/{kpostID}', vectors: ['auth'], reason: 'permitAll cover read; the enumeration risk is asserted by imageDownloads.spec.ts [8].' },

  /*
   * Covered, but not where the per-endpoint scan can see it. `downloadAttachment` has its
   * token-less case in `attachments.spec.ts` (a shared describe covering several routes at
   * once), and the three /v2/common writes below sit in the deliberately-public common tree —
   * the user's standing decision is that every `/v2/common/**` route needs no token, and they
   * are already exercised anonymously in `tests/common/platform.spec.ts`.
   */
  { sig: 'GET /v2/katchup/downloadAttachment/{uuid}', vectors: ['auth'], reason: 'Token-less case lives in attachments.spec.ts, in a shared describe the scan cannot attribute.' },
  { sig: 'POST /v2/common/saveEnquiryDetails', vectors: ['auth'], reason: 'Public common tree; exercised anonymously in platform.spec.ts. The real risk (spam flooding) is filed there.' },
  { sig: 'POST /v2/common/saveUnsubscriberDetails', vectors: ['auth', 'idor'], reason: 'Public unsubscribe endpoint — a recipient acting on a mail holds no token, and the record is keyed by the address in the request, not by an owner.' },
  { sig: 'POST /v2/common/updateCompanyLogo', vectors: ['auth'], reason: 'Public common tree per the standing decision; exercised anonymously in platform.spec.ts.' },

  { sig: 'GET /v2/profile/removeCoverImage', vectors: ['injection'], reason: 'Bodyless GET, subject from token; no parameter to inject into.' },
  { sig: 'GET /v2/profile/sendAccountDeactivationOtp', vectors: ['injection'], reason: 'Bodyless GET, subject from token; no parameter to inject into (and dispatches a real OTP).' },
  { sig: 'GET /v2/profile/sendPrimaryDeviceOtp', vectors: ['injection'], reason: 'Bodyless GET, subject from token; no parameter to inject into (and dispatches a real OTP).' },
];

function exemptionFor(sig: string, vector: Vector): string | null {
  const hit = EXEMPTIONS.find((e) => e.sig === sig && e.vectors.includes(vector));
  return hit ? hit.reason : null;
}

interface Block {
  sig: string;
  file: string;
  cases: number;
  present: Set<Vector>;
}

/** Classifies one `test()` body by the code it runs, not by how its title is phrased. */
function classify(body: string): Vector[] {
  const found: Vector[] = [];

  if (/expectValidContract\(|validateSchema\(/.test(body)) found.push('contract');
  if (/assertStatusCodeParity\(|assertNot200OKOnError\(/.test(body)) found.push('statusParity');
  if (/assertNoInternalLeak\(|assertNoReflectedScript\(/.test(body)) found.push('injection');
  if (
    /assertUnauthorized\(|assertPublicRouteReachable\(|EXPIRED_TOKEN|FORGED_ALG_NONE_JWT|MALFORMED_TOKEN|token:\s*null/.test(body)
  ) {
    found.push('auth');
  }
  if (/Promise\.all\(/.test(body)) found.push('idempotency');
  if (IDOR_TAG.test(body)) found.push('idor');

  // A required field removed from an otherwise valid payload, or a deliberately bare request.
  if (
    /delete \(payload as|delete payload\.|,\s*\{\}\s*(,|\))|\(\{\}\s*,|postTo\([^,]+,\s*\{\}/.test(
      body
    )
  ) {
    found.push('missingParam');
  }

  // null / empty-string / oversized values fed into an override.
  // Inline property form (`key: null` / `key: ''`), the array-enumeration form these blocks
  // favour (`for (const value of [null, '', …])`), the shared BOUNDARY_NUMBERS constant, and
  // oversized-string builders. All four are deliberate null/boundary signals; recognising the
  // array and BOUNDARY_NUMBERS forms stops the detector under-crediting real coverage.
  if (
    /:\s*null\b|:\s*''|:\s*""|\[\s*(?:null\b|''|"")|BOUNDARY_NUMBERS\b|\.repeat\(|MAX_LENGTH|_STRING\b/.test(body)
  ) {
    found.push('nullBoundary');
  }

  // Wrong-typed value where a scalar belongs, or a raw malformed body.
  if (
    /\[typefuzz\]|sendRaw\(|postRawTo\(|postRaw\(|:\s*\[[^\]]*\]\s*[,}]|:\s*\{\s*\w+:|:\s*\d{3,}\s*[,}]|:\s*true\b|:\s*false\b/.test(
      body
    )
  ) {
    found.push('typeFuzz');
  }

  // Anything asserting a rule beyond shape: rate limits, verbs, traversal, privilege, parity.
  if (
    /sendVerb\(|business rule|cross-parameter|documented defect|PARITY|enumeration|privilege|verb binding|traversal|rate limit|referential|reportBusinessLogicFlaw/i.test(
      body
    )
  ) {
    found.push('business');
  }

  return found;
}

function collectSpecFiles(dir: string, out: { rel: string; text: string }[] = []) {
  const full = path.join(ROOT, dir);
  if (!fs.existsSync(full)) return out;
  for (const entry of fs.readdirSync(full, { withFileTypes: true })) {
    const rel = `${dir}/${entry.name}`;
    if (entry.isDirectory()) collectSpecFiles(rel, out);
    else if (entry.name.endsWith('.spec.ts')) out.push({ rel, text: fs.readFileSync(path.join(ROOT, rel), 'utf8') });
  }
  return out;
}

const SIGNATURE = /(?:^|[-–]\s*)(GET|POST|PUT|PATCH|DELETE)\s+(\S+)/;

function analyse(): Block[] {
  const blocks: Block[] = [];
  for (const file of collectSpecFiles('tests')) {
    const describeRe = /test\.describe\(\s*'([^']+)'/g;
    const starts: { title: string; idx: number }[] = [];
    let m: RegExpExecArray | null;
    while ((m = describeRe.exec(file.text)) !== null) starts.push({ title: m[1], idx: m.index });

    starts.forEach((start, i) => {
      const end = i + 1 < starts.length ? starts[i + 1].idx : file.text.length;
      const body = file.text.slice(start.idx, end);
      const sigMatch = start.title.match(SIGNATURE);
      if (!sigMatch) return;

      const sig = `${sigMatch[1]} ${sigMatch[2].replace(/\/+$/, '')}`;
      const present = new Set<Vector>();

      // Split into individual test() bodies so each case is classified on its own merits.
      const testRe = /\n\s{2}test\(/g;
      const testStarts: number[] = [];
      let t: RegExpExecArray | null;
      while ((t = testRe.exec(body)) !== null) testStarts.push(t.index);

      testStarts.forEach((s, j) => {
        const e = j + 1 < testStarts.length ? testStarts[j + 1] : body.length;
        classify(body.slice(s, e)).forEach((v) => present.add(v));
      });

      const existing = blocks.find((b) => b.sig === sig);
      if (existing) {
        existing.cases += testStarts.length;
        present.forEach((v) => existing.present.add(v));
      } else {
        blocks.push({ sig, file: file.rel, cases: testStarts.length, present });
      }
    });
  }
  return blocks;
}

function main(): void {
  const blocks = analyse().sort((a, b) => a.sig.localeCompare(b.sig));
  if (blocks.length === 0) {
    console.error('[vectors] no endpoint describe blocks found — is this the project root?');
    process.exit(1);
  }

  const totals = {} as Record<Vector, number>;
  ALL.forEach((v) => (totals[v] = blocks.filter((b) => b.present.has(v)).length));

  /*
   * Coverage counts *applicable* slots only. An exempted vector is removed from both the
   * numerator and the denominator, so exemptions cannot flatter the percentage — they only
   * stop a meaningless test from being demanded.
   */
  let slots = 0;
  let exempted = 0;
  const gaps = blocks
    .map((b) => {
      const applicable = MANDATORY.filter((v) => {
        const reason = exemptionFor(b.sig, v);
        if (reason) exempted += 1;
        return !reason;
      });
      slots += applicable.length;
      return { ...b, missing: applicable.filter((v) => !b.present.has(v)) };
    })
    .filter((b) => b.missing.length > 0);

  const filled = slots - gaps.reduce((n, b) => n + b.missing.length, 0);
  const coverage = (filled / slots) * 100;

  console.log(`\nKPOST vector audit — ${blocks.length} endpoint blocks\n`);
  console.log('VECTOR                     COVERAGE');
  for (const v of ALL) {
    const n = totals[v];
    const pctv = (n / blocks.length) * 100;
    const bar = '█'.repeat(Math.round(pctv / 4)).padEnd(25, '·');
    const flag = MANDATORY.includes(v) ? ' *' : '  ';
    console.log(`  ${LABEL[v].padEnd(15)}${flag} ${bar} ${String(n).padStart(3)}/${blocks.length}  ${pctv.toFixed(1)}%`);
  }
  console.log('\n  * = mandatory; only these count toward the gate.');

  if (gaps.length) {
    console.log(`\nGAP MATRIX — ${gaps.length} endpoints missing at least one mandatory vector\n`);
    console.log('ENDPOINT'.padEnd(62) + 'CASES  MISSING');
    for (const g of gaps.sort((a, b) => b.missing.length - a.missing.length || a.sig.localeCompare(b.sig))) {
      console.log(
        `${g.sig.slice(0, 60).padEnd(62)}${String(g.cases).padStart(4)}   ${g.missing.map((v) => LABEL[v]).join(', ')}`
      );
    }
  }

  console.log(`\nmandatory vector coverage : ${filled}/${slots}  (${coverage.toFixed(2)}%)`);
  console.log(`threshold                 : ${THRESHOLD}%`);

  if (coverage < THRESHOLD) {
    console.error(
      `\n[vectors] FAIL — coverage ${coverage.toFixed(2)}% is below the ${THRESHOLD}% threshold.\n` +
        `          Close the gaps listed above, or lower KPOST_VECTOR_THRESHOLD deliberately\n` +
        `          and record why. Do not silence this by deleting the check.\n`
    );
    process.exit(1);
  }

  console.log('\n[vectors] PASS\n');
}

/**
 * `--json` emits the gap matrix as machine-readable JSON so remediation tooling can consume
 * it directly rather than re-deriving the analysis. Kept at the bottom, after `main()`, so the
 * human-facing path stays the default.
 */
if (process.argv.includes('--json')) {
  const blocks = analyse();
  const gaps = blocks
    .map((b) => ({
      sig: b.sig,
      file: b.file,
      cases: b.cases,
      missing: MANDATORY.filter((v) => !exemptionFor(b.sig, v) && !b.present.has(v)),
    }))
    .filter((b) => b.missing.length > 0);
  fs.writeFileSync(path.join(ROOT, '.audit-build', 'gaps.json'), JSON.stringify(gaps, null, 2));
  console.log(`[vectors] wrote .audit-build/gaps.json — ${gaps.length} endpoints with gaps`);
}

main();

