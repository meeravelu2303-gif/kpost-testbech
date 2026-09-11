import { test } from '../src/fixtures/api.fixture';
import { readBody } from '../src/utils/apiAssertions';
import { buildLoginPayload } from '../src/api/payloads/auth.payload';
import { QA_CURRENT_PASSWORD } from '../src/api/payloads/profile.payload';

/**
 * One-off repair, run deliberately — never part of a suite.
 *
 * On 2026-09-11 `tests/profile/userProfile.spec.ts` test 9 aimed changePassword at the SHARED
 * session carrying the real current password. The route keys off the token, so it rotated the
 * bench's own credential to the builder's `confirmPassword` and `.env` stopped authenticating.
 * The cause is fixed (the builder no longer defaults to the real password); this puts the
 * account back.
 */
const ROTATED_TO = 'Qa@NewPassw0rd456';

test('restore the shared QA credential', async ({ authClient, profileClient }) => {
  const id = process.env.QA_KPOST_ID ?? '';

  const login = await authClient.userLogin(buildLoginPayload(id, ROTATED_TO));
  const { json } = await readBody(login);
  const token = (json as { accessToken?: string } | null)?.accessToken;
  if (!token) {
    // eslint-disable-next-line no-console
    console.log(`cannot log in with the rotated password — HTTP ${login.status()}; nothing to do`);
    return;
  }

  const restore = await profileClient.changePassword(
    { kpostID: id, oldPassword: ROTATED_TO, confirmPassword: QA_CURRENT_PASSWORD },
    { token }
  );
  const after = await readBody(restore);
  // eslint-disable-next-line no-console
  console.log(`restore: HTTP ${restore.status()} ${after.text.slice(0, 160)}`);

  const verify = await authClient.userLogin(buildLoginPayload(id, QA_CURRENT_PASSWORD));
  const v = await readBody(verify);
  // eslint-disable-next-line no-console
  console.log(
    `verify : HTTP ${verify.status()} ` +
      (/"accessToken"\s*:\s*"[A-Za-z0-9._-]{20,}/.test(v.text)
        ? 'TOKEN ISSUED — the .env password works again'
        : v.text.slice(0, 200))
  );
});
