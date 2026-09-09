import { qaLabel } from '../../utils/safeTestData';

/**
 * Request builders for the Translation controller (`/v2/translator/**`).
 *
 * `TranslationEntity` has six fields but only three are inputs — `langFrom`, `langTo`,
 * `msgToTranslate`. The other three (`msgAfterTranslation`, `msgTranslatedToLanguage`,
 * `msgTranslatedFromLanguage`) are response-only, ignored on input; left unset here so the cases
 * that do send them prove a response-only field supplied by the caller is not honoured. Omitting
 * `langFrom` triggers auto-detection, which calls a third-party language detector (an external
 * dependency the exercising specs flag, so an upstream timeout reads as such, not a KMail defect).
 */

/**
 * Default translation body with an EXPLICIT `langFrom` — deterministic, so the injection/XSS/leak
 * cases that reuse it never depend on the external auto-detector. Use
 * `buildAutoDetectTranslationPayload` to exercise the auto-detection branch.
 */
export function buildTranslationPayload(
  overrides: Record<string, unknown> = {}
): Record<string, unknown> {
  return {
    // Excel spec: `{ langFrom, langTo, msgToTranslate }`.
    langFrom: 'fr',
    langTo: 'en',
    msgToTranslate: `Bonjour, ceci est un message de test. ${qaLabel('translate')}`,
    ...overrides,
  };
}

/**
 * Auto-detecting translation — `langFrom` genuinely OMITTED, so the server must call its third-party
 * language detector. Exercises a code path the explicit-langFrom default never reaches.
 */
export function buildAutoDetectTranslationPayload(
  overrides: Record<string, unknown> = {}
): Record<string, unknown> {
  const payload = buildTranslationPayload(overrides);
  delete payload.langFrom;
  return payload;
}

/** Translation with an explicit source language, bypassing auto-detection. */
export function buildExplicitTranslationPayload(
  langFrom: string,
  langTo: string,
  overrides: Record<string, unknown> = {}
): Record<string, unknown> {
  return buildTranslationPayload({ langFrom, langTo, ...overrides });
}
