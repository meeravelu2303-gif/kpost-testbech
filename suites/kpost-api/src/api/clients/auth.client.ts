import { APIResponse } from '@playwright/test';
import { BaseClient, RequestOptions } from './base.client';

export const AUTH_PATHS = {
  signup: '/v2/signupLogin/signup',
  userLogin: '/v2/signupLogin/userLogin',
  userLogout: '/v2/signupLogin/userLogout',
  setAccessCode: '/v2/signupLogin/setAccessCode',
  kpostIdExist: '/v2/signupLogin/kpostIdExist',
  kpostIDsuggestionList: '/v2/signupLogin/kpostIDsuggestionList',
  getLoginHistory: '/v2/signupLogin/getLoginHistory',
  generateJWTokens: '/v2/signupLogin/generateJWTokens',
  fetchUserDetails: '/v2/signupLogin/fetchUserDetails',
  fetchPersonalUserDetails: '/v2/signupLogin/fetchPersonalUserDetails',
  adminRegistration: '/v2/signupLogin/adminRegistration',
  userLogoutFromAllDevices: '/v2/signupLogin/userLogoutFromAllDevices',
  getActiveSession: '/v2/signupLogin/getActiveSession',
} as const;

export class AuthClient extends BaseClient {
  signup(data: unknown, options?: RequestOptions): Promise<APIResponse> {
    return this.post(AUTH_PATHS.signup, data, options);
  }

  userLogin(data: unknown, options?: RequestOptions): Promise<APIResponse> {
    return this.post(AUTH_PATHS.userLogin, data, options);
  }

  userLogout(data: unknown, options?: RequestOptions): Promise<APIResponse> {
    return this.post(AUTH_PATHS.userLogout, data, options);
  }

  setAccessCode(data: unknown, options?: RequestOptions): Promise<APIResponse> {
    return this.post(AUTH_PATHS.setAccessCode, data, options);
  }

  kpostIdExist(data: unknown, options?: RequestOptions): Promise<APIResponse> {
    return this.post(AUTH_PATHS.kpostIdExist, data, options);
  }

  kpostIdSuggestionList(data: unknown, options?: RequestOptions): Promise<APIResponse> {
    return this.post(AUTH_PATHS.kpostIDsuggestionList, data, options);
  }

  getLoginHistory(data: unknown, options?: RequestOptions): Promise<APIResponse> {
    return this.post(AUTH_PATHS.getLoginHistory, data, options);
  }

  generateJWTokens(data: unknown, options?: RequestOptions): Promise<APIResponse> {
    return this.post(AUTH_PATHS.generateJWTokens, data, options);
  }

  fetchUserDetails(data: unknown, options?: RequestOptions): Promise<APIResponse> {
    return this.post(AUTH_PATHS.fetchUserDetails, data, options);
  }

  fetchPersonalUserDetails(data: unknown, options?: RequestOptions): Promise<APIResponse> {
    return this.post(AUTH_PATHS.fetchPersonalUserDetails, data, options);
  }

  adminRegistration(data: unknown, options?: RequestOptions): Promise<APIResponse> {
    return this.post(AUTH_PATHS.adminRegistration, data, options);
  }

  userLogoutFromAllDevices(options?: RequestOptions): Promise<APIResponse> {
    return this.get(AUTH_PATHS.userLogoutFromAllDevices, options);
  }

  getActiveSession(options?: RequestOptions): Promise<APIResponse> {
    return this.get(AUTH_PATHS.getActiveSession, options);
  }

  /** Raw-body variants for malformed-JSON fuzzing. */
  signupRaw(body: string, options?: RequestOptions): Promise<APIResponse> {
    return this.postRaw(AUTH_PATHS.signup, body, options);
  }

  userLoginRaw(body: string, options?: RequestOptions): Promise<APIResponse> {
    return this.postRaw(AUTH_PATHS.userLogin, body, options);
  }
}
