/**
 * Bootstrap seeding script for an empty test database.
 *
 *   npm run seed
 *
 * Registers one throwaway user, logs in, and persists the resulting access token into `.env`
 * as `QA_AUTH_TOKEN`. Every suite then picks it up through `authSession.ts` without any
 * further configuration, which turns the authorisation, IDOR and cross-tenant assertions
 * across all modules from "not granted" into a real verdict.
 *
 * Route names differ from the ones in the seeding brief: this API has no `/v2/auth/**` tree.
 * Sign-up and login live under `/v2/signupLogin/**`, and OTP under `/v2/common/**`, so those
 * are used here. `SEED_STEPS` below is the single place to adjust if the API moves.
 *
 * The script is deliberately tolerant: each step reports what happened and the run continues
 * far enough to explain *why* a token could not be minted, because on this environment the
 * usual blocker is the backend's own sign-up validation rather than anything in the script.
 */
import fs from 'fs';
import path from 'path';
import { request as playwrightRequest, APIRequestContext, APIResponse } from '@playwright/test';
import { env, MOCK_OTP_CANDIDATES } from '../config/env.config';
import { buildLoginPayload, buildSignupPayload } from '../api/payloads/auth.payload';

const ENV_PATH = path.resolve(__dirname, '../../.env');

/**
 * A well-formed Indian mobile number in a block that should not be allocated. TEST_MOBILE is
 * rate-limited after three sends, and a faker-generated number is a live subscriber, so
 * neither is usable for repeated seeding attempts.
 */
function syntheticMobile(): string {
  return '9000000' + String(100 + Math.floor(Math.random() * 900));
}

const SEED_STEPS = {
  mobileNoExist: '/v2/common/mobileNoExist',
  sendOTP: '/v2/common/sendOTP',
  validateOTP: '/v2/common/validateOTP',
  signup: '/v2/signupLogin/signup',
  userLogin: '/v2/signupLogin/userLogin',
  verify: '/v2/profile/getUserProfile',
} as const;

interface StepOutcome {
  step: string;
  status: number | string;
  detail: string;
}

const outcomes: StepOutcome[] = [];

function record(step: string, status: number | string, detail: string): void {
  outcomes.push({ step, status, detail });
  const marker = typeof status === 'number' && status < 400 ? 'ok  ' : 'FAIL';
  console.log(`  [${marker}] ${step} -> ${status}  ${detail}`);
}

function snippet(value: string, max = 160): string {
  const collapsed = value.replace(/\s+/g, ' ').trim();
  return collapsed.length <= max ? collapsed : `${collapsed.slice(0, max)}…`;
}

async function describe(response: APIResponse): Promise<string> {
  try {
    return snippet(await response.text());
  } catch {
    return '<unreadable body>';
  }
}

/** Extracts an access token from any of the shapes the login route has been seen to use. */
function extractAccessToken(raw: string): string | null {
  try {
    const parsed = JSON.parse(raw) as Record<string, unknown>;
    const data = (parsed.data ?? {}) as Record<string, unknown>;
    const candidate =
      (typeof parsed.accessToken === 'string' && parsed.accessToken) ||
      (typeof data.accessToken === 'string' && data.accessToken) ||
      null;
    return candidate || null;
  } catch {
    return null;
  }
}

/**
 * Writes `QA_AUTH_TOKEN` into `.env`, replacing any existing value and leaving every other
 * line untouched. `.env` is gitignored, so the token never reaches version control.
 */
function persistToken(token: string): void {
  const line = `QA_AUTH_TOKEN=${token}`;
  let contents = '';

  try {
    contents = fs.readFileSync(ENV_PATH, 'utf-8');
  } catch {
    contents = '';
  }

  const updated = /^QA_AUTH_TOKEN=.*$/m.test(contents)
    ? contents.replace(/^QA_AUTH_TOKEN=.*$/m, line)
    : `${contents.trimEnd()}\n${line}\n`;

  fs.writeFileSync(ENV_PATH, updated, 'utf-8');
}

/**
 * Steps 1-3 of the documented registration pipeline: confirm the number is free, send the
 * OTP, then validate it.
 *
 * `validateOTP` requires `sendDate` (epoch millis of the send) — that field is absent from
 * swagger.json and only appears in the functional document, so omitting it fails validation
 * for reasons the error message does not explain.
 *
 * The OTP itself is a random 6-digit code delivered by SMS, so `TEST_MOCK_OTP` only works on
 * an environment configured to short-circuit it. The candidates are tried and each rejection
 * recorded rather than assumed.
 */
async function clearOtpGate(api: APIRequestContext, mobileNumber: string): Promise<boolean> {
  const existsResponse = await api.post(SEED_STEPS.mobileNoExist, {
    headers: { 'Content-Type': 'application/json' },
    data: { countryID: env.testCountryId, mobileNumber },
  });
  record('mobileNoExist', existsResponse.status(), await describe(existsResponse));

  const sendDate = Date.now();
  const sendResponse = await api.post(SEED_STEPS.sendOTP, {
    headers: { 'Content-Type': 'application/json' },
    // The document uses the lowercase word "signup" here; this is unrelated to
    // LoginRO.requestType, which is a different field with a different enum.
    data: { countryID: env.testCountryId, mobileNumber, requestType: 'signup' },
  });
  record('sendOTP', sendResponse.status(), await describe(sendResponse));

  if (sendResponse.status() >= 400) return false;

  for (const otp of MOCK_OTP_CANDIDATES) {
    const validateResponse = await api.post(SEED_STEPS.validateOTP, {
      headers: { 'Content-Type': 'application/json' },
      data: { otp, countryID: env.testCountryId, mobileNumber, sendDate },
    });
    const body = await describe(validateResponse);

    let accepted = false;
    try {
      accepted =
        validateResponse.status() === 200 &&
        (JSON.parse(await validateResponse.text()) as Record<string, unknown>).statusCode === 200;
    } catch {
      accepted = false;
    }

    if (accepted) {
      record(`validateOTP (${otp})`, validateResponse.status(), 'accepted');
      return true;
    }
    record(`validateOTP (${otp})`, validateResponse.status(), body);
  }

  return false;
}

export async function seedUser(): Promise<number> {
  console.log(`\nSeeding a test user against ${env.baseURL}\n`);

  const api = await playwrightRequest.newContext({
    baseURL: env.baseURL,
    timeout: env.apiTimeout,
    ignoreHTTPSErrors: true,
  });

  try {
    const signupPayload = buildSignupPayload({ mobileNumber: syntheticMobile() });

    // Steps 1-2: OTP gate. A failure here is not fatal — some environments do not gate
    // sign-up behind OTP at all, so the attempt is recorded and the run continues.
    await clearOtpGate(api, signupPayload.mobileNumber);

    // Step 3: register.
    const signupResponse = await api.post(SEED_STEPS.signup, {
      headers: { 'Content-Type': 'application/json' },
      data: signupPayload,
    });
    record(`signup (${signupPayload.kpostID})`, signupResponse.status(), await describe(signupResponse));

    // Step 4: log in. Attempted even if sign-up reported a failure, because the account may
    // already exist from a previous run.
    const loginResponse = await api.post(SEED_STEPS.userLogin, {
      headers: { 'Content-Type': 'application/json' },
      data: buildLoginPayload(signupPayload.kpostID, signupPayload.password),
    });
    const loginBody = await loginResponse.text();
    record('userLogin', loginResponse.status(), snippet(loginBody));

    const token = extractAccessToken(loginBody);
    if (!token) {
      console.log('\nNo access token was issued, so .env was left unchanged.\n');
      console.log('Summary of attempts:');
      for (const outcome of outcomes) {
        console.log(`  - ${outcome.step}: ${outcome.status} :: ${outcome.detail}`);
      }
      console.log(
        [
          '',
          'Sign-up now passes validation but fails inside the service. Established by probing:',
          '',
          '  1. The OTP gate is not the blocker. A fresh number gets a clean sendOTP success.',
          '     (TEST_MOBILE itself is rate-limited: HTTP 200 with status=FAILURE and',
          '     "Try after 24 Hours, OTP sent more than 3 times".) The mock codes are not',
          '     honoured — validateOTP answers HTTP 500 "OTP validation failed" for 123456,',
          '     000000 and 1234 — but signup behaves identically with or without that step.',
          '',
          '  2. The payload shape below is the one that clears bean validation, and it is not',
          '     derivable from swagger.json: the domain rides inline on the kpostID',
          '     ("handle@kpostindia.com"), countryCode is "91" not "+91", userType is UPPERCASE,',
          '     gender is lowercase, and a nested userProfile object must be present. Supplying',
          '     the domain separately as domainID is rejected however it is expressed — numeric',
          '     29, "29", "@kpostindia.com", "kpostindia.com", or omitted.',
          '',
          '     Note the error message that guards this is actively misleading: "kpostID must',
          '     start with a letter or Invalid kpostID" fires when domainID is absent or',
          '     non-string, and says nothing about the kpostID.',
          '',
          '  3. THE BLOCKER: with that shape, signup answers HTTP 200 carrying',
          '     {"status":"error","statusCode":500,"data":"Not Applicable"} — a server-side',
          '     failure masked behind a success transport status. Adding module, activeStatus,',
          '     domainID, otp or createdBy does not change it.',
          '',
          '  4. Login is FIXED. The earlier "Invalid officeType" (HTTP 400) was our own payload',
          '     bug: requestType must match LoginRO\'s pattern ^(Admin|User|SubAdmin)$ and the',
          '     builder was sending "LOGIN". The API reports that violation under the name of a',
          '     different field entirely — officeType belongs to UserProfile and is not part of',
          '     the login DTO — which is why it read as a backend fault. With requestType="User"',
          '     login reaches credential validation and answers "Invalid Credential", i.e. it is',
          '     working and simply has no account to authenticate.',
          '',
          '  5. The business path is blocked too. Business accounts register through',
          '     /v2/signupLogin/adminRegistration, not /signup. That route rejects every attempt',
          '     with "Invalid maximumMembersCount for userType"; BUSINESS, ENTERPRISES,',
          '     INSTITUTION and GOVERNMENT were each tried against 10/50/100/500/1000 members and',
          '     all were refused. The permitted pairings are not in the schema, so the rule',
          '     cannot be satisfied from the client.',
          '',
          'So login works and both registration paths fail server-side. Personal signup reaches',
          'its service and throws; business registration is gated on an undocumented tier rule.',
          'Supplying QA_AUTH_TOKEN, or QA_KPOST_ID/QA_PASSWORD for any existing account, now',
          'unblocks the whole suite — the login path itself is no longer the obstacle.',
          '',
          'To unblock the authorisation coverage now, use an account that already exists:',
          '',
          '    QA_AUTH_TOKEN=<access token>        # preferred',
          '    QA_KPOST_ID=<id>                    # or these two, and authSession.ts will',
          '    QA_PASSWORD=<password>              # mint the token itself each run',
          '',
          'Either route activates the IDOR, privilege-escalation and cross-tenant assertions',
          'across every module, which currently record "not granted" without proving the check',
          'exists.',
          '',
        ].join('\n')
      );
      return 1;
    }

    // Step 5: confirm the backend actually honours the token before writing it anywhere.
    const verifyResponse = await api.get(SEED_STEPS.verify, {
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    });
    record('verify token', verifyResponse.status(), await describe(verifyResponse));

    if (verifyResponse.status() !== 200) {
      console.log(
        '\nA token was issued but the backend did not accept it on a protected route, so it was not written to .env.\n'
      );
      return 1;
    }

    persistToken(token);
    console.log(`\nQA_AUTH_TOKEN written to .env for "${signupPayload.kpostID}".`);
    console.log('Every suite now runs authenticated; re-run npm test to get real authorisation verdicts.\n');
    return 0;
  } finally {
    await api.dispose();
  }
}

/** Every step attempted, for a caller that wants to report on the run. */
export function seedOutcomes(): ReadonlyArray<StepOutcome> {
  return outcomes;
}
