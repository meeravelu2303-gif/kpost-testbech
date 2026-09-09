import { APIRequestContext, APIResponse, test } from '@playwright/test';

export interface RequestOptions {
  /** Bearer token to attach. Pass `null` to send no Authorization header at all. */
  token?: string | null;
  headers?: Record<string, string>;
  params?: Record<string, string | number | boolean>;
}

/** A file part for the multipart send, draft and letterhead routes. */
export interface FilePart {
  name: string;
  mimeType: string;
  buffer: Buffer;
}

export type MultipartField = string | number | boolean | FilePart;

/**
 * One part of a hand-built `multipart/form-data` body.
 *
 * Needed because `postMailMultiPart` and `draftMailMultiPart` declare `files` as an **array**
 * of binaries — several parts sharing one field name. Playwright's `multipart` option is a
 * plain record, so it can carry at most one value per name and cannot express a two-attachment
 * send at all. `postMultipartRaw` builds the body itself for those cases; `postMultipart`
 * stays for the routes whose parts have distinct names, such as `letterHeadUpload`.
 */
export type MultipartPart =
  | { name: string; value: string }
  | { name: string; filename: string; mimeType: string; buffer: Buffer };

export interface CapturedRequest {
  body?: string;
  headers: Record<string, string>;
}

/**
 * What was actually sent, keyed by the response it produced.
 *
 * Playwright's `APIResponse` exposes no handle back to its request, but a finding's "steps to
 * reproduce" needs the exact payload and headers. Capturing here means every assertion gets
 * them automatically instead of each call site having to pass the body through by hand. A
 * WeakMap keeps this from retaining responses.
 */
const REQUEST_LOG = new WeakMap<APIResponse, CapturedRequest>();

export function capturedRequestFor(response: APIResponse): CapturedRequest | undefined {
  return REQUEST_LOG.get(response);
}

/** Redacts credential headers so tokens never reach a committed report. */
function safeHeaders(headers: Record<string, string>): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [key, value] of Object.entries(headers)) {
    out[key] = key.toLowerCase() === 'authorization' ? 'Bearer <redacted>' : value;
  }
  return out;
}

function serialize(data: unknown): string | undefined {
  if (data === undefined) return undefined;
  if (typeof data === 'string') return data;
  try {
    return JSON.stringify(data, null, 2);
  } catch {
    return String(data);
  }
}

/**
 * Attaches the full request/response exchange to the current test.
 *
 * Playwright attachments are rendered by the native HTML report, so this one hook gives every
 * test in the suite its payload, headers, status and timing without a single spec changing.
 *
 * Three deliberate constraints:
 *
 * - **Observational only.** It never reads the response body through `response.text()`, which
 *   would consume the stream the assertions need. It records the status, headers and timing,
 *   and the *request* body, which is the part a developer cannot reconstruct.
 * - **Silent on failure.** `test.info()` throws outside a running test, and an attachment
 *   failure must never turn a passing API call into a failing one.
 * - **Bounded.** A multi-megabyte attachment payload is truncated, because a handful of
 *   untruncated ones make a report nobody can open.
 */
async function attachExchange(
  method: string,
  response: APIResponse,
  headers: Record<string, string>,
  body: string | undefined,
  latencyMs: number
): Promise<void> {
  try {
    const info = test.info();
    if (!info) return;
    const cap = (value: string): string =>
      value.length <= 4000 ? value : `${value.slice(0, 4000)}\n…<truncated>`;

    await info.attach(`${method} ${response.status()} ${response.url()}`, {
      contentType: 'application/json',
      body: Buffer.from(
        JSON.stringify(
          {
            request: {
              method,
              url: response.url(),
              headers: safeHeaders(headers),
              body: body === undefined ? null : cap(body),
            },
            response: {
              status: response.status(),
              statusText: response.statusText(),
              headers: response.headers(),
              latencyMs,
            },
          },
          null,
          2
        )
      ),
    });
  } catch {
    // No active test, or the attachment failed. Never allowed to affect the request.
  }
}

/** Awaits the response, records what was sent, and attaches the round trip to the test. */
async function capture(
  method: string,
  responsePromise: Promise<APIResponse>,
  headers: Record<string, string>,
  body: string | undefined
): Promise<APIResponse> {
  const startedAt = Date.now();
  const response = await responsePromise;
  const latencyMs = Date.now() - startedAt;
  REQUEST_LOG.set(response, { body, headers: safeHeaders(headers) });
  await attachExchange(method, response, headers, body, latencyMs);
  return response;
}

/**
 * Thin shared transport for every KMail module client.
 *
 * `data` is sent as-is, including deliberately malformed values, which is what lets the fuzz
 * cases drive the same code path as the happy-path ones. That matters more here than on most
 * APIs: the KMail DTOs are **not** annotated `@JsonIgnoreProperties(ignoreUnknown = true)`,
 * so an unrecognised field is a hard 400 from Jackson rather than a silently ignored one, and
 * a client that quietly normalised its payload would hide that behaviour instead of testing it.
 */
export abstract class BaseClient {
  constructor(protected readonly request: APIRequestContext) {}

  protected buildHeaders(options: RequestOptions = {}): Record<string, string> {
    const headers: Record<string, string> = {
      'Content-Type': 'application/json',
      ...options.headers,
    };
    if (options.token) {
      headers.Authorization = `Bearer ${options.token}`;
    }
    return headers;
  }

  protected post(path: string, data: unknown, options: RequestOptions = {}): Promise<APIResponse> {
    const headers = this.buildHeaders(options);
    return capture(
      'POST',
      this.request.post(path, { headers, params: options.params, data: data as never }),
      headers,
      serialize(data)
    );
  }

  /** POST a raw string body — used for malformed-JSON fuzzing. */
  protected postRaw(
    path: string,
    body: string,
    options: RequestOptions = {}
  ): Promise<APIResponse> {
    const headers = this.buildHeaders(options);
    return capture(
      'POST',
      this.request.post(path, { headers, params: options.params, data: body }),
      headers,
      body
    );
  }

  /**
   * POST a `multipart/form-data` body.
   *
   * `Content-Type` is deleted rather than overridden: the boundary token is generated by the
   * transport, so any value set here would be wrong and the server would fail to split the
   * parts. The summary line records file names and sizes instead of the binaries themselves —
   * a 6 MB attachment in a report attachment is a report nobody opens.
   */
  protected postMultipart(
    path: string,
    multipart: Record<string, MultipartField>,
    options: RequestOptions = {}
  ): Promise<APIResponse> {
    const headers = this.buildHeaders(options);
    delete headers['Content-Type'];
    const summary = Object.entries(multipart)
      .map(([key, value]) =>
        value && typeof value === 'object' && 'buffer' in value
          ? `${key}: <file ${value.name} (${value.mimeType}, ${value.buffer.length} bytes)>`
          : `${key}: ${String(value)}`
      )
      .join('\n');
    return capture(
      'POST',
      this.request.post(path, { headers, params: options.params, multipart }),
      headers,
      `multipart/form-data:\n${summary}`
    );
  }

  /**
   * POSTs a hand-assembled `multipart/form-data` body.
   *
   * The boundary is generated here and named in `Content-Type`, because the transport only
   * generates one for its own record-shaped `multipart` option — which cannot represent the
   * repeated `files` field these routes declare. The body is built with explicit CRLF line
   * endings: a bare `\n` between the headers and the payload is accepted by some parsers and
   * silently produces an empty part in others, which would make an attachment test pass while
   * uploading nothing.
   *
   * A zero-length part is a legitimate value here, not a bug in this helper: both multipart
   * send routes document "an empty first part (size 0) means 'no attachments'", and the
   * boundary cases exercise exactly that.
   */
  protected postMultipartRaw(
    path: string,
    parts: MultipartPart[],
    options: RequestOptions = {}
  ): Promise<APIResponse> {
    const boundary = `----kmailBench${Date.now().toString(16)}${Math.random().toString(16).slice(2, 10)}`;
    const chunks: Buffer[] = [];
    const summary: string[] = [];

    for (const part of parts) {
      const disposition =
        'filename' in part
          ? `form-data; name="${part.name}"; filename="${part.filename}"`
          : `form-data; name="${part.name}"`;
      const contentType = 'mimeType' in part ? `\r\nContent-Type: ${part.mimeType}` : '';
      chunks.push(
        Buffer.from(`--${boundary}\r\nContent-Disposition: ${disposition}${contentType}\r\n\r\n`)
      );
      if ('buffer' in part) {
        chunks.push(part.buffer);
        summary.push(
          `${part.name}: <file ${part.filename} (${part.mimeType}, ${part.buffer.length} bytes)>`
        );
      } else {
        chunks.push(Buffer.from(part.value));
        summary.push(
          `${part.name}: ${part.value.length > 200 ? `${part.value.slice(0, 200)}…` : part.value}`
        );
      }
      chunks.push(Buffer.from('\r\n'));
    }
    chunks.push(Buffer.from(`--${boundary}--\r\n`));

    const headers = this.buildHeaders(options);
    headers['Content-Type'] = `multipart/form-data; boundary=${boundary}`;

    return capture(
      'POST',
      this.request.post(path, {
        headers,
        params: options.params,
        data: Buffer.concat(chunks) as never,
      }),
      headers,
      `multipart/form-data:\n${summary.join('\n')}`
    );
  }

  protected get(path: string, options: RequestOptions = {}): Promise<APIResponse> {
    const headers = this.buildHeaders(options);
    return capture(
      'GET',
      this.request.get(path, { headers, params: options.params }),
      headers,
      undefined
    );
  }

  /**
   * Issues an arbitrary HTTP verb against a path.
   *
   * Needed because the KMail controllers are declared with explicit `@PostMapping` /
   * `@GetMapping`, and proving that a write route refuses GET (or that a read route refuses
   * DELETE) requires sending the verb the client would otherwise never send.
   */
  protected fetchWithVerb(
    method: 'get' | 'delete' | 'put' | 'patch' | 'head' | 'options',
    path: string,
    options: RequestOptions = {}
  ): Promise<APIResponse> {
    const headers = this.buildHeaders(options);
    return capture(
      method.toUpperCase(),
      this.request.fetch(path, { method, headers, params: options.params }),
      headers,
      undefined
    );
  }
}
