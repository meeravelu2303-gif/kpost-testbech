import { faker } from '../../utils/dataGen';

/**
 * Request builders for the Knews controller.
 *
 * Overrides are `Record<string, unknown>` rather than `Partial<T>` on purpose: the fuzzing
 * suites deliberately submit wrong-typed values (a string where an id is expected, an array
 * where an object is expected) to prove the API validates them, and a strict override type
 * would make those cases uncompilable.
 *
 * Knews settings carry a `subscriptionDetails` field that the platform can use to drive
 * subscription notices, so the builder routes contact details through `safeTestMobile()` /
 * `safeTestEmail()` rather than faker values — a faker mobile number is a real subscriber.
 */

export interface UpdateKnewsSettingsRequest {
  // No kpostId — per the Excel flow the settings are owned by the token, never a body field.
  // (The IDOR test still smuggles a kpostId via override to prove the endpoint ignores it.)
  countryName: string;
  stateName: string;
  cityNames: string;
  languageId: number;
  newsType: string;
  newsSource: string;
  publications: string;
  category: string;
  subCategories: string;
  retentionDays: number;
  archiveDays: number;
  subscriptionDetails: string;
  [key: string]: unknown;
}

export function buildUpdateKnewsSettingsPayload(
  overrides: Record<string, unknown> = {}
): UpdateKnewsSettingsRequest {
  // Excel updateKnewsSettings: countryName, stateName, cityNames, languageId, newsType,
  // newsSource, publications, category, subCategories, retentionDays, archiveDays,
  // subscriptionDetails (a stringified JSON blob). No kpostId — the token owns the settings.
  return {
    countryName: 'India',
    stateName: faker.location.state(),
    cityNames: faker.location.city(),
    languageId: 1,
    newsType: 'Paid Digital News',
    newsSource: 'All',
    publications: 'The Hindu, Times of India',
    category: 'Sports',
    subCategories: 'Cricket, Tennis',
    retentionDays: 30,
    archiveDays: 90,
    subscriptionDetails: JSON.stringify({
      newsCost: 300,
      newsCostPeriod: 'Per Year',
      kpostServiceCharge: 30,
      gstPercent: 18,
      gstAmount: 54,
      totalPayableAmount: 384,
      currency: 'INR',
    }),
    ...overrides,
  } as UpdateKnewsSettingsRequest;
}

/** getSubCategoriesByCategoryId — Excel: `{ categoryId }`. */
export function buildCategoryLookupPayload(
  overrides: Record<string, unknown> = {}
): Record<string, unknown> {
  return { categoryId: 1, ...overrides };
}

/** getPublicationByLanguageId — Excel: `{ languageId }`. */
export function buildPublicationPayload(
  overrides: Record<string, unknown> = {}
): Record<string, unknown> {
  return { languageId: 1, ...overrides };
}
