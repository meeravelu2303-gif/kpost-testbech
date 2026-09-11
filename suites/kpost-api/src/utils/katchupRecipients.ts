import type { APIResponse } from '@playwright/test';
import type { AuthClient } from '../api/clients/auth.client';
import type { KatchupV2Client } from '../api/clients/katchupV2.client';
import { buildLoginPayload } from '../api/payloads/auth.payload';
import { env } from '../config/env.config';
import { readBody } from './apiAssertions';

/*
 * Reading a Katchup message AS ITS RECIPIENT — the vantage-point rule (root CLAUDE.md, trap #5)
 * made reusable. Any rule about who can see what is judged from the affected party's own fetch,
 * never from the sender's response, so every such test needs: log in as that party, find the
 * message in their conversation, and read the Cc / Confidential lists off their copy.
 */

/** The size-suffixed tier a QA business account must log in with; null for a personal account. */
export function businessTierOf(kpostID: string): string | null {
  const tier = /@m\d+([sml])\.kpost\.in$/i.exec(kpostID)?.[1];
  return tier ? `BUSINESS_${tier.toUpperCase()}` : null;
}

const tokens = new Map<string, string>();

/**
 * A bearer token for `kpostID`, on a throwaway device id so the shared session is never evicted.
 *
 * Cached per worker: these tests log in three recipients each, and without the cache a full run
 * trips the auth throttle. A 429 is waited out (it names its own retry delay) rather than treated
 * as a failed login — a throttled login is the environment, not the account.
 */
export async function loginAs(authClient: AuthClient, kpostID: string): Promise<string | null> {
  const cached = tokens.get(kpostID);
  if (cached) return cached;

  const tier = businessTierOf(kpostID);
  for (let attempt = 0; attempt < 3; attempt++) {
    const response = await authClient.userLogin(
      buildLoginPayload(kpostID, env.qaPassword, {
        deviceIdentity_primary: `qa-recipient-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
        ...(tier
          ? { loginRO: { countryID: env.qaCountryId, password: env.qaPassword, userType: tier } }
          : {}),
      }),
    );
    const text = await response.text();
    const token = /eyJ[\w-]+\.[\w-]+\.[\w-]+/.exec(text)?.[0] ?? null;
    if (token) {
      tokens.set(kpostID, token);
      return token;
    }
    if (response.status() !== 429) return null;
    const wait = Number(/retry in (\d+) seconds/i.exec(text)?.[1] ?? 5);
    await new Promise((resolve) => setTimeout(resolve, Math.min(wait, 20) * 1000 + 250));
  }
  return null;
}

/**
 * The recipient's own copy of the message with `subject`, from their conversation with `sender`.
 * Polls for up to ~15 s, because a rule must not pass or skip by default just because delivery was
 * slow. `response` is the recipient's last read — the evidence to attach to any finding.
 */
export async function recipientCopy(
  client: KatchupV2Client,
  token: string,
  sender: string,
  subject: string,
): Promise<{ row: Record<string, unknown> | undefined; response: APIResponse }> {
  let response: APIResponse | undefined;
  for (let attempt = 0; attempt < 15; attempt++) {
    response = await client.katchupMessagesForSelectedContactID(
      {
        selectedContact: sender,
        receiver: sender,
        groupFlag: false,
        firstMsgID: null,
        lastMsgID: null,
        msgID: 0,
      },
      { token },
    );
    const { json } = await readBody(response);
    const rows = (json as { data?: Array<Record<string, unknown>> } | null)?.data;
    const row = Array.isArray(rows)
      ? rows.find((r) => String(r.subject ?? '') === subject)
      : undefined;
    if (row) return { row, response };
    await new Promise((resolve) => setTimeout(resolve, 1000));
  }
  return { row: undefined, response: response as APIResponse };
}

/** The Cc (`revealContactList`) and Confidential (`hiddenContactList`) lists on one copy. */
export function contactListsOf(row: Record<string, unknown>): {
  reveal: string[];
  hidden: string[];
} {
  let details: unknown = row.sharedMessageDetails;
  if (typeof details === 'string') {
    try {
      details = JSON.parse(details) as unknown;
    } catch {
      details = null;
    }
  }
  const list = (key: string): string[] => {
    const value = (details as Record<string, unknown> | null)?.[key];
    return Array.isArray(value) ? value.map(String) : [];
  };
  return { reveal: list('revealContactList'), hidden: list('hiddenContactList') };
}

/** Every row in `viewer`'s conversation with `contact` — the raw list, for the sender's own view. */
export async function conversationRows(
  client: KatchupV2Client,
  token: string,
  contact: string,
): Promise<Array<Record<string, unknown>>> {
  const response = await client.katchupMessagesForSelectedContactID(
    {
      selectedContact: contact,
      receiver: contact,
      groupFlag: false,
      firstMsgID: null,
      lastMsgID: null,
      msgID: 0,
    },
    { token },
  );
  const { json } = await readBody(response);
  const rows = (json as { data?: Array<Record<string, unknown>> } | null)?.data;
  return Array.isArray(rows) ? rows : [];
}
