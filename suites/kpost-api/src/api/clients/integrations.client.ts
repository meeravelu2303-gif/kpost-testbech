import { APIResponse } from '@playwright/test';
import { BaseClient, RequestOptions } from './base.client';

/** The small integration tags (KPOST proxying third parties: payments, AI, voice, MetaDee). */
export const INTEGRATION_PATHS = {
  // --- AWS S3 pre-signed URLs ----------------------------------------------------------
  awsPresignedGet: '/v2/aws/generate-presigned-url',
  awsPresignedPost: '/v2/aws/generate-presigned-url',
  awsKatchupPresigned: '/v2/aws/katchup/generate-presigned-url',
  awsCheckAttachment: '/v2/aws/checkAttachmentS3',
  awsCheckAttachmentByUuid: (uuid: string) =>
    `/v2/aws/checkAttachmenS3/${encodeURIComponent(uuid)}`,
  awsDeleteAttachment: (uuid: string) =>
    `/v2/aws/deleteAttachmentFromS3/${encodeURIComponent(uuid)}`,

  // --- TA Wallet payments ---------------------------------------------------------------
  /** Signs arbitrary order fields with the merchant salt + apiKey. No identity check. */
  taWalletCreateHash: '/taWallet/createHash',
  taWalletPaymentRequest: '/taWallet/paymentRequest',
  taWalletFetchTransaction: '/taWallet/fetchTransactionDetailsByOrderId',
  taWalletSendCommunication: '/taWallet/sendCommunicationMessage',

  // --- AI assistant ----------------------------------------------------------------------
  aiMessageAssist: '/ai/messageAssist',
  aiMessageAssistStream: '/ai/messageAssistStream',
  aiChatResponse: '/ai/chatResponse',
  aiSessions: '/ai/sessions',
  aiSessionsByType: (aiType: string) => `/ai/sessions/${encodeURIComponent(aiType)}`,
  aiMessages: (sessionId: string) => `/ai/messages/${encodeURIComponent(sessionId)}`,

  // --- Small platform integrations --------------------------------------------------------
  voiceTranslate: '/v2/voice/translate',
  metaDeeAiMessage: '/metaDee/aiMessage',
  firebaseNotificationForKall: '/v2/firebase/notificationForKall',
  ecommerceGetDetails: '/v2/ecommerce/getEcommerceDetails',
  ecommerceGetAll: '/v2/ecommerce/getAll',
  root: '/',
} as const;

/** Template form for bug-ledger metadata, so findings group by route not by id. */
export const INTEGRATION_PATH_TEMPLATES = {
  awsCheckAttachmentByUuid: '/v2/aws/checkAttachmenS3/{uuid}',
  awsDeleteAttachment: '/v2/aws/deleteAttachmentFromS3/{uuid}',
  aiSessionsByType: '/ai/sessions/{aiType}',
  aiMessages: '/ai/messages/{sessionId}',
} as const;

// Note: `checkAttachmenS3` is misspelled in the shipped API — the typo is preserved on purpose.
export class IntegrationsClient extends BaseClient {
  /* ---- AWS S3 ---- */

  awsPresignedUrlGet(options?: RequestOptions): Promise<APIResponse> {
    return this.get(INTEGRATION_PATHS.awsPresignedGet, options);
  }

  awsPresignedUrlPost(data: unknown, options?: RequestOptions): Promise<APIResponse> {
    return this.post(INTEGRATION_PATHS.awsPresignedPost, data, options);
  }

  awsKatchupPresignedUrl(data: unknown, options?: RequestOptions): Promise<APIResponse> {
    return this.post(INTEGRATION_PATHS.awsKatchupPresigned, data, options);
  }

  awsCheckAttachment(data: unknown, options?: RequestOptions): Promise<APIResponse> {
    return this.post(INTEGRATION_PATHS.awsCheckAttachment, data, options);
  }

  awsCheckAttachmentByUuid(uuid: string, options?: RequestOptions): Promise<APIResponse> {
    return this.get(INTEGRATION_PATHS.awsCheckAttachmentByUuid(uuid), options);
  }

  /** DESTRUCTIVE, and a GET. Always call with a UUID that cannot resolve. */
  awsDeleteAttachment(uuid: string, options?: RequestOptions): Promise<APIResponse> {
    return this.get(INTEGRATION_PATHS.awsDeleteAttachment(uuid), options);
  }

  /* ---- TA Wallet ---- */

  /** Signs order fields with the merchant salt — synthetic emails only (it persists by email). */
  taWalletCreateHash(data: unknown, options?: RequestOptions): Promise<APIResponse> {
    return this.post(INTEGRATION_PATHS.taWalletCreateHash, data, options);
  }

  /** Form-encoded gateway callback that persists a transaction verdict. */
  taWalletPaymentRequest(form: string, options: RequestOptions = {}): Promise<APIResponse> {
    return this.postRaw(INTEGRATION_PATHS.taWalletPaymentRequest, form, {
      ...options,
      headers: { 'Content-Type': 'application/x-www-form-urlencoded', ...options.headers },
    });
  }

  taWalletFetchTransaction(data: unknown, options?: RequestOptions): Promise<APIResponse> {
    return this.post(INTEGRATION_PATHS.taWalletFetchTransaction, data, options);
  }

  taWalletSendCommunication(data: unknown, options?: RequestOptions): Promise<APIResponse> {
    return this.post(INTEGRATION_PATHS.taWalletSendCommunication, data, options);
  }

  /* ---- AI assistant ---- */

  aiMessageAssist(data: unknown, options?: RequestOptions): Promise<APIResponse> {
    return this.post(INTEGRATION_PATHS.aiMessageAssist, data, options);
  }

  aiMessageAssistStream(data: unknown, options?: RequestOptions): Promise<APIResponse> {
    return this.post(INTEGRATION_PATHS.aiMessageAssistStream, data, options);
  }

  aiChatResponse(data: unknown, options?: RequestOptions): Promise<APIResponse> {
    return this.post(INTEGRATION_PATHS.aiChatResponse, data, options);
  }

  aiSessions(options?: RequestOptions): Promise<APIResponse> {
    return this.get(INTEGRATION_PATHS.aiSessions, options);
  }

  aiSessionsByType(aiType: string, options?: RequestOptions): Promise<APIResponse> {
    return this.get(INTEGRATION_PATHS.aiSessionsByType(aiType), options);
  }

  aiMessages(sessionId: string, options?: RequestOptions): Promise<APIResponse> {
    return this.get(INTEGRATION_PATHS.aiMessages(sessionId), options);
  }

  /* ---- small platform integrations ---- */

  voiceTranslate(data: unknown, options?: RequestOptions): Promise<APIResponse> {
    return this.post(INTEGRATION_PATHS.voiceTranslate, data, options);
  }

  metaDeeAiMessage(data: unknown, options?: RequestOptions): Promise<APIResponse> {
    return this.post(INTEGRATION_PATHS.metaDeeAiMessage, data, options);
  }

  firebaseNotificationForKall(options?: RequestOptions): Promise<APIResponse> {
    return this.get(INTEGRATION_PATHS.firebaseNotificationForKall, options);
  }

  ecommerceGetDetails(options?: RequestOptions): Promise<APIResponse> {
    return this.get(INTEGRATION_PATHS.ecommerceGetDetails, options);
  }

  ecommerceGetAll(options?: RequestOptions): Promise<APIResponse> {
    return this.get(INTEGRATION_PATHS.ecommerceGetAll, options);
  }

  root(options?: RequestOptions): Promise<APIResponse> {
    return this.get(INTEGRATION_PATHS.root, options);
  }

  /** Sends a raw, possibly malformed body to any route (parser-level fuzzing). */
  sendRaw(path: string, body: string, options?: RequestOptions): Promise<APIResponse> {
    return this.postRaw(path, body, options);
  }
}
