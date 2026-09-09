import { faker } from '../../utils/dataGen';
import { qaLabel } from '../../utils/safeTestData';

// Excel spec fields: knownLanguages, designation, gender, otherEmail, dateOfBirth (a broad
// basic-profile update; the extra name/location fields below are accepted too).
export function buildBasicInformationPayload(overrides: Record<string, unknown> = {}) {
  return {
    country: 'India',
    state: faker.location.state(),
    city: faker.location.city(),
    firstName: faker.person.firstName(),
    lastName: faker.person.lastName(),
    dateOfBirth: '1995-01-01',
    gender: 'Male',
    designation: faker.person.jobTitle(),
    professionName: faker.person.jobType(),
    otherEmail: faker.internet.email(),
    knownLanguages: ['English', 'Tamil'],
    ...overrides,
  };
}

export function buildContactInformationPayload(overrides: Record<string, unknown> = {}) {
  return {
    alternateMobileno: `8${faker.string.numeric(9)}`,
    otherEmail: faker.internet.email(),
    landLineNumber: faker.string.numeric(8),
    addressLine1: faker.location.streetAddress(),
    addressLine2: faker.location.secondaryAddress(),
    pinCode: faker.string.numeric(6),
    ...overrides,
  };
}

export function buildDesignationPayload(overrides: Record<string, unknown> = {}) {
  return {
    designationID: 1,
    designation: faker.person.jobTitle(),
    ...overrides,
  };
}

// setProfilePrivacy — the simple per-field privacy status.
export function buildPrivacyPayload(overrides: Record<string, unknown> = {}) {
  return {
    privacyStatus: 1,
    privacySettings: 1,
    ...overrides,
  };
}

/**
 * updatePrivacySettingDetails — a DIFFERENT DTO from setProfilePrivacy. Excel spec:
 * `{ privacyDetails: "<stringified JSON>" }`, where the value is a JSON string of per-section
 * visibility flags (about/experience/school/college/university/otherActivity/mobile).
 */
export function buildPrivacySettingDetailsPayload(overrides: Record<string, unknown> = {}) {
  return {
    privacyDetails: JSON.stringify({
      about: 'false',
      experience: 'false',
      school: 'true',
      college: 'true',
      university: 'false',
      otherActivity: 'false',
      mobile: 'true',
    }),
    ...overrides,
  };
}

/**
 * changePassword body. Per the KPOST API spec the shape is exactly
 * `{ kpostID, oldPassword, confirmPassword }` — `confirmPassword` carries the NEW password, and
 * no other fields belong (`currentPassword` / `forgotPassword` / `requestType` are not part of
 * this DTO). `kpostID` defaults to a synthetic, non-existent id so a successful change can never
 * overwrite the shared QA account.
 */
export function buildChangePasswordPayload(overrides: Record<string, unknown> = {}) {
  return {
    kpostID: 'qa-nonexistent@kpostindia.com',
    oldPassword: 'Qa@Passw0rd123',
    confirmPassword: 'Qa@NewPassw0rd456',
    ...overrides,
  };
}

export function buildChangeAccessCodePayload(overrides: Record<string, unknown> = {}) {
  return {
    accessCode: faker.string.numeric(6),
    currentPassword: 'Qa@Passw0rd123',
    requestType: 'CHANGE',
    ...overrides,
  };
}

export function buildDeactivateAccountPayload(overrides: Record<string, unknown> = {}) {
  return {
    reason: 'No longer needed',
    ...overrides,
  };
}

export function buildKpostIdLookupPayload(kpostID: string, overrides: Record<string, unknown> = {}) {
  return {
    kpostID,
    ...overrides,
  };
}

// Excel spec: `{ fullName, mobileNumber, gender, ageFrom, ageTo, profession, pincode, state, city, country }`.
export function buildAdvancedSearchPayload(overrides: Record<string, unknown> = {}) {
  return {
    fullName: faker.person.fullName(),
    mobileNumber: '',
    gender: null,
    ageFrom: null,
    ageTo: null,
    profession: null,
    pincode: null,
    state: null,
    city: faker.location.city(),
    country: 'India',
    ...overrides,
  };
}

// Excel spec: `{ fullName, country }`.
export function buildAutoSearchPayload(overrides: Record<string, unknown> = {}) {
  return {
    fullName: faker.person.fullName(),
    country: 'India',
    ...overrides,
  };
}

// Excel spec: `{ experienceDetails: [{ experienceID, companyName, designation, companyLocation,
// achievements, yearFrom, yearTo }] }` — `experienceID` sits inside each item (empty for a new row).
export function buildExperienceDetailPayload(overrides: Record<string, unknown> = {}) {
  return {
    experienceDetails: [
      {
        experienceID: '',
        companyName: faker.company.name(),
        designation: faker.person.jobTitle(),
        companyLocation: faker.location.city(),
        achievements: qaLabel('achievement'),
        yearFrom: '2018',
        yearTo: '2021',
      },
    ],
    ...overrides,
  };
}

// Excel spec: `{ contactID, userType }` (userType e.g. 'KnownContacts').
export function buildDigitalCardPayload(contactID: string, overrides: Record<string, unknown> = {}) {
  return {
    contactID,
    userType: 'KnownContacts',
    ...overrides,
  };
}

export function buildShareUserDetailsPayload(overrides: Record<string, unknown> = {}) {
  return {
    kpostID: undefined,
    ...overrides,
  };
}

export function pngFileBuffer(): Buffer {
  // Minimal valid 1x1 transparent PNG.
  return Buffer.from(
    'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=',
    'base64'
  );
}

/* ===========================================================================================
 * User Profile V2 — the 29 endpoints beyond the original core subset.
 *
 * Two safety rules govern the defaults below.
 *
 * **Education and biography rows are addressed by a non-existent id.** The four delete routes
 * (`deleteSchoolDetail`, `deleteCollegeDetail`, `deleteUniversityDetail`,
 * `deleteOtherActivity`) remove profile history that cannot be restored through the API.
 *
 * **`kmailPasswordPatchWork` only ever receives synthetic identities.** It resets the Kmail
 * password for every kpostID in the list, performs no identity check, and always answers 200.
 * Passing a real kpostID would lock that person out of their mail, so `buildKmailPatchPayload`
 * has no parameter that could accidentally carry one.
 * ======================================================================================== */

/** A profile sub-record id that must not resolve to a real row. */
export function nonExistentProfileRecordId(): number {
  return 994_000_000 + faker.number.int({ min: 1, max: 999_999 });
}

/** A well-formed kpostID that is not a real subscriber. */
export function syntheticKpostId(): string {
  return `qa-noreply-${faker.string.alphanumeric({ length: 8, casing: 'lower' })}@kpostindia.com`;
}

/** A base64 data URI for a 1x1 PNG, for the image routes. */
export function base64Png(): string {
  return `data:image/png;base64,${pngFileBuffer().toString('base64')}`;
}

/** School history. `requestType` selects insert vs update on the shared UserProfileRO DTO. */
export function buildSchoolDetailsPayload(overrides: Record<string, unknown> = {}) {
  return {
    requestType: 'SAVE',
    schoolName: qaLabel('school'),
    fromYear: '2000',
    toYear: '2010',
    city: 'Chennai',
    state: 'Tamil Nadu',
    country: 'India',
    ...overrides,
  };
}

/** College history. */
export function buildCollegeDetailsPayload(overrides: Record<string, unknown> = {}) {
  return {
    requestType: 'SAVE',
    collegeName: qaLabel('college'),
    degree: 'B.E.',
    fromYear: '2010',
    toYear: '2014',
    city: 'Chennai',
    state: 'Tamil Nadu',
    country: 'India',
    ...overrides,
  };
}

/** University history. */
export function buildUniversityDetailsPayload(overrides: Record<string, unknown> = {}) {
  return {
    requestType: 'SAVE',
    universityName: qaLabel('university'),
    degree: 'M.Tech',
    fromYear: '2014',
    toYear: '2016',
    city: 'Chennai',
    state: 'Tamil Nadu',
    country: 'India',
    ...overrides,
  };
}

/**
 * Hobbies / other activities.
 * Excel spec: `{ otherActivities: [{ activityID, title, achievements, logoPath, attachmentPath }] }`.
 */
export function buildOtherActivityPayload(overrides: Record<string, unknown> = {}) {
  return {
    otherActivities: [
      {
        activityID: '',
        title: qaLabel('activity'),
        achievements: 'QA automation placeholder activity',
        logoPath: '',
        attachmentPath: '',
      },
    ],
    ...overrides,
  };
}

/**
 * A delete addressing one profile sub-record by its endpoint-specific id field. Per the Excel
 * spec each delete takes a single UUID field: `deleteSchoolDetail {schoolID}`,
 * `deleteCollegeDetail {collegeID}`, `deleteUniversityDetail {universityID}`,
 * `deleteExperienceDetail {experienceID}`, `deleteOtherActivity {activityID}`. The default UUID
 * is random, so it cannot resolve to a real row (the delete is irreversible).
 */
export function buildDeleteProfileRecordPayload(
  idField: string,
  overrides: Record<string, unknown> = {}
) {
  return {
    [idField]: faker.string.uuid(),
    ...overrides,
  };
}

/** The free-text biography. */
export function buildAboutYourselfPayload(overrides: Record<string, unknown> = {}) {
  return {
    aboutYourself: `${qaLabel('bio')} automated profile biography.`,
    ...overrides,
  };
}

/**
 * The `UsersKmailSetting` DTO — device pairing.
 *
 * Device pairing decides which handset receives calls and notifications, so a body that can
 * name another user's device is a delivery-hijack primitive. The builder therefore never
 * defaults `kpostID`; the ownership tests supply it explicitly.
 */
export function buildDeviceSettingPayload(overrides: Record<string, unknown> = {}) {
  return {
    deviceIdentity_primary: faker.string.uuid(),
    deviceIdentity_secondary: 'QA-Desktop-Chrome',
    ...overrides,
  };
}

/** An image upload body. The routes take a base64 string under `file`. */
export function buildImageUploadPayload(overrides: Record<string, unknown> = {}) {
  return {
    file: base64Png(),
    ...overrides,
  };
}

/** A base64-to-image conversion request. */
export function buildBase64ConversionPayload(overrides: Record<string, unknown> = {}) {
  return {
    file: base64Png(),
    fileName: `qa-automation-${faker.string.alphanumeric(6)}.png`,
    ...overrides,
  };
}

/** A language lookup filter. */
export function buildLanguageLookupPayload(overrides: Record<string, unknown> = {}) {
  return {
    countryID: 1,
    ...overrides,
  };
}

/** A designation/profession lookup. */
export function buildDesignationLookupPayload(overrides: Record<string, unknown> = {}) {
  return {
    requestType: 'DESIGNATION',
    ...overrides,
  };
}

/** A basic-details lookup for another user, used by the cross-product services. */
export function buildBasicDetailsLookupPayload(overrides: Record<string, unknown> = {}) {
  return {
    kpostID: syntheticKpostId(),
    ...overrides,
  };
}

/**
 * The Kmail password patch job.
 *
 * **Synthetic identities only.** There is deliberately no way to pass a real kpostID through
 * the default: the caller must override `kpostIDs` explicitly, and the tests never do so with
 * anything that exists.
 */
export function buildKmailPatchPayload(overrides: Record<string, unknown> = {}) {
  return {
    kpostIDs: [syntheticKpostId()],
    ...overrides,
  };
}
