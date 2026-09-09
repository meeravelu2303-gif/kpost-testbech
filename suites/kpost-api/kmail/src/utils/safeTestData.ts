import { env } from '../config/env.config';
import { faker } from './dataGen';

/**
 * Recipient and identifier helpers for a suite that **sends real mail**.
 *
 * This is the file that stands between a test run and somebody's inbox. `postMail`,
 * `postBulkMail` and both multipart send routes deliver to whatever address the payload
 * names, and this suite fires them hundreds of times per run — so no builder anywhere in
 * `src/api/payloads/` may invent a recipient of its own. They all come from here.
 */

/**
 * A well-formed KPOST address that is not a real subscriber.
 *
 * The `qa-noreply-` prefix plus eight random characters is deliberately unguessable: the
 * point is not that the address looks synthetic to a human, but that it cannot collide with
 * a real account on a shared environment, where a plausible-looking handle eventually will.
 */
export function syntheticRecipient(): string {
  return `qa-noreply-${faker.string.alphanumeric({ length: 8, casing: 'lower' })}@${env.syntheticMailDomain}`;
}

/**
 * A well-formed **external** address, for the other-domain contact and mail routes.
 *
 * `example.com` is reserved by RFC 2606 and cannot resolve to a real mailbox, which matters
 * more here than on the KPOST-side addresses: an external recipient is handed to the upstream
 * mail server, so a deliverable value would leave the platform entirely.
 */
export function syntheticExternalRecipient(): string {
  return `qa-noreply-${faker.string.alphanumeric({ length: 8, casing: 'lower' })}@example.com`;
}

/**
 * A `kmailID` that must not resolve to a real mail.
 *
 * Based well above any plausible auto-increment value on a bench database. The delete and
 * flag routes act on whatever they match, so an id chosen from the range real rows occupy
 * would eventually hide somebody's mail rather than proving anything.
 */
export function nonExistentKmailId(): number {
  return 995_000_000 + faker.number.int({ min: 1, max: 999_999 });
}

/** A `KmailTransaction` id that must not resolve to a real per-recipient row. */
export function nonExistentTransactionId(): number {
  return 996_000_000 + faker.number.int({ min: 1, max: 999_999 });
}

/** An attachment UUID that must not resolve to a real S3 object. */
export function nonExistentUuid(): string {
  return faker.string.uuid();
}

/**
 * A timestamp in the JDBC form the KMail DTOs document: `yyyy-MM-dd HH:mm:ss.SSS`.
 *
 * Not ISO-8601. The service parses these with a `java.sql.Timestamp` format, and an ISO
 * string with a `T` separator fails that parse — which surfaces as a 500 on a route that has
 * nothing wrong with it.
 */
export function jdbcTimestamp(offsetMinutes = 0): string {
  const at = new Date(Date.now() + offsetMinutes * 60_000);
  const pad = (value: number, width = 2): string => String(value).padStart(width, '0');
  return (
    `${at.getFullYear()}-${pad(at.getMonth() + 1)}-${pad(at.getDate())} ` +
    `${pad(at.getHours())}:${pad(at.getMinutes())}:${pad(at.getSeconds())}.` +
    `${pad(at.getMilliseconds(), 3)}`
  );
}

/** Marks records this suite creates so they are recognisable in a shared environment. */
export function qaLabel(subject: string): string {
  return `QA-AUTOMATION-${subject}-${faker.string.alphanumeric(6)}`;
}

/** Random-but-safe identifier for fields that never trigger a dispatch. */
export function qaIdentifier(prefix = 'qa'): string {
  return `${prefix}${faker.string.alphanumeric({ length: 8, casing: 'lower' })}`;
}

/**
 * A mail body, as the HTML fragment `kmailContent` expects.
 *
 * Carries a `qaLabel` so anything that does land in a real mailbox is obviously test traffic,
 * and so a leaked body found in another user's mailbox during an ownership test can be traced
 * back to the run that sent it.
 */
export function qaMailBody(subject = 'body'): string {
  return `<p>${qaLabel(subject)}</p><p>${faker.lorem.paragraph()}</p>`;
}
