import {
  katchupMessageListResponseSchema,
  katchupMessageResponseSchema,
} from '../api/schemas/katchupV2.schema';
import {
  buildFetchKatchupPayload,
  buildKatchupMessagePayload,
} from '../api/payloads/katchupV2.payload';
import { FOREIGN } from '../api/clients/generic.client';
import { defineEndpoints } from '../engine';
import type { EndpointDefinition } from '../engine';

/**
 * Katchup endpoints — declarations only.
 *
 * Payload builders are reused, never re-declared: they are Excel-aligned and gated at 100% by
 * `npm run audit:excel`. A definition with its own body would drift from the workbook unseen.
 */
export const katchupEndpoints: EndpointDefinition[] = defineEndpoints([
  {
    id: 'katchup.sendMessage',
    method: 'POST',
    path: '/v2/katchup/sendMessage',
    module: 'Katchup Messaging V2',
    auth: 'secured',
    // 400 is expected: BR-K01 requires a subject, and a non-existent receiver is refused.
    expectedStatuses: [200, 400],
    buildRequest: () =>
      buildKatchupMessagePayload({
        subject: `QA-ENGINE-${Date.now()}`,
        receiver: FOREIGN.victimKpostID,
      }),
    responseSchema: katchupMessageResponseSchema,
    responseContentType: 'application/json',
    requiredFields: ['subject', 'receiver'],
    performance: 'write',
    authorization: { USER: 'ALLOW', UNAUTHENTICATED: 'DENY' },
    skip: {
      businessRules: 'covered by tests/katchupV2/businessRules.spec.ts (FR-K01..K11, NFR-SEC02)',
      database: 'no verified column map for tbl_kpost_katchup_messages yet',
    },
  },

  {
    // Excel row: /v2/katchup/katchupMessagesForSelectedContactID/ — contract-backed.
    id: 'katchup.messagesForContact',
    method: 'POST',
    path: '/v2/katchup/katchupMessagesForSelectedContactID',
    module: 'Katchup Messaging V2',
    auth: 'secured',
    expectedStatuses: [200, 400],
    buildRequest: () =>
      buildFetchKatchupPayload({
        selectedContact: FOREIGN.victimKpostID,
        receiver: FOREIGN.victimKpostID,
      }),
    responseSchema: katchupMessageListResponseSchema,
    responseContentType: 'application/json',
    requiredFields: ['receiver'],
    performance: 'search',
    readOnly: true,
    authorization: { USER: 'ALLOW', UNAUTHENTICATED: 'DENY' },
    skip: {
      database: 'read-only; nothing written to verify',
      businessRules: 'conversation semantics covered by tests/katchupV2/',
    },
  },

  {
    id: 'katchup.unopenedCount',
    method: 'GET',
    path: '/v2/katchup/getUnopenedMessagesCount',
    module: 'Katchup Messaging V2',
    auth: 'secured',
    expectedStatuses: [200],
    responseContentType: 'application/json',
    performance: 'fastRead',
    readOnly: true,
    authorization: { USER: 'ALLOW', UNAUTHENTICATED: 'DENY' },
    skip: {
      request: 'GET with no body — no field to fuzz',
      security: 'GET with no body — no injection surface',
      database: 'read-only; nothing written to verify',
      businessRules: 'counter semantics covered by tests/katchupV2/',
    },
  },
]);
