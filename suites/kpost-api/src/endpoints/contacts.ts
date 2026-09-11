import { contactsDeltaSchema, addContactResponseSchema } from '../api/schemas/contactsDirectoryV2.schema';
import {
  buildContactSyncPayload,
  buildGlobalSearchPayload,
  buildRealContactPayload,
} from '../api/payloads/contactsDirectoryV2.payload';
import { defineFamily } from '../engine';
import type { EndpointDefinition } from '../engine';

/**
 * Contacts Directory V2 — declarations only.
 *
 * The four sync reads share one DTO, one policy and one payload, so they are declared as a family:
 * the policy is stated once, explicitly, and each member is a line. Nothing here is a default the
 * engine applied on its own.
 */
const syncReads: EndpointDefinition[] = defineFamily(
  {
    auth: 'secured',
    expectedStatuses: [200, 400],
    module: 'Contacts Directory V2',
    responseSchema: contactsDeltaSchema,
    responseContentType: 'application/json',
    buildRequest: () => buildContactSyncPayload(),
    performance: 'search',
    readOnly: true,
    authorization: { USER: 'ALLOW', UNAUTHENTICATED: 'DENY' },
    skip: {
      database: 'read-only; nothing written to verify',
      businessRules: 'sync-cursor semantics covered by tests/contactsDirectoryV2/contactSync.spec.ts',
    },
  },
  [
    { id: 'contacts.myContacts', method: 'POST', path: '/v2/contacts/myContacts/' },
    { id: 'contacts.myGroups', method: 'POST', path: '/v2/contacts/myGroups/' },
    { id: 'contacts.myUnknownGroups', method: 'POST', path: '/v2/contacts/myUnknownGroups/' },
    {
      id: 'contacts.myUnknownKatchupContacts',
      method: 'POST',
      path: '/v2/contacts/myUnknownKatchupContacts/',
    },
  ]
);

const writes: EndpointDefinition[] = defineFamily(
  {
    auth: 'secured',
    expectedStatuses: [200, 400],
    module: 'Contacts Directory V2',
    responseContentType: 'application/json',
    authorization: { USER: 'ALLOW', UNAUTHENTICATED: 'DENY' },
    performance: 'write',
    skip: {
      database: 'no verified column map for the contacts tables yet',
      businessRules: 'covered by tests/contactsDirectoryV2/contactDirectory.spec.ts',
    },
  },
  [
    {
      id: 'contacts.addContact',
      method: 'POST',
      path: '/v2/contacts/addContact',
      // A REAL contact id: only a registered KPost user can be added, so a synthetic id can
      // never succeed and the happy path would report a working endpoint as broken.
      buildRequest: () => buildRealContactPayload(),
      responseSchema: addContactResponseSchema,
      requiredFields: ['contactID'],
    },
  ]
);

const search: EndpointDefinition[] = defineFamily(
  {
    auth: 'secured',
    expectedStatuses: [200],
    module: 'Contacts Directory V2',
    responseContentType: 'application/json',
    buildRequest: () => buildGlobalSearchPayload(),
    performance: 'search',
    readOnly: true,
    authorization: { USER: 'ALLOW', UNAUTHENTICATED: 'DENY' },
    skip: {
      database: 'read-only; nothing written to verify',
      businessRules: 'directory-scoping rules covered by tests/contactsDirectoryV2/contactSearch.spec.ts',
    },
  },
  [{ id: 'contacts.globalSearch', method: 'POST', path: '/v2/contacts/globalSearch/' }]
);

export const contactsEndpoints: EndpointDefinition[] = [...syncReads, ...writes, ...search];
