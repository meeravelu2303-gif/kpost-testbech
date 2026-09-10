import { z } from 'zod';

/**
 * POST /v2/signupLogin/userLogin — the one Authentication V2 endpoint with a genuinely
 * structured response schema in swagger.json.
 */
export const userLoginResponseSchema = z
  .object({
    statusCode: z.number().optional(),
    /*
     * `z.string()`, not the documented enum. The server answers `SUCCESS`/`FAILURE` in upper
     * case where swagger documents `Success`/`Failure` — a real but *already-covered* deviation:
     * `strictDocumentedEnvelopeSchema` asserts it once in the dedicated envelope-contract test.
     * Re-asserting it here made every login-envelope check fail on that same known fault, which
     * is a second ticket for one defect.
     */
    status: z.string().optional(),
    message: z.string().nullish(),
    urlPath: z.string().optional(),
    accessToken: z.string().nullish(),
    refreshToken: z.string().nullish(),
    isFirstTimeLogin: z.boolean().nullish(),
    isPrimaryDevice: z.boolean().nullish(),
    isSecondaryDeviceFirstTimeLogin: z.boolean().nullish(),
    isSecondaryDevice: z.boolean().nullish(),
    data: z.unknown().optional(),
    changeTheme: z.unknown().optional(),
  })
  .passthrough();

export type UserLoginResponse = z.infer<typeof userLoginResponseSchema>;

export const activeSessionListSchema = z.array(z.unknown());
