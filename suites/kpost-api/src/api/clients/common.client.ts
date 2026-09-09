import { APIResponse } from '@playwright/test';
import { BaseClient, RequestOptions } from './base.client';

export const COMMON_PATHS = {
  sendOTP: '/v2/common/sendOTP',
  validateOTP: '/v2/common/validateOTP',
  sendOTPtoMail: '/v2/common/sendOTPtoMail',
  validateMailOTP: '/v2/common/validateMailOTP',
  mobileNoExist: '/v2/common/mobileNoExist',
  isCompanyNameExist: '/v2/common/isCompanyNameExist',
  countries: '/v2/common/countries',
  country: '/v2/common/country',
  getStates: '/v2/common/getStates',
  pinCode: '/v2/common/pinCode',
  postalPinCode: '/v2/common/postalPinCode',
  getProfession: '/v2/common/getProfession',
  getDesignation: '/v2/common/getDesignation',
  getDesignationByProfessionId: '/v2/common/getDesignationByProfessionId',
  forgotPasswordOTPOrSentKpostIDSms: '/v2/common/forgotPasswordOTPOrSentKpostIDSms',
  forgotPasswordUpdate: '/v2/common/forgotPasswordUpdate',
  domain: '/v2/common/domain',
  generateDomainAndUniqueName: '/v2/common/generateDomainAndUniqueName',
  msStatus: '/v2/common/msStatus',
  saveEnquiryDetails: '/v2/common/saveEnquiryDetails',
  saveUnsubscriberDetails: '/v2/common/saveUnsubscriberDetails',

  // --- Directory and company lookups (all under the permitAll /v2/common/** tree) -------
  getUserDetailsByMobNo: '/v2/common/getUserDetailsByMobNo',
  getKpostIdUsingModule: '/v2/common/getKpostIdUsingModule',
  getCompanyDetails: '/v2/common/getCompanyDetails',
  getCompanyDetailsByAdmin: '/v2/common/getCompanyDetailsByAdmin',
  getCompanyDetailsByMobileNoAndproductId: '/v2/common/getCompanyDetailsByMobileNoAndproductId',
  mobileNoExistInsideCompany: '/v2/common/mobileNoExistInsideCompany',
  uniqueNameExist: '/v2/common/uniqueNameExist',
  getCitiesByRegionId: '/v2/common/getCitiesByRegionId',
  languages: '/v2/common/languages',
  /** The same handler is also mounted without the /v2 prefix. */
  languagesLegacy: '/common/languages',
  getTotalCountByDate: '/v2/common/getTotalCountByDate',

  // --- Writes on the unauthenticated tree ----------------------------------------------
  /** Unauthenticated Katchup bridge — takes sender and receiver from the body. */
  sendMessage: '/v2/common/sendMessage',
  /** Authorises against two hardcoded email addresses in source. */
  updateFlutterAppVersion: '/v2/common/updateFlutterAppVersion',
  getFlutterAppVersion: '/v2/common/getFlutterAppVersion',
  updateCompanyLogo: '/v2/common/updateCompanyLogo',

  // --- Path-variable addressed reads ----------------------------------------------------
  getCompanyNameExistOnKpostAndKsmacc: '/v2/common/getCompanyNameExistOnKpostAndKsmacc',
  downloadCompanyLogo: '/v2/common/downloadCompanyLogo',
} as const;

export class CommonClient extends BaseClient {
  sendOTP(data: unknown, options?: RequestOptions): Promise<APIResponse> {
    return this.post(COMMON_PATHS.sendOTP, data, options);
  }

  validateOTP(data: unknown, options?: RequestOptions): Promise<APIResponse> {
    return this.post(COMMON_PATHS.validateOTP, data, options);
  }

  sendOTPtoMail(data: unknown, options?: RequestOptions): Promise<APIResponse> {
    return this.post(COMMON_PATHS.sendOTPtoMail, data, options);
  }

  validateMailOTP(data: unknown, options?: RequestOptions): Promise<APIResponse> {
    return this.post(COMMON_PATHS.validateMailOTP, data, options);
  }

  mobileNoExist(data: unknown, options?: RequestOptions): Promise<APIResponse> {
    return this.post(COMMON_PATHS.mobileNoExist, data, options);
  }

  isCompanyNameExist(data: unknown, options?: RequestOptions): Promise<APIResponse> {
    return this.post(COMMON_PATHS.isCompanyNameExist, data, options);
  }

  countries(options?: RequestOptions): Promise<APIResponse> {
    return this.get(COMMON_PATHS.countries, options);
  }

  country(data: unknown, options?: RequestOptions): Promise<APIResponse> {
    return this.post(COMMON_PATHS.country, data, options);
  }

  getStates(options?: RequestOptions): Promise<APIResponse> {
    return this.get(COMMON_PATHS.getStates, options);
  }

  pinCode(data: unknown, options?: RequestOptions): Promise<APIResponse> {
    return this.post(COMMON_PATHS.pinCode, data, options);
  }

  postalPinCode(data: unknown, options?: RequestOptions): Promise<APIResponse> {
    return this.post(COMMON_PATHS.postalPinCode, data, options);
  }

  getProfession(options?: RequestOptions): Promise<APIResponse> {
    return this.get(COMMON_PATHS.getProfession, options);
  }

  getDesignation(data: unknown, options?: RequestOptions): Promise<APIResponse> {
    return this.post(COMMON_PATHS.getDesignation, data, options);
  }

  getDesignationByProfessionId(data: unknown, options?: RequestOptions): Promise<APIResponse> {
    return this.post(COMMON_PATHS.getDesignationByProfessionId, data, options);
  }

  forgotPasswordOTPOrSentKpostIDSms(data: unknown, options?: RequestOptions): Promise<APIResponse> {
    return this.post(COMMON_PATHS.forgotPasswordOTPOrSentKpostIDSms, data, options);
  }

  forgotPasswordUpdate(data: unknown, options?: RequestOptions): Promise<APIResponse> {
    return this.post(COMMON_PATHS.forgotPasswordUpdate, data, options);
  }

  domain(data: unknown, options?: RequestOptions): Promise<APIResponse> {
    return this.post(COMMON_PATHS.domain, data, options);
  }

  generateDomainAndUniqueName(data: unknown, options?: RequestOptions): Promise<APIResponse> {
    return this.post(COMMON_PATHS.generateDomainAndUniqueName, data, options);
  }

  msStatus(options?: RequestOptions): Promise<APIResponse> {
    return this.get(COMMON_PATHS.msStatus, options);
  }

  saveEnquiryDetails(data: unknown, options?: RequestOptions): Promise<APIResponse> {
    return this.post(COMMON_PATHS.saveEnquiryDetails, data, options);
  }

  saveUnsubscriberDetails(data: unknown, options?: RequestOptions): Promise<APIResponse> {
    return this.post(COMMON_PATHS.saveUnsubscriberDetails, data, options);
  }

  /* ---- directory and company lookups ---- */

  getUserDetailsByMobNo(data: unknown, options?: RequestOptions): Promise<APIResponse> {
    return this.post(COMMON_PATHS.getUserDetailsByMobNo, data, options);
  }

  getKpostIdUsingModule(data: unknown, options?: RequestOptions): Promise<APIResponse> {
    return this.post(COMMON_PATHS.getKpostIdUsingModule, data, options);
  }

  getCompanyDetails(data: unknown, options?: RequestOptions): Promise<APIResponse> {
    return this.post(COMMON_PATHS.getCompanyDetails, data, options);
  }

  getCompanyDetailsByAdmin(data: unknown, options?: RequestOptions): Promise<APIResponse> {
    return this.post(COMMON_PATHS.getCompanyDetailsByAdmin, data, options);
  }

  getCompanyDetailsByMobileNoAndproductId(
    data: unknown,
    options?: RequestOptions
  ): Promise<APIResponse> {
    return this.post(COMMON_PATHS.getCompanyDetailsByMobileNoAndproductId, data, options);
  }

  mobileNoExistInsideCompany(data: unknown, options?: RequestOptions): Promise<APIResponse> {
    return this.post(COMMON_PATHS.mobileNoExistInsideCompany, data, options);
  }

  uniqueNameExist(data: unknown, options?: RequestOptions): Promise<APIResponse> {
    return this.post(COMMON_PATHS.uniqueNameExist, data, options);
  }

  getCitiesByRegionId(data: unknown, options?: RequestOptions): Promise<APIResponse> {
    return this.post(COMMON_PATHS.getCitiesByRegionId, data, options);
  }

  languages(data: unknown, options?: RequestOptions): Promise<APIResponse> {
    return this.post(COMMON_PATHS.languages, data, options);
  }

  languagesLegacy(data: unknown, options?: RequestOptions): Promise<APIResponse> {
    return this.post(COMMON_PATHS.languagesLegacy, data, options);
  }

  getTotalCountByDate(data: unknown, options?: RequestOptions): Promise<APIResponse> {
    return this.post(COMMON_PATHS.getTotalCountByDate, data, options);
  }

  /* ---- writes on the unauthenticated tree ---- */

  /**
   * Unauthenticated Katchup bridge. `sender` and `receiver` come from the body, so this is
   * exercised with synthetic identities only — a real receiver would get a real message.
   */
  sendMessage(data: unknown, options?: RequestOptions): Promise<APIResponse> {
    return this.post(COMMON_PATHS.sendMessage, data, options);
  }

  /**
   * DESTRUCTIVE (global config). Changes the app version every Flutter client is told to run.
   * Exercised on refusal paths only — never with a body that could succeed.
   */
  updateFlutterAppVersion(data: unknown, options?: RequestOptions): Promise<APIResponse> {
    return this.post(COMMON_PATHS.updateFlutterAppVersion, data, options);
  }

  getFlutterAppVersion(options?: RequestOptions): Promise<APIResponse> {
    return this.get(COMMON_PATHS.getFlutterAppVersion, options);
  }

  updateCompanyLogo(data: unknown, options?: RequestOptions): Promise<APIResponse> {
    return this.post(COMMON_PATHS.updateCompanyLogo, data, options);
  }

  /**
   * A registration-time availability check across both KPOST and KSMACC. The company name
   * travels in the **path**, which is why every reserved character matters here.
   */
  getCompanyNameExistOnKpostAndKsmacc(
    companyName: string,
    options?: RequestOptions
  ): Promise<APIResponse> {
    return this.get(
      `${COMMON_PATHS.getCompanyNameExistOnKpostAndKsmacc}/${encodeURIComponent(companyName)}`,
      options
    );
  }

  downloadCompanyLogo(companyID: string, options?: RequestOptions): Promise<APIResponse> {
    return this.get(
      `${COMMON_PATHS.downloadCompanyLogo}/${encodeURIComponent(companyID)}`,
      options
    );
  }

  /** Unencoded path variant — lets traversal and injection payloads reach the server intact. */
  getRawPath(path: string, options?: RequestOptions): Promise<APIResponse> {
    return this.get(path, options);
  }

  /** Drives an arbitrary verb at an arbitrary common path — for verb-binding checks. */
  sendVerb(
    method: 'get' | 'put' | 'patch' | 'delete' | 'head' | 'options',
    path: string,
    options?: RequestOptions
  ): Promise<APIResponse> {
    return this.fetchWithVerb(method, path, options);
  }

  /** Raw-body variant for malformed-JSON fuzzing against any common path. */
  postRawTo(path: string, body: string, options?: RequestOptions): Promise<APIResponse> {
    return this.postRaw(path, body, options);
  }
}
