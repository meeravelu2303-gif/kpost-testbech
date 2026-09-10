import { z } from 'zod';

/**
 * Zod contracts for the General Settings controller (`/generalSetting/**`).
 *
 * This tag is unusual in two ways that the schemas below encode deliberately:
 *
 * 1. The success envelope carries `msg`, not `message`, and the write endpoints return no
 *    `data` at all — `fontSetting` and the three notification writes answer with `msg` only.
 * 2. `changeTheme` returns the refreshed settings under a `changeTheme` key rather than
 *    `data`, so the client can repaint without a second round trip. Asserting on `data` for
 *    that endpoint would silently pass against an empty response.
 *
 * `status` is a plain string rather than the documented `Success|Failure` enum because the
 * live API emits UPPERCASE. That deviation is asserted once by a dedicated contract test.
 */

/** Envelope shared by the write endpoints: `msg` only, no `data`. */
export const generalSettingAckSchema = z
  .object({
    statusCode: z.number(),
    status: z.string(),
    msg: z.string().nullish(),
    message: z.string().nullish(),
    urlPath: z.string().nullish(),
  })
  .passthrough();

/** Envelope returned on 400/401/403/500 across the tag. */
export const generalSettingErrorSchema = z
  .object({
    status: z.string().optional(),
    statusCode: z.number().optional(),
    msg: z.string().nullish(),
    message: z.string().nullish(),
    urlPath: z.string().nullish(),
    debugMessage: z.string().nullish(),
  })
  .passthrough();

/** POST /generalSetting/fontSetting — success carries `msg` and no `data`. */
export const fontSettingResponseSchema = generalSettingAckSchema;

/** POST /generalSetting/kmailNotification | katchupNotification | kallNotification. */
export const notificationAckResponseSchema = generalSettingAckSchema;

/**
 * POST /generalSetting/changeTheme — the persisted settings come back under `changeTheme`,
 * which is why this is not just `generalSettingAckSchema`.
 */
export const changeThemeResponseSchema = generalSettingAckSchema.extend({
  changeTheme: z.union([z.record(z.string(), z.unknown()), z.null()]).optional(),
});

/**
 * The personalisation block: theme plus font preferences.
 *
 * Theme keys mirror the `changeTheme` request (Excel row 223) — the two routes share one
 * settings row, so the read-back names must be the names the write persists. `theme` /
 * `backGroundTheme` were listed here previously; neither exists in the contract.
 */
export const personalizeSettingsSchema = z
  .object({
    kpostID: z.string().nullish(),
    colourPalette: z.string().nullish(),
    nightModeEnable: z.union([z.string(), z.number(), z.boolean()]).nullish(),
    syncwithDeviceSetting: z.union([z.string(), z.number(), z.boolean()]).nullish(),
    scheduleTiming: z.string().nullish(),
    kpostLayoutTheme: z.string().nullish(),
    katchupChatStyle: z.string().nullish(),
    katchupChatTheme: z.string().nullish(),
    katchupChatBackgroundThemeWallpaper: z
      .union([z.string(), z.record(z.string(), z.unknown()), z.null()])
      .optional(),
    fontSize: z.union([z.string(), z.number()]).nullish(),
    fontStyle: z.string().nullish(),
  })
  .passthrough();

/** GET /generalSetting/getPersonalize */
export const getPersonalizeResponseSchema = z
  .object({
    statusCode: z.number(),
    status: z.string(),
    msg: z.string().nullish(),
    message: z.string().nullish(),
    urlPath: z.string().nullish(),
    data: z
      .union([personalizeSettingsSchema, z.array(personalizeSettingsSchema), z.null()])
      .optional(),
  })
  .passthrough();

/** Per-module notification switches as stored for the caller. */
export const notificationSettingsSchema = z
  .object({
    kpostID: z.string().nullish(),
    notificationStatus: z.union([z.string(), z.boolean()]).nullish(),
    sound: z.union([z.string(), z.boolean()]).nullish(),
    vibration: z.union([z.string(), z.boolean()]).nullish(),
    preview: z.union([z.string(), z.boolean()]).nullish(),
  })
  .passthrough();

/** GET /generalSetting/getAllNotification — the canonical read-back for the three writes. */
export const getAllNotificationResponseSchema = z
  .object({
    statusCode: z.number(),
    status: z.string(),
    msg: z.string().nullish(),
    message: z.string().nullish(),
    urlPath: z.string().nullish(),
    data: z
      .union([
        notificationSettingsSchema,
        z.array(notificationSettingsSchema),
        z.record(z.string(), z.unknown()),
        z.null(),
      ])
      .optional(),
  })
  .passthrough();

export type GeneralSettingAck = z.infer<typeof generalSettingAckSchema>;
export type PersonalizeSettings = z.infer<typeof personalizeSettingsSchema>;
export type NotificationSettings = z.infer<typeof notificationSettingsSchema>;
