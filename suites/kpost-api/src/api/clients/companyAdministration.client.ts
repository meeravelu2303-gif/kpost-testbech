import { APIResponse } from '@playwright/test';
import { BaseClient, RequestOptions } from './base.client';

/** Every route on the Company Administration controller, in one place. */
export const COMPANY_ADMIN_PATHS = {
  addingUserByAdmin: '/admin/addingUserByAdmin',
  addingUserForReallocateByAdmin: '/admin/addingUserForReallocateByAdmin',
  createKpostIDAndDesignationSuggestion: '/admin/createKpostIDAndDesignationSuggestion',
  createOrRemoveBackupAdmin: '/admin/createOrRemoveBackupAdmin',
  displayNameSuggestion: '/admin/displayNameSuggestion',
  holdOrRelease: '/admin/holdOrRelease',
  removeCompanyLogo: '/admin/removeCompanyLogo',
  resetPassword: '/admin/resetPassword',
  terminateUser: '/admin/terminateUser',
  updateBankAccountDetails: '/admin/updateBankAccountDetails',
  updateCompanyDetails: '/admin/updateCompanyDetails',
  updateRole: '/admin/updateRole',
  userManagementDetails: (companyID: string) =>
    `/admin/userManagementDetails/${encodeURIComponent(companyID)}`,
  getBankAndCompanyDetails: (companyID: string) =>
    `/admin/getBankAndCompanyDetails/${encodeURIComponent(companyID)}`,
} as const;

/** Template forms used for bug-ledger metadata, so findings group by route not by id. */
export const COMPANY_ADMIN_PATH_TEMPLATES = {
  userManagementDetails: '/admin/userManagementDetails/{companyID}',
  getBankAndCompanyDetails: '/admin/getBankAndCompanyDetails/{companyID}',
} as const;

// Entire tree is gated by hasRole("admin") — every method is privileged, and several are
// irreversible (terminateUser, resetPassword). Target throwaway identities only, never a real employee.
export class CompanyAdministrationClient extends BaseClient {
  /** Provision a new employee account. The acting admin is stamped from the token. */
  addingUserByAdmin(data: unknown, options?: RequestOptions): Promise<APIResponse> {
    return this.post(COMPANY_ADMIN_PATHS.addingUserByAdmin, data, options);
  }

  /** Rebind an existing kpostID to a new person (identity reallocation). */
  addingUserForReallocateByAdmin(data: unknown, options?: RequestOptions): Promise<APIResponse> {
    return this.post(COMPANY_ADMIN_PATHS.addingUserForReallocateByAdmin, data, options);
  }

  /** Suggest a kpostID and designation for a new employee. */
  createKpostIDAndDesignationSuggestion(
    data: unknown,
    options?: RequestOptions
  ): Promise<APIResponse> {
    return this.post(COMPANY_ADMIN_PATHS.createKpostIDAndDesignationSuggestion, data, options);
  }

  /** Grant or revoke backup-administrator rights. */
  createOrRemoveBackupAdmin(data: unknown, options?: RequestOptions): Promise<APIResponse> {
    return this.post(COMPANY_ADMIN_PATHS.createOrRemoveBackupAdmin, data, options);
  }

  /** Derive a display name from a company name and designation. */
  displayNameSuggestion(data: unknown, options?: RequestOptions): Promise<APIResponse> {
    return this.post(COMPANY_ADMIN_PATHS.displayNameSuggestion, data, options);
  }

  /** Suspend or reinstate a user account (reversible, unlike terminateUser). */
  holdOrRelease(data: unknown, options?: RequestOptions): Promise<APIResponse> {
    return this.post(COMPANY_ADMIN_PATHS.holdOrRelease, data, options);
  }

  /** Clear the company logo (implemented server-side as an update-to-null). */
  removeCompanyLogo(data: unknown, options?: RequestOptions): Promise<APIResponse> {
    return this.post(COMPANY_ADMIN_PATHS.removeCompanyLogo, data, options);
  }

  /** Reset an employee's password — irrecoverable and dispatches the new one; throwaway ids only. */
  resetPassword(data: unknown, options?: RequestOptions): Promise<APIResponse> {
    return this.post(COMPANY_ADMIN_PATHS.resetPassword, data, options);
  }

  /** Permanently terminate an employee account. Not reversible through the API. */
  terminateUser(data: unknown, options?: RequestOptions): Promise<APIResponse> {
    return this.post(COMPANY_ADMIN_PATHS.terminateUser, data, options);
  }

  /** Update the company's settlement (bank account) details. Financially sensitive. */
  updateBankAccountDetails(data: unknown, options?: RequestOptions): Promise<APIResponse> {
    return this.post(COMPANY_ADMIN_PATHS.updateBankAccountDetails, data, options);
  }

  /** Amend the company's registered profile. */
  updateCompanyDetails(data: unknown, options?: RequestOptions): Promise<APIResponse> {
    return this.post(COMPANY_ADMIN_PATHS.updateCompanyDetails, data, options);
  }

  /** Change a user's role. Granting "admin" unlocks the whole /admin/** tree. */
  updateRole(data: unknown, options?: RequestOptions): Promise<APIResponse> {
    return this.post(COMPANY_ADMIN_PATHS.updateRole, data, options);
  }

  /** List every user in a company, with role and account state. */
  userManagementDetails(companyID: string, options?: RequestOptions): Promise<APIResponse> {
    return this.get(COMPANY_ADMIN_PATHS.userManagementDetails(companyID), options);
  }

  /** Read a company's combined profile and settlement details. */
  getBankAndCompanyDetails(companyID: string, options?: RequestOptions): Promise<APIResponse> {
    return this.get(COMPANY_ADMIN_PATHS.getBankAndCompanyDetails(companyID), options);
  }

  /** Sends a raw, possibly malformed body to any route (parser-level fuzzing). */
  sendRaw(path: string, body: string, options?: RequestOptions): Promise<APIResponse> {
    return this.postRaw(path, body, options);
  }
}
