import { APIResponse } from '@playwright/test';
import { BaseClient, RequestOptions } from './base.client';

export const CRYPTO_PATHS = {
  publicKey: '/crypto/public-key',
} as const;

export class CryptoClient extends BaseClient {
  getPublicKey(options?: RequestOptions): Promise<APIResponse> {
    return this.get(CRYPTO_PATHS.publicKey, options);
  }

  /** Method-not-allowed probing for the read-only key endpoint. */
  postPublicKey(data: unknown, options?: RequestOptions): Promise<APIResponse> {
    return this.post(CRYPTO_PATHS.publicKey, data, options);
  }
}
