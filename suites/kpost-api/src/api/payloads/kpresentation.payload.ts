import { faker } from '../../utils/dataGen';
import { qaLabel } from '../../utils/safeTestData';

/**
 * Request builders for the KPresentation controller.
 *
 * `presentationId` defaults to an implausibly high value that should not resolve to a real
 * deck: `delete` removes the presentation and its slide rows and is not reversible through
 * the API, so a builder must never default to something that could be a live presentation.
 *
 * Overrides are `Record<string, unknown>` rather than `Partial<T>` on purpose: the fuzzing
 * suites deliberately submit wrong-typed values, which a strict override type would forbid.
 */

/** A presentation id that must not resolve to a real deck. */
export function nonExistentPresentationId(): number {
  return 999_000_000 + faker.number.int({ min: 1, max: 999_999 });
}

export interface PresentationRequest {
  [key: string]: unknown;
}

/** create — Excel: `{ titleOfPresentation, subject, topic, subTopic }`. */
export function buildPresentationPayload(
  overrides: Record<string, unknown> = {}
): PresentationRequest {
  return {
    titleOfPresentation: qaLabel('title'),
    subject: faker.lorem.sentence(),
    topic: faker.lorem.words(3),
    subTopic: faker.lorem.words(2),
    ...overrides,
  };
}

/**
 * savePresentation — Excel: `{ presentationTitle, slides, presentationId }`. Defaults to a
 * non-existent id for safety (delete/save address a real deck otherwise).
 */
export function buildSavePresentationPayload(
  overrides: Record<string, unknown> = {}
): PresentationRequest {
  return {
    presentationTitle: qaLabel('deck'),
    // The API stores slides as a serialised blob rather than a structured list.
    slides: JSON.stringify([{ index: 1, body: faker.lorem.paragraph() }]),
    presentationId: nonExistentPresentationId(),
    ...overrides,
  };
}
