// Minimal Asana REST client. Plain fetch under the hood; no SDK, no OAuth, no
// token refresh - PAT is long-lived. Mirrors the style of pi-deepwiki's
// lib/api.ts: one call function, rich error class, JSON in / JSON out.
//
// Asana's REST shape: every endpoint returns either
//   { "data": <object> }    (single resource)
//   { "data": [ ... ] }     (collection)
//   { "errors": [ {message, help?} ] }   (failure)
// We unwrap `data` and surface `errors[0].message` on failure. Status codes
// follow the usual REST conventions; we map the interesting ones to friendly
// strings (401, 404, 429, 5xx).

import { getAsanaToken } from "./auth";

const DEFAULT_BASE_URL = "https://app.asana.com/api/1.0";
const REQUEST_TIMEOUT_MS = 30_000;

export interface CallOptions {
  query?: Record<string, string | number | boolean | undefined>;
  body?: unknown;
  // When true, do not unwrap the {data: ...} envelope. Returns the full JSON
  // body so callers can read pagination tokens (next_page.offset) and any
  // other side-channel fields. Defaults to false (unwraps as before).
  raw?: boolean;
}

interface AsanaErrorBody {
  errors?: Array<{ message?: string; help?: string }>;
}

// Shape returned by Asana for typeahead / list endpoints. Each entry carries a
// `resource_type` discriminator (e.g. "task", "project", "user", "tag").
export interface AsanaTypeaheadItem {
  resource_type: string;
  gid: string;
 name?: string;
  [k: string]: unknown;
}

// Result of a single paged fetch via callAsanaPaged: the unwrapped `data` plus
// the cursor for the next page (undefined when there are no more pages).
export interface PagedResult<T> {
  data: T;
  nextOffset?: string;
}

// Paged envelope for Asana collection endpoints (stories, tasks, projects,
// ...). `next_page` is null/absent on the final page.
interface PagedEnvelope<T> {
  data: T;
  next_page?: { offset?: string; path?: string; uri?: string } | null;
}

export class AsanaError extends Error {
  readonly status: number;
  readonly isRateLimited: boolean;
  readonly isAuthError: boolean;
  constructor(message: string, status = 0) {
    super(message);
    this.name = "AsanaError";
    this.status = status;
    this.isRateLimited = status === 429;
    this.isAuthError = status === 401 || status === 403;
  }
}

function friendlyStatus(status: number, body: AsanaErrorBody | null): string {
  const upstream = body?.errors?.[0]?.message;
  switch (status) {
    case 400:
      return `Asana rejected the request (HTTP 400). ${upstream ?? "Check parameter names and values."}`;
    case 401:
      return `Asana denied access (HTTP 401). ${upstream ?? "ASANA_ACCESS_TOKEN is missing, invalid, or revoked. Generate a new personal access token at https://app.asana.com/0/my-apps."}`;
    case 403:
      return `Asana denied access (HTTP 403). ${upstream ?? "Your PAT lacks permission for this action or the workspace is not yours. Check sharing on the target resource."}`;
    case 404:
      return `Asana resource not found (HTTP 404). ${upstream ?? "The GID does not exist or has been deleted. Verify the GID with asana_search_objects."}`;
    case 429:
      return `Asana rate limit reached (HTTP 429). ${upstream ?? "Personal access tokens share a pool; wait a few seconds and retry."}`;
    default:
      if (status >= 500) {
        return `Asana server error (HTTP ${status}). ${upstream ?? "Retry shortly."}`;
      }
      return `Asana request failed (HTTP ${status}). ${upstream ?? "No further detail."}`;
  }
}

function buildUrl(
  base: string,
  path: string,
  query: CallOptions["query"],
): string {
  // Allow the path to be provided as either "/foo" or "foo" for caller comfort.
  const normalizedPath = path.startsWith("/") ? path : `/${path}`;
  const url = new URL(`${base}${normalizedPath}`);
  if (query) {
    for (const [k, v] of Object.entries(query)) {
      if (v === undefined || v === null) continue;
      url.searchParams.set(k, String(v));
    }
  }
  return url.toString();
}

// Call Asana and return the unwrapped `data` field. Collections come back as
// arrays; objects as objects. Throws AsanaError on any failure, including
// transport-level timeouts and non-2xx HTTP.
export async function callAsana<T = unknown>(
  method: "GET" | "POST" | "PUT" | "DELETE",
  path: string,
  options: CallOptions = {},
): Promise<T> {
  const token = getAsanaToken();
  const url = buildUrl(DEFAULT_BASE_URL, path, options.query);

  const headers: Record<string, string> = {
    Authorization: `Bearer ${token}`,
    Accept: "application/json",
  };
  let body: string | undefined;
  if (options.body !== undefined) {
    headers["Content-Type"] = "application/json";
    // Asana REST requires every write body to be wrapped under a top-level
    // `data` key. Wrapping once, centrally, keeps every tool caller free of
    // envelope ceremony. The response side already mirrors this with the
    // `{data: ...}` unwrap below.
    body = JSON.stringify({ data: options.body });
  }

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);

  let response: Response;
  try {
    response = await fetch(url, {
      method,
      headers,
      body,
      signal: controller.signal,
    });
  } catch (err) {
    clearTimeout(timer);
    const msg = err instanceof Error ? err.message : String(err);
    if (msg.includes("abort")) {
      throw new AsanaError(
        `Asana request timed out after ${REQUEST_TIMEOUT_MS / 1000}s. Retry; if persistent, check the network or the Asana status page.`,
      );
    }
    throw new AsanaError(`Network error reaching Asana: ${msg}`);
  }

  try {
    if (!response.ok) {
      let parsed: AsanaErrorBody | null = null;
      const text = await response.text();
      try {
        parsed = JSON.parse(text) as AsanaErrorBody;
      } catch {
        // Body was not JSON; surface raw text via friendlyStatus fallback.
      }
      throw new AsanaError(friendlyStatus(response.status, parsed), response.status);
    }

    // 204 No Content (rare in Asana but possible for DELETE): nothing to parse.
    if (response.status === 204) return undefined as T;

    const json = (await response.json()) as
      | { data?: T; next_page?: unknown }
      | T;
    if (options.raw) {
      return json as T;
    }
    if (json && typeof json === "object" && "data" in (json as Record<string, unknown>)) {
      return (json as { data: T }).data;
    }
    return json as T;
  } finally {
    clearTimeout(timer);
  }
}

// Multipart upload for POST /attachments. The JSON path cannot carry files:
// this endpoint takes multipart/form-data with a `parent` field (task gid)
// and the binary `file` part. fetch() sets the multipart boundary itself, so
// NO Content-Type header is set manually (a hand-written one without the
// boundary makes Asana return 400). resource_subtype is deliberately never
// sent: the default ("asana") is the only subtype Asana accepts as an inline
// image in a story; "external" gets rejected with "Not a valid image asset id".
// Mirror of Asana's own 100 MB per-attachment ceiling (same cap the download
// path enforces) so an oversized file is refused before it is read.
const MAX_UPLOAD_BYTES = 100 * 1024 * 1024;

export async function callAsanaUpload<T = unknown>(
  path: string,
  file: { filename: string; bytes: Buffer; contentType: string },
  fields: Record<string, string> = {},
): Promise<T> {
  if (file.bytes.byteLength > MAX_UPLOAD_BYTES) {
    throw new AsanaError(
      `Attachment too large (${file.bytes.byteLength} bytes > ${MAX_UPLOAD_BYTES} byte cap). Asana rejects uploads over 100 MB.`,
    );
  }
  const token = getAsanaToken();
  const url = buildUrl(DEFAULT_BASE_URL, path, undefined);

  const form = new FormData();
  for (const [key, value] of Object.entries(fields)) {
    form.append(key, value);
  }
  form.append(
    "file",
    new Blob([new Uint8Array(file.bytes)], { type: file.contentType }),
    file.filename,
  );

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);

  let response: Response;
  try {
    response = await fetch(url, {
      method: "POST",
      headers: { Authorization: `Bearer ${token}`, Accept: "application/json" },
      body: form,
      signal: controller.signal,
    });
  } catch (err) {
    clearTimeout(timer);
    const msg = err instanceof Error ? err.message : String(err);
    if (msg.includes("abort")) {
      throw new AsanaError(
        `Asana upload timed out after ${REQUEST_TIMEOUT_MS / 1000}s. Retry; if persistent, check the network or the Asana status page.`,
      );
    }
    throw new AsanaError(`Network error uploading to Asana: ${msg}`);
  }

  try {
    if (!response.ok) {
      let parsed: AsanaErrorBody | null = null;
      const text = await response.text();
      try {
        parsed = JSON.parse(text) as AsanaErrorBody;
      } catch {
        // Body was not JSON; surface raw text via friendlyStatus fallback.
      }
      throw new AsanaError(friendlyStatus(response.status, parsed), response.status);
    }
    // Same {data: ...} envelope as callAsana; the attachment compact record
    // (gid, name, ...) arrives wrapped.
    const json = (await response.json()) as { data?: T } | T;
    if (json && typeof json === "object" && "data" in (json as Record<string, unknown>)) {
      return (json as { data: T }).data;
    }
    return json as T;
  } finally {
    clearTimeout(timer);
  }
}

// Fetch a raw external URL and return its bytes. Used to download Asana
// attachments: GET /attachments/{gid} returns a `download_url` pointing at an
// Asana-hosted S3 object, and that S3 URL MUST be fetched WITHOUT the Bearer
// token (S3 rejects Authorization on presigned links) and is short-lived
// (~2 min). So this helper sends no auth header, follows redirects, and
// returns the ArrayBuffer plus the content-type the caller renders. Errors
// map to AsanaError so the tool boundary keeps one error class.
//
// Binary-specific tuning (vs callAsana's JSON path):
//   - DOWNLOAD_TIMEOUT_MS is longer than the 30s JSON timeout: a 50 MB XLS on
//     a slow link legitimately needs >30s to stream.
//   - MAX_DOWNLOAD_BYTES caps the buffered object so a 100 MB attachment
//     cannot OOM the agent process; the caller tells the agent to use the
//     view_url instead.
//   - The body read is wrapped in the SAME abort mapping as the fetch, so a
//     mid-stream timeout surfaces the retry hint, not a raw "aborted".
const DOWNLOAD_TIMEOUT_MS = 120_000;
// Asana's own per-attachment ceiling is 100 MB; mirror it as our hard cap.
const MAX_DOWNLOAD_BYTES = 100 * 1024 * 1024;

export async function downloadExternalUrl(
  url: string,
): Promise<{
  bytes: ArrayBuffer;
  contentType: string;
}> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), DOWNLOAD_TIMEOUT_MS);

  // Map any AbortError (fetch OR body read) to the same retry hint. Pulled
  // into a helper so both fetch failure and arrayBuffer() failure share it.
  const mapAbort = (err: unknown): AsanaError => {
    const msg = err instanceof Error ? err.message : String(err);
    if (msg.includes("abort")) {
      return new AsanaError(
        `Asana download timed out after ${DOWNLOAD_TIMEOUT_MS / 1000}s. The download_url may have expired; retry asana_download_attachment to refresh it.`,
      );
    }
    return new AsanaError(`Network error downloading attachment: ${msg}`);
  };

  let response: Response;
  try {
    response = await fetch(url, {
      method: "GET",
      // Intentionally NO Authorization header: the download_url is an S3
      // presigned link. Sending the Asana Bearer token here makes S3 return
      // 400/403 (confirmed via Asana forum reports).
      signal: controller.signal,
    });
  } catch (err) {
    clearTimeout(timer);
    throw mapAbort(err);
  }

  try {
    if (!response.ok) {
      throw new AsanaError(
        `Attachment download failed (HTTP ${response.status}). The download_url may have expired; retry asana_download_attachment to refresh it.`,
        response.status,
      );
    }
    // Preflight on Content-Length when the server sends it, so we refuse a
    // too-large object BEFORE buffering it.
    const declared = Number(response.headers.get("content-length") ?? 0);
    if (declared > MAX_DOWNLOAD_BYTES) {
      throw new AsanaError(
        `Attachment too large (${declared} bytes > ${MAX_DOWNLOAD_BYTES} byte cap). Open the view_url instead of fetching it into the agent process.`,
      );
    }
    let bytes: ArrayBuffer;
    try {
      bytes = await response.arrayBuffer();
    } catch (err) {
      // A streaming abort escapes the fetch try above; catch it here so the
      // agent sees the retry hint rather than a raw AbortError.
      throw mapAbort(err);
    }
    // Defend the no-Content-Length case: confirm the buffered size too.
    if (bytes.byteLength > MAX_DOWNLOAD_BYTES) {
      throw new AsanaError(
        `Attachment too large (${bytes.byteLength} bytes > ${MAX_DOWNLOAD_BYTES} byte cap). Open the view_url instead of fetching it into the agent process.`,
      );
    }
    const contentType =
      response.headers.get("content-type") ?? "application/octet-stream";
    return { bytes, contentType };
  } finally {
    clearTimeout(timer);
  }
}

// Like callAsana, but for paged collection endpoints. Returns the unwrapped
// `data` array alongside the `next_page.offset` cursor so callers can walk all
// pages. Use this instead of callAsana whenever the endpoint may paginate.
// Same error handling, timeout, and auth as callAsana.
export async function callAsanaPaged<T>(
  method: "GET" | "POST" | "PUT" | "DELETE",
  path: string,
  options: CallOptions = {},
): Promise<PagedResult<T>> {
  const token = getAsanaToken();
  const url = buildUrl(DEFAULT_BASE_URL, path, options.query);

  const headers: Record<string, string> = {
    Authorization: `Bearer ${token}`,
    Accept: "application/json",
  };
  let body: string | undefined;
  if (options.body !== undefined) {
    headers["Content-Type"] = "application/json";
    body = JSON.stringify({ data: options.body });
  }

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);

  let response: Response;
  try {
    response = await fetch(url, {
      method,
      headers,
      body,
      signal: controller.signal,
    });
  } catch (err) {
    clearTimeout(timer);
    const msg = err instanceof Error ? err.message : String(err);
    if (msg.includes("abort")) {
      throw new AsanaError(
        `Asana request timed out after ${REQUEST_TIMEOUT_MS / 1000}s. Retry; if persistent, check the network or the Asana status page.`,
      );
    }
    throw new AsanaError(`Network error reaching Asana: ${msg}`);
  }

  try {
    if (!response.ok) {
      let parsed: AsanaErrorBody | null = null;
      const text = await response.text();
      try {
        parsed = JSON.parse(text) as AsanaErrorBody;
      } catch {
        // Body was not JSON; surface raw text via friendlyStatus fallback.
      }
      throw new AsanaError(friendlyStatus(response.status, parsed), response.status);
    }

    if (response.status === 204) return { data: undefined as T };

    const json = (await response.json()) as PagedEnvelope<T> | T;
    if (
      json &&
      typeof json === "object" &&
      "data" in (json as Record<string, unknown>)
    ) {
      const env = json as PagedEnvelope<T>;
      return { data: env.data, nextOffset: env.next_page?.offset ?? undefined };
    }
    return { data: json as T };
  } finally {
    clearTimeout(timer);
  }
}
