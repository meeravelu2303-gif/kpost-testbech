import { FilePart } from '../helpers/base.client';
import { env } from '../config/env.config';
import { qaIdentifier } from './safeTestData';

/**
 * Attachment fixtures for the multipart send, draft and letterhead routes.
 *
 * Everything here is generated in memory rather than read from a `fixtures/` directory. Three
 * reasons, in order of how much time each has cost elsewhere:
 *
 *  1. **Size is a test parameter.** The limit cases need a file just over a threshold; a
 *     checked-in binary would pin one size forever and a six-megabyte blob in git is its own
 *     problem.
 *  2. **Content type and magic bytes are a test parameter too.** The interesting attachment
 *     cases are the mismatches — a `.png` whose bytes are a ZIP, an executable renamed to
 *     `.txt` — and generating them makes the mismatch explicit in the test rather than hidden
 *     in a file nobody opens.
 *  3. No binary fixtures means no path resolution, which is the usual reason an attachment
 *     suite passes locally and fails on CI.
 */

/** A small, genuinely valid PNG — a 1×1 transparent pixel, byte for byte. */
const PNG_1X1 = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
  'base64'
);

/** The first bytes of a ZIP archive — used to build files whose extension lies about them. */
const ZIP_MAGIC = Buffer.from([0x50, 0x4b, 0x03, 0x04]);

/** A valid, minimal PDF document. */
const PDF_MINIMAL = Buffer.from(
  '%PDF-1.4\n1 0 obj<</Type/Catalog/Pages 2 0 R>>endobj\n' +
    '2 0 obj<</Type/Pages/Kids[3 0 R]/Count 1>>endobj\n' +
    '3 0 obj<</Type/Page/Parent 2 0 R/MediaBox[0 0 72 72]>>endobj\n' +
    'trailer<</Root 1 0 R>>\n%%EOF\n',
  'utf-8'
);

/** A small text attachment. The default for cases where the bytes do not matter. */
export function textAttachment(sizeBytes = 512): FilePart {
  return {
    name: `${qaIdentifier('qa-note')}.txt`,
    mimeType: 'text/plain',
    buffer: Buffer.alloc(sizeBytes, 'QA-AUTOMATION attachment payload. '),
  };
}

/** A genuinely valid 1×1 PNG, for the cases that need the bytes to parse as an image. */
export function pngAttachment(): FilePart {
  return {
    name: `${qaIdentifier('qa-image')}.png`,
    mimeType: 'image/png',
    buffer: PNG_1X1,
  };
}

/** A valid minimal PDF, for the document-attachment and PDF-conversion cases. */
export function pdfAttachment(): FilePart {
  return {
    name: `${qaIdentifier('qa-doc')}.pdf`,
    mimeType: 'application/pdf',
    buffer: PDF_MINIMAL,
  };
}

/**
 * An attachment of a given size in megabytes, capped at `MAX_ATTACHMENT_MB`.
 *
 * The cap is a safety rail, not a convenience. The limit specs want a file large enough to
 * cross whatever threshold the service enforces, and an uncapped helper invoked with a
 * mistyped argument will happily try to stream a gigabyte into the S3 bucket — a
 * self-inflicted outage rather than a finding. The specs assert against the size they
 * actually got, which this returns, so a capped run reports honestly instead of claiming to
 * have tested a limit it never reached.
 */
export function largeAttachment(requestedMb: number): FilePart {
  const mb = Math.min(requestedMb, env.maxAttachmentMb);
  return {
    name: `${qaIdentifier('qa-large')}-${mb}mb.bin`,
    mimeType: 'application/octet-stream',
    buffer: Buffer.alloc(mb * 1024 * 1024, 0x41),
  };
}

/** True when `largeAttachment` had to clamp — lets a spec state that it tested less. */
export function attachmentSizeWasCapped(requestedMb: number): boolean {
  return requestedMb > env.maxAttachmentMb;
}

/** A zero-byte file. Distinct from "no attachment", and a different branch in the service. */
export function emptyAttachment(): FilePart {
  return {
    name: `${qaIdentifier('qa-empty')}.txt`,
    mimeType: 'text/plain',
    buffer: Buffer.alloc(0),
  };
}

/**
 * A file whose extension and declared type say PNG while its bytes are a ZIP archive.
 *
 * The question this asks is whether the service trusts the client's `Content-Type` and file
 * name, or sniffs the content. It matters because the download routes serve these bytes back
 * with a type derived from the stored metadata: if the name decides the type, an archive —
 * or anything else — can be served to a browser as an image.
 */
export function contentTypeMismatchAttachment(): FilePart {
  return {
    name: `${qaIdentifier('qa-mismatch')}.png`,
    mimeType: 'image/png',
    buffer: Buffer.concat([ZIP_MAGIC, Buffer.alloc(256, 0x00)]),
  };
}

/**
 * A file name carrying a path traversal sequence.
 *
 * Attachments are streamed to S3 under a server-assigned key, so this should be inert. It is
 * asserted anyway because the *display* name is stored and echoed back, and a name that
 * reaches a filesystem path anywhere downstream — a PDF export, a local cache, a virus
 * scanner's temp directory — is where traversal actually bites.
 */
export function traversalNameAttachment(): FilePart {
  return {
    name: '../../../../etc/passwd',
    mimeType: 'text/plain',
    buffer: Buffer.from('QA-AUTOMATION traversal filename probe', 'utf-8'),
  };
}

/** A file name carrying a script payload, for the reflected-XSS cases on attachment lists. */
export function scriptNameAttachment(): FilePart {
  return {
    name: `<script>alert('xss')</script>.txt`,
    mimeType: 'text/plain',
    buffer: Buffer.from('QA-AUTOMATION script filename probe', 'utf-8'),
  };
}

/** A very long file name, for the column-width and truncation boundary. */
export function longNameAttachment(nameLength = 512): FilePart {
  return {
    name: `${'a'.repeat(nameLength)}.txt`,
    mimeType: 'text/plain',
    buffer: Buffer.from('QA-AUTOMATION long filename probe', 'utf-8'),
  };
}

/** A header/footer pair for `letterHeadUpload`, which requires both halves. */
export function letterHeadPair(): { headerFile: FilePart; footerFile: FilePart } {
  return {
    headerFile: { name: 'qa-letterhead-header.png', mimeType: 'image/png', buffer: PNG_1X1 },
    footerFile: { name: 'qa-letterhead-footer.png', mimeType: 'image/png', buffer: PNG_1X1 },
  };
}

/** A CSV recipient list, for `postBulkMailMultipart`. */
export function recipientCsv(addresses: string[]): FilePart {
  return {
    name: `${qaIdentifier('qa-recipients')}.csv`,
    mimeType: 'text/csv',
    buffer: Buffer.from(`email\n${addresses.join('\n')}\n`, 'utf-8'),
  };
}
