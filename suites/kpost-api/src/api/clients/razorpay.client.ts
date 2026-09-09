import { APIResponse } from '@playwright/test';
import { BaseClient, RequestOptions } from './base.client';

export const RAZORPAY_PATHS = {
  generateOrderId: '/razorPay/generateOrderId',
  validateAndUpdateTransactionDetails: '/razorPay/validateAndUpdateTransactionDetails',
} as const;

export class RazorpayClient extends BaseClient {
  generateOrderId(data: unknown, options?: RequestOptions): Promise<APIResponse> {
    return this.post(RAZORPAY_PATHS.generateOrderId, data, options);
  }

  validateAndUpdateTransactionDetails(data: unknown, options?: RequestOptions): Promise<APIResponse> {
    return this.post(RAZORPAY_PATHS.validateAndUpdateTransactionDetails, data, options);
  }

  generateOrderIdRaw(body: string, options?: RequestOptions): Promise<APIResponse> {
    return this.postRaw(RAZORPAY_PATHS.generateOrderId, body, options);
  }

  validateTransactionRaw(body: string, options?: RequestOptions): Promise<APIResponse> {
    return this.postRaw(RAZORPAY_PATHS.validateAndUpdateTransactionDetails, body, options);
  }
}
