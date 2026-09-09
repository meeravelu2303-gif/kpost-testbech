import { z } from 'zod';

/**
 * POST /v2/signupLogin/userLogin — the one Authentication V2 endpoint with a genuinely
 * structured response schema in swagger.json.
 */
export const userLoginResponseSchema = z
  .object({
    statusCode: z.number().optional(),
    status: z.enum(['Success', 'Failure']).optional(),
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
