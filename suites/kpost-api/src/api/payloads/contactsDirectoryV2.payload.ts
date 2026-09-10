import { faker } from '../../utils/dataGen';
import { qaIdentifier, qaLabel, safeTestEmail, safeTestMobile } from '../../utils/safeTestData';

/**
 * Request builders for the Contacts Directory V2 controller.
 *
 * Two safety rules are encoded here:
 *
 * 1. **Phone-book entries use the safe test contact details.** `importPhoneContacts` uploads
 *    an address book so KPOST can match it against registered users, and `updateInviteStatus`
 *    feeds the invite flow. A faker-generated 10-digit Indian number is a real subscriber, so
 *    a bulk import built from faker would be an invitation-spam vector.
 * 2. **Contact targets default to a QA-prefixed identity** that should not resolve to a real
 *    user, so block and delete cases exercise the refusal path rather than mutating a genuine
 *    relationship.
 *
 * Overrides are `Record<string, unknown>` rather than `Partial<T>` on purpose: the fuzzing
 * suites deliberately submit wrong-typed values, which a strict override type would forbid.
 */

/** A contact identity that should not resolve to a real user. */
export function nonExistentContactId(): string {
  return `qa-nonexistent-contact-${faker.string.alphanumeric(8)}`;
}

export interface ContactRequest {
  contactID: string;
  firstName: string;
  lastName: string;
  referenceName: string;
  mobileNumber: string;
  email: string;
  isBlocked: boolean;
  [key: string]: unknown;
}

/** Shared by addContact, addContactReference, deleteContact and blockOrUnBlockContact. */
export function buildContactPayload(overrides: Record<string, unknown> = {}): ContactRequest {
  return {
    contactID: nonExistentContactId(),
    firstName: faker.person.firstName(),
    lastName: faker.person.lastName(),
    referenceName: qaLabel('ref'),
    contactDesignation: faker.person.jobTitle(),
    mobileNumber: safeTestMobile(),
    email: safeTestEmail(),
    userType: 'PERSONAL',
    isBlocked: false,
    deleteStatus: false,
    ...overrides,
  } as ContactRequest;
}

/** A batch for addMultipleContact. Note the endpoint's body is an array, not an object. */
export function buildMultipleContactsPayload(
  count = 3,
  overrides: Record<string, unknown> = {}
): Array<Record<string, unknown>> {
  return Array.from({ length: count }, () => buildContactPayload(overrides));
}

/** Block toggle. The spec stresses this is payload-driven, not an inversion of current state. */
export function buildBlockPayload(
  isBlocked: boolean,
  overrides: Record<string, unknown> = {}
): ContactRequest {
  return buildContactPayload({ isBlocked, ...overrides });
}

export interface ContactSyncRequest {
  lastfetchDate: string;
  contactIDs: string[];
  isBlocked: boolean;
  [key: string]: unknown;
}

/**
 * Shared by myContacts, myGroups, myUnknownKatchupContacts, myUnknownGroups and
 * blockOrUnBlockMultipleContact — all take the same `ContactsRO`.
 */
export function buildContactSyncPayload(
  overrides: Record<string, unknown> = {}
): ContactSyncRequest {
  return {
    lastfetchDate: '2020-01-01T00:00:00.000Z',
    contactIDs: [],
    isBlocked: false,
    ...overrides,
  } as ContactSyncRequest;
}

/** Bulk block/unblock over a list of contact ids. */
export function buildBulkBlockPayload(
  contactIDs: string[],
  isBlocked: boolean,
  overrides: Record<string, unknown> = {}
): ContactSyncRequest {
  return buildContactSyncPayload({ contactIDs, isBlocked, ...overrides });
}

export interface PhoneContactEntry {
  mobileNumber: string;
  name: string;
  email: string;
  [key: string]: unknown;
}

/**
 * A device address book. Every number routes through `safeTestMobile()` — an imported book
 * drives contact matching and the invite flow, so faker numbers here would reach real people.
 */
export function buildPhoneContactsPayload(
  count = 3,
  overrides: Record<string, unknown> = {}
): Record<string, unknown> {
  const phoneContacts: PhoneContactEntry[] = Array.from({ length: count }, () => ({
    mobileNumber: safeTestMobile(),
    name: qaLabel('phone'),
    email: safeTestEmail(),
  }));

  return {
    deviceID: faker.string.uuid(),
    mobileNumber: safeTestMobile(),
    countryCode: '+91',
    phoneContacts,
    ...overrides,
  };
}

/** Invite-status update for one imported phone-book entry. */
export function buildInviteStatusPayload(
  overrides: Record<string, unknown> = {}
): Record<string, unknown> {
  return {
    deviceID: faker.string.uuid(),
    mobileNumber: safeTestMobile(),
    name: qaLabel('invite'),
    email: safeTestEmail(),
    inviteStatus: 'INVITED',
    joinStatus: 'NOT_JOINED',
    countryCode: '+91',
    ...overrides,
  };
}

/** Global directory search criteria. The body is an untyped map. */
// Excel spec: `{ search, languageList, userTypeList, countryList }`.
export function buildGlobalSearchPayload(
  overrides: Record<string, unknown> = {}
): Record<string, unknown> {
  return {
    search: qaIdentifier('search'),
    languageList: ['english'],
    userTypeList: ['personal'],
    countryList: ['india'],
    ...overrides,
  };
}

/**
 * Geography lookup (Excel row 74). No `@Valid`, so the payload is unvalidated server-side.
 *
 * `requestType` selects a level of the country → province → state → city → area cascade, and each
 * level requires the levels above it. The documented values are exactly these six; `COMPANY` was
 * sent here previously and is not one of them, so the lookup never resolved a level.
 */
export const SEARCH_REQUEST_TYPE = {
  country: 'country',
  provienceName: 'provienceName',
  state: 'state',
  city: 'city',
  areaName: 'areaName',
  pinCode: 'pinCode',
} as const;

export function buildSearchDetailsPayload(
  overrides: Record<string, unknown> = {}
): Record<string, unknown> {
  return {
    requestType: SEARCH_REQUEST_TYPE.country,
    ...overrides,
  };
}

/** The deepest cascade level — every parent field populated, as Excel row 74 shows it. */
export function buildAreaSearchDetailsPayload(
  overrides: Record<string, unknown> = {}
): Record<string, unknown> {
  return {
    requestType: SEARCH_REQUEST_TYPE.areaName,
    country: 'INDIA',
    provienceName: 'Southern Zone',
    state: 'Tamil Nadu',
    city: 'Chennai',
    ...overrides,
  };
}
