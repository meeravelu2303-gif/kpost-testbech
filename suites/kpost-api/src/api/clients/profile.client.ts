import { APIResponse } from '@playwright/test';
import { BaseClient, RequestOptions } from './base.client';

export const PROFILE_PATHS = {
  getUserProfile: '/v2/profile/getUserProfile',
  updateBasicInformation: '/v2/profile/updateBasicInformation',
  updateContactInformation: '/v2/profile/updateContactInformation',
  updateDesignation: '/v2/profile/updateDesignation',
  setProfilePrivacy: '/v2/profile/setProfilePrivacy',
  updatePrivacySettingDetails: '/v2/profile/updatePrivacySettingDetails',
  changePassword: '/v2/profile/changePassword',
  changeOrForgotAccessCode: '/v2/profile/changeOrForgotAccessCode',
  deactivateAccount: '/v2/profile/deactivateAccount',
  getUserProfileUsingKpostID: '/v2/profile/getUserProfileUsingKpostID',
  advancedSearch: '/v2/profile/advancedSearch',
  autoSearchWithName: '/v2/profile/autoSearchWithName',
  updateProfileImage: '/v2/profile/updateProfileImage',
  removeProfileImage: '/v2/profile/removeProfileImage',
  saveOrUpdateExperienceDetails: '/v2/profile/saveOrUpdateExperienceDetails',
  deleteExperienceDetail: '/v2/profile/deleteExperienceDetail',
  getDigitalCard: '/v2/profile/getDigitalCard',
  shareUserDetails: '/v2/profile/shareUserDetails',

  // --- Education and biography -------------------------------------------------------
  saveOrUpdateSchoolDetails: '/v2/profile/saveOrUpdateSchoolDetails',
  /*
   * Excel rows 107-109 document a SECOND, distinct family alongside `saveOrUpdate*Details`.
   * They are not aliases: `saveOrUpdate*` takes the flat `UserProfileRO` keyed by
   * `requestType`, while these take a nested ARRAY of records (`schoolDetails: [ ... ]`)
   * carrying the row id, `course`/`standard`/`field`, `about` and `attachmentPath`.
   */
  updateSchoolDetails: '/v2/profile/updateSchoolDetails',
  updateCollegeDetails: '/v2/profile/updateCollegeDetails',
  updateUniversityDetails: '/v2/profile/updateUniversityDetails',
  deleteSchoolDetail: '/v2/profile/deleteSchoolDetail',
  saveOrUpdateCollegeDetails: '/v2/profile/saveOrUpdateCollegeDetails',
  deleteCollegeDetail: '/v2/profile/deleteCollegeDetail',
  saveOrUpdateUniversityDetails: '/v2/profile/saveOrUpdateUniversityDetails',
  deleteUniversityDetail: '/v2/profile/deleteUniversityDetail',
  saveOrUpdateOtherActivity: '/v2/profile/saveOrUpdateOtherActivity',
  deleteOtherActivity: '/v2/profile/deleteOtherActivity',
  updateAboutYourself: '/v2/profile/updateAboutYourself',

  // --- Device pairing ------------------------------------------------------------------
  setDeviceAsPrimary: '/v2/profile/setDeviceAsPrimary',
  updateDeviceAsPrimary: '/v2/profile/updateDeviceAsPrimary',
  setDeviceAsSecondary: '/v2/profile/setDeviceAsSecondary',
  updateDeviceAsSecondary: '/v2/profile/updateDeviceAsSecondary',
  isDevicePrimaryOrNot: '/v2/profile/isDevicePrimaryOrNot',
  sendPrimaryDeviceOtp: '/v2/profile/sendPrimaryDeviceOtp',
  sendAccountDeactivationOtp: '/v2/profile/sendAccountDeactivationOtp',
  sendPrimaryOrSecondaryDeviceOtp: '/v2/profile/sendPrimaryOrSecondaryDeviceOtp',

  // --- Image reads (path-variable addressed, `permitAll` in SecurityConfiguration) -------
  downloadProfileImage: '/v2/profile/downloadProfileImage',
  downloadFullProfileImage: '/v2/profile/downloadFullProfileImage',
  downloadCoverImage: '/v2/profile/downloadCoverImage',

  // --- Images, attachments and storage -------------------------------------------------
  uploadProfileAttachments: '/v2/profile/uploadProfileAttachments',
  uploadImageToS3: '/v2/profile/uploadImageToS3',
  uploadCoverImage: '/v2/profile/uploadCoverImage',
  removeCoverImage: '/v2/profile/removeCoverImage',
  updateSignatureImage: '/v2/profile/updateSignatureImage',
  getSignatureImage: '/v2/profile/getSignatureImage',
  convertBase64ToImage: '/v2/profile/convertBase64ToImage',
  getStorageDetails: '/v2/profile/getStorageDetails',

  // --- Lookups and maintenance ---------------------------------------------------------
  getlanguages: '/v2/profile/getlanguages',
  fetchUserDetails: '/v2/profile/fetchUserDetails',
  getUserBasicDetailsUsingKpostID: '/v2/profile/getUserBasicDetailsUsingKpostID',
  getDesignationOrProfession: '/v2/profile/getDesignationOrProfession',
  /** DESTRUCTIVE — resets Kmail passwords for a list of kpostIDs, no identity check. Refusal paths only. */
  kmailPasswordPatchWork: '/v2/profile/kmailPasswordPatchWork',
} as const;

export class ProfileClient extends BaseClient {
  getUserProfile(options?: RequestOptions): Promise<APIResponse> {
    return this.get(PROFILE_PATHS.getUserProfile, options);
  }

  updateBasicInformation(data: unknown, options?: RequestOptions): Promise<APIResponse> {
    return this.post(PROFILE_PATHS.updateBasicInformation, data, options);
  }

  updateContactInformation(data: unknown, options?: RequestOptions): Promise<APIResponse> {
    return this.post(PROFILE_PATHS.updateContactInformation, data, options);
  }

  updateDesignation(data: unknown, options?: RequestOptions): Promise<APIResponse> {
    return this.post(PROFILE_PATHS.updateDesignation, data, options);
  }

  setProfilePrivacy(data: unknown, options?: RequestOptions): Promise<APIResponse> {
    return this.post(PROFILE_PATHS.setProfilePrivacy, data, options);
  }

  updatePrivacySettingDetails(data: unknown, options?: RequestOptions): Promise<APIResponse> {
    return this.post(PROFILE_PATHS.updatePrivacySettingDetails, data, options);
  }

  changePassword(data: unknown, options?: RequestOptions): Promise<APIResponse> {
    return this.post(PROFILE_PATHS.changePassword, data, options);
  }

  changeOrForgotAccessCode(data: unknown, options?: RequestOptions): Promise<APIResponse> {
    return this.post(PROFILE_PATHS.changeOrForgotAccessCode, data, options);
  }

  deactivateAccount(data: unknown, options?: RequestOptions): Promise<APIResponse> {
    return this.post(PROFILE_PATHS.deactivateAccount, data, options);
  }

  getUserProfileUsingKpostID(data: unknown, options?: RequestOptions): Promise<APIResponse> {
    return this.post(PROFILE_PATHS.getUserProfileUsingKpostID, data, options);
  }

  advancedSearch(data: unknown, options?: RequestOptions): Promise<APIResponse> {
    return this.post(PROFILE_PATHS.advancedSearch, data, options);
  }

  autoSearchWithName(data: unknown, options?: RequestOptions): Promise<APIResponse> {
    return this.post(PROFILE_PATHS.autoSearchWithName, data, options);
  }

  updateProfileImage(
    file: { name: string; mimeType: string; buffer: Buffer },
    options?: RequestOptions
  ): Promise<APIResponse> {
    return this.postMultipart(PROFILE_PATHS.updateProfileImage, { file }, options);
  }

  updateProfileImageJson(data: unknown, options?: RequestOptions): Promise<APIResponse> {
    return this.post(PROFILE_PATHS.updateProfileImage, data, options);
  }

  removeProfileImage(options?: RequestOptions): Promise<APIResponse> {
    return this.get(PROFILE_PATHS.removeProfileImage, options);
  }

  saveOrUpdateExperienceDetails(data: unknown, options?: RequestOptions): Promise<APIResponse> {
    return this.post(PROFILE_PATHS.saveOrUpdateExperienceDetails, data, options);
  }

  deleteExperienceDetail(data: unknown, options?: RequestOptions): Promise<APIResponse> {
    return this.post(PROFILE_PATHS.deleteExperienceDetail, data, options);
  }

  getDigitalCard(data: unknown, options?: RequestOptions): Promise<APIResponse> {
    return this.post(PROFILE_PATHS.getDigitalCard, data, options);
  }

  shareUserDetails(data: unknown, options?: RequestOptions): Promise<APIResponse> {
    return this.post(PROFILE_PATHS.shareUserDetails, data, options);
  }

  /* ---- education and biography ---- */

  updateSchoolDetails(data: unknown, options?: RequestOptions): Promise<APIResponse> {
    return this.post(PROFILE_PATHS.updateSchoolDetails, data, options);
  }

  updateCollegeDetails(data: unknown, options?: RequestOptions): Promise<APIResponse> {
    return this.post(PROFILE_PATHS.updateCollegeDetails, data, options);
  }

  updateUniversityDetails(data: unknown, options?: RequestOptions): Promise<APIResponse> {
    return this.post(PROFILE_PATHS.updateUniversityDetails, data, options);
  }

  saveOrUpdateSchoolDetails(data: unknown, options?: RequestOptions): Promise<APIResponse> {
    return this.post(PROFILE_PATHS.saveOrUpdateSchoolDetails, data, options);
  }

  deleteSchoolDetail(data: unknown, options?: RequestOptions): Promise<APIResponse> {
    return this.post(PROFILE_PATHS.deleteSchoolDetail, data, options);
  }

  saveOrUpdateCollegeDetails(data: unknown, options?: RequestOptions): Promise<APIResponse> {
    return this.post(PROFILE_PATHS.saveOrUpdateCollegeDetails, data, options);
  }

  deleteCollegeDetail(data: unknown, options?: RequestOptions): Promise<APIResponse> {
    return this.post(PROFILE_PATHS.deleteCollegeDetail, data, options);
  }

  saveOrUpdateUniversityDetails(data: unknown, options?: RequestOptions): Promise<APIResponse> {
    return this.post(PROFILE_PATHS.saveOrUpdateUniversityDetails, data, options);
  }

  deleteUniversityDetail(data: unknown, options?: RequestOptions): Promise<APIResponse> {
    return this.post(PROFILE_PATHS.deleteUniversityDetail, data, options);
  }

  saveOrUpdateOtherActivity(data: unknown, options?: RequestOptions): Promise<APIResponse> {
    return this.post(PROFILE_PATHS.saveOrUpdateOtherActivity, data, options);
  }

  deleteOtherActivity(data: unknown, options?: RequestOptions): Promise<APIResponse> {
    return this.post(PROFILE_PATHS.deleteOtherActivity, data, options);
  }

  updateAboutYourself(data: unknown, options?: RequestOptions): Promise<APIResponse> {
    return this.post(PROFILE_PATHS.updateAboutYourself, data, options);
  }

  /* ---- device pairing ---- */

  setDeviceAsPrimary(data: unknown, options?: RequestOptions): Promise<APIResponse> {
    return this.post(PROFILE_PATHS.setDeviceAsPrimary, data, options);
  }

  updateDeviceAsPrimary(data: unknown, options?: RequestOptions): Promise<APIResponse> {
    return this.post(PROFILE_PATHS.updateDeviceAsPrimary, data, options);
  }

  setDeviceAsSecondary(data: unknown, options?: RequestOptions): Promise<APIResponse> {
    return this.post(PROFILE_PATHS.setDeviceAsSecondary, data, options);
  }

  updateDeviceAsSecondary(data: unknown, options?: RequestOptions): Promise<APIResponse> {
    return this.post(PROFILE_PATHS.updateDeviceAsSecondary, data, options);
  }

  isDevicePrimaryOrNot(options?: RequestOptions): Promise<APIResponse> {
    return this.get(PROFILE_PATHS.isDevicePrimaryOrNot, options);
  }

  /** Dispatches a real OTP to the caller's registered number — exercised sparingly. */
  sendPrimaryDeviceOtp(options?: RequestOptions): Promise<APIResponse> {
    return this.get(PROFILE_PATHS.sendPrimaryDeviceOtp, options);
  }

  /** Dispatches a real OTP; the first step of account deletion. */
  sendAccountDeactivationOtp(options?: RequestOptions): Promise<APIResponse> {
    return this.get(PROFILE_PATHS.sendAccountDeactivationOtp, options);
  }

  /** `requestType` is interpolated into the path — the injection surface, hence the raw string param. */
  sendPrimaryOrSecondaryDeviceOtp(
    requestType: string,
    options?: RequestOptions
  ): Promise<APIResponse> {
    return this.get(
      `${PROFILE_PATHS.sendPrimaryOrSecondaryDeviceOtp}/${encodeURIComponent(requestType)}`,
      options
    );
  }

  /* ---- image reads ---- */

  downloadProfileImage(kpostID: string, options?: RequestOptions): Promise<APIResponse> {
    return this.get(`${PROFILE_PATHS.downloadProfileImage}/${encodeURIComponent(kpostID)}`, options);
  }

  downloadFullProfileImage(kpostID: string, options?: RequestOptions): Promise<APIResponse> {
    return this.get(
      `${PROFILE_PATHS.downloadFullProfileImage}/${encodeURIComponent(kpostID)}`,
      options
    );
  }

  downloadCoverImage(kpostID: string, options?: RequestOptions): Promise<APIResponse> {
    return this.get(`${PROFILE_PATHS.downloadCoverImage}/${encodeURIComponent(kpostID)}`, options);
  }

  /** Sends a path segment UNENCODED (the deliberate bypass for the traversal/injection tests). */
  getRawImagePath(path: string, options?: RequestOptions): Promise<APIResponse> {
    return this.get(path, options);
  }

  /** Drives an arbitrary verb at an arbitrary profile path — for verb-binding checks. */
  sendVerb(
    method: 'get' | 'put' | 'patch' | 'delete' | 'head' | 'options',
    path: string,
    options?: RequestOptions
  ): Promise<APIResponse> {
    return this.fetchWithVerb(method, path, options);
  }

  /* ---- images, attachments and storage ---- */

  uploadProfileAttachments(data: unknown, options?: RequestOptions): Promise<APIResponse> {
    return this.post(PROFILE_PATHS.uploadProfileAttachments, data, options);
  }

  uploadImageToS3(data: unknown, options?: RequestOptions): Promise<APIResponse> {
    return this.post(PROFILE_PATHS.uploadImageToS3, data, options);
  }

  uploadCoverImage(data: unknown, options?: RequestOptions): Promise<APIResponse> {
    return this.post(PROFILE_PATHS.uploadCoverImage, data, options);
  }

  removeCoverImage(options?: RequestOptions): Promise<APIResponse> {
    return this.get(PROFILE_PATHS.removeCoverImage, options);
  }

  updateSignatureImage(data: unknown, options?: RequestOptions): Promise<APIResponse> {
    return this.post(PROFILE_PATHS.updateSignatureImage, data, options);
  }

  getSignatureImage(options?: RequestOptions): Promise<APIResponse> {
    return this.get(PROFILE_PATHS.getSignatureImage, options);
  }

  convertBase64ToImage(data: unknown, options?: RequestOptions): Promise<APIResponse> {
    return this.post(PROFILE_PATHS.convertBase64ToImage, data, options);
  }

  getStorageDetails(options?: RequestOptions): Promise<APIResponse> {
    return this.get(PROFILE_PATHS.getStorageDetails, options);
  }

  /* ---- lookups and maintenance ---- */

  getlanguages(data: unknown, options?: RequestOptions): Promise<APIResponse> {
    return this.post(PROFILE_PATHS.getlanguages, data, options);
  }

  fetchUserDetails(options?: RequestOptions): Promise<APIResponse> {
    return this.get(PROFILE_PATHS.fetchUserDetails, options);
  }

  getUserBasicDetailsUsingKpostID(data: unknown, options?: RequestOptions): Promise<APIResponse> {
    return this.post(PROFILE_PATHS.getUserBasicDetailsUsingKpostID, data, options);
  }

  getDesignationOrProfession(data: unknown, options?: RequestOptions): Promise<APIResponse> {
    return this.post(PROFILE_PATHS.getDesignationOrProfession, data, options);
  }

  /**
   * DESTRUCTIVE — resets Kmail passwords for the supplied kpostIDs.
   *
   * The caller must only ever pass synthetic, non-existent identities. Passing a real
   * kpostID locks that person out of their mail.
   */
  kmailPasswordPatchWork(data: unknown, options?: RequestOptions): Promise<APIResponse> {
    return this.post(PROFILE_PATHS.kmailPasswordPatchWork, data, options);
  }

  /** Issues a GET at any path, for method-binding and unauthenticated probes. */
  getPath(path: string, options?: RequestOptions): Promise<APIResponse> {
    return this.get(path, options);
  }

  postRawTo(path: string, body: string, options?: RequestOptions): Promise<APIResponse> {
    return this.postRaw(path, body, options);
  }
}
