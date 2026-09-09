import { faker } from '../../utils/dataGen';
import { qaLabel } from '../../utils/safeTestData';

/**
 * Request builders for the KMail Settings controller (`/v2/kmailSetting/**`).
 *
 * Signature endpoints declare a bare `{"type":"object"}` body in OpenAPI, so field lists are
 * transcribed from KMail Excel column `[E]`. Each per-block endpoint takes its fields **flat**
 * (`{ firstName, lastName, designation, emailId, mobileNumber, alternateMobile }` for personal
 * data); `saveOrUpdateMailSignature` takes the same blocks **nested** under `personalData` /
 * `companyData` / `graphics` / `style` / `socialMedialink`. Specs also assert **round-trip**
 * through `getMailSignature`, so a spec fails when the service loses data, not just on shape drift.
 *
 * `kpostID` is server-assigned on every route, left unset; ownership cases set it explicitly.
 */

/*
 * Signature blocks, from KMail Excel column `[E]`. Individual block endpoints take fields **flat**
 * (no wrapper key); `saveOrUpdateMailSignature` takes them **nested** under `personalData` /
 * `companyData` / `graphics` / `style` / `socialMedialink`. These flat generators feed both shapes.
 */
const SIGNATURE_BLOCK_KEYS = [
  'personalData',
  'companyData',
  'graphics',
  'style',
  'socialMedialink',
] as const;

function personalDataFields(): Record<string, unknown> {
  return {
    firstName: faker.person.firstName(),
    lastName: faker.person.lastName(),
    designation: faker.person.jobTitle(),
    emailId: `${qaLabel('sig').toLowerCase()}@example.com`,
    mobileNumber: '9999999999',
    alternateMobile: '',
  };
}

function companyDataFields(): Record<string, unknown> {
  return {
    companyName: faker.company.name(),
    website: faker.internet.url(),
    addressLine1: `${faker.person.jobTitle()} Office, ${faker.location.city()}`,
    addressLine2: `${faker.location.city()}, India`,
  };
}

function graphicsFields(): Record<string, unknown> {
  return {
    photoUrl: `${faker.internet.url()}/profile_photo.png`,
    bannerUrl: `${faker.internet.url()}/banner_image.png`,
    bannerLinkingTo: faker.internet.url(),
  };
}

function styleFields(): Record<string, unknown> {
  return {
    color: '#1A73E8',
    fontStyle: 'Arial, sans-serif',
  };
}

function socialMediaFields(): Record<string, unknown> {
  return {
    twitter: `${faker.internet.url()}/qa-automation`,
    facebook: `${faker.internet.url()}/qa-automation`,
    instagram: `${faker.internet.url()}/qa-automation`,
    linkedIn: `${faker.internet.url()}/in/qa-automation`,
    youTube: `${faker.internet.url()}/@qa-automation`,
  };
}

/** The personal block — flat fields for `saveOrUpdateMailSignaturePersonalData`. */
export function buildSignaturePersonalDataPayload(
  overrides: Record<string, unknown> = {}
): Record<string, unknown> {
  return { ...personalDataFields(), ...overrides };
}

/** The company block — flat fields for `saveOrUpdateMailSignatureCompanyData`. */
export function buildSignatureCompanyDataPayload(
  overrides: Record<string, unknown> = {}
): Record<string, unknown> {
  return { ...companyDataFields(), ...overrides };
}

/** The graphics block — flat fields for `saveOrUpdateMailSignatureGraphics`. */
export function buildSignatureGraphicsPayload(
  overrides: Record<string, unknown> = {}
): Record<string, unknown> {
  return { ...graphicsFields(), ...overrides };
}

/** The style block — flat fields for `saveOrUpdateMailSignatureStyle`. */
export function buildSignatureStylePayload(
  overrides: Record<string, unknown> = {}
): Record<string, unknown> {
  return { ...styleFields(), ...overrides };
}

/** The social media block — flat fields for `saveOrUpdateMailSignatureSocialMediaLink`. */
export function buildSignatureSocialMediaPayload(
  overrides: Record<string, unknown> = {}
): Record<string, unknown> {
  return { ...socialMediaFields(), ...overrides };
}

/** The template selection — Excel `[E]` names the field `templateID` (capital ID). */
export function buildSignatureTemplateIdPayload(
  templateID: string | number = 1,
  overrides: Record<string, unknown> = {}
): Record<string, unknown> {
  return { templateID, ...overrides };
}

/**
 * The whole signature at once — the nested equivalent of the five block endpoints. Enables the
 * question: does a *block* write preserve its siblings or replace the column? (save-all, write one
 * block, read back — the `tests/settings/` sequence.) Overrides addressing a block key
 * (`{ personalData: { firstName: '…' } }`) are **merged into** that block, not replacing it.
 */
export function buildFullSignaturePayload(
  overrides: Record<string, unknown> = {}
): Record<string, unknown> {
  const blocks: Record<string, Record<string, unknown>> = {
    personalData: personalDataFields(),
    companyData: companyDataFields(),
    graphics: graphicsFields(),
    style: styleFields(),
    socialMedialink: socialMediaFields(),
  };
  const rest: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(overrides)) {
    if ((SIGNATURE_BLOCK_KEYS as readonly string[]).includes(key) && value && typeof value === 'object') {
      blocks[key] = { ...blocks[key], ...(value as Record<string, unknown>) };
    } else {
      rest[key] = value;
    }
  }
  return { ...blocks, ...rest };
}

/**
 * The `{ id }` body shared by `setLetterHead` and `deleteLetterHead`. The documented example gives
 * `id` as a **string** (`{"id":"2"}`) even though it addresses a numeric JSON-array entry; matched
 * exactly so the type-mismatch cases can send a number as the deliberate deviation.
 */
export function buildLetterHeadIdPayload(
  id: string,
  overrides: Record<string, unknown> = {}
): Record<string, unknown> {
  return { id, ...overrides };
}

/**
 * The `SaluationsRO` DTO. `saluationID` is **omitted** on create and **required** on update/delete
 * — the whole contract of the save endpoint; `tests/settings/` exercises both branches.
 */
export function buildSaluationPayload(
  overrides: Record<string, unknown> = {}
): Record<string, unknown> {
  return {
    saluation: qaLabel('saluation'),
    ...overrides,
  };
}

/** Addresses an existing salutation for update or delete. */
export function buildSaluationIdPayload(
  saluationID: string,
  overrides: Record<string, unknown> = {}
): Record<string, unknown> {
  return buildSaluationPayload({ saluationID, ...overrides });
}

/**
 * The `instantReplyRO` DTO. Same create/update split as the salutation, but the identifier is `id`,
 * not `saluationID` — an inconsistency between two otherwise identical endpoints, reproduced.
 */
export function buildInstantReplyPayload(
  overrides: Record<string, unknown> = {}
): Record<string, unknown> {
  return {
    instantReply: `${qaLabel('reply')} — received, will revert shortly.`,
    ...overrides,
  };
}

/** Addresses an existing instant reply for update or delete. */
export function buildInstantReplyIdPayload(
  id: string,
  overrides: Record<string, unknown> = {}
): Record<string, unknown> {
  return buildInstantReplyPayload({ id, ...overrides });
}

/**
 * The mail-count day window. Excel `[E]` is `{ countDaysLimit: 60 }` — how many days back the
 * mailbox counts mail. The paired reader, `getMailCountDaysLimit`, is a GET with no body.
 */
export function buildMailCountDaysLimitPayload(
  countDaysLimit: number = 60,
  overrides: Record<string, unknown> = {}
): Record<string, unknown> {
  return { countDaysLimit, ...overrides };
}
