// Minimal Zendesk Support API v2 client. Plain fetch under the hood; no SDK.
// Mirrors the style of pi-slack-me's lib/api.ts: one call function, rich error
// class, JSON in / JSON out.
//
// Zendesk differences from Slack that matter here:
//   - REST status codes are honest: 401/403/404/429 mean what they say.
//   - OAuth 401 on an expired access token returns {error: "invalid_token"};
//     we reset the token cache and retry once.
//   - 429 is rate limiting; the JSON body or headers carry a retry hint.
//   - 403 on a scoped OAuth token almost always means the token scope does
//     not cover the endpoint (read vs write), or the client's Allowed scopes
//     ceiling was configured narrower than what the code requests.

import {
  getZendeskAccessToken,
  getZendeskCredentials,
  resetTokenCache,
  ZendeskAuthError,
} from "./auth";

const REQUEST_TIMEOUT_MS = 30_000;

export interface ZdGetOptions {
  query?: Record<string, string | number | boolean | undefined>;
}

// Error carrying HTTP status, the Zendesk error code when present, and an
// optional retry-after hint (seconds). isRateLimited / isAuthError let callers
// branch without parsing message text.
export class ZendeskApiError extends Error {
  readonly status: number;
  readonly code?: string;
  readonly retryAfter?: number;
  readonly isRateLimited: boolean;
  readonly isAuthError: boolean;
  constructor(message: string, status = 0, code?: string, retryAfter?: number) {
    super(message);
    this.name = "ZendeskApiError";
    this.status = status;
    this.code = code;
    this.retryAfter = retryAfter;
    this.isRateLimited = status === 429;
    this.isAuthError = status === 401;
  }
}

function buildUrl(path: string, query: ZdGetOptions["query"]): string {
  const { subdomain } = getZendeskCredentials();
  const url = new URL(`https://${subdomain}.zendesk.com/api/v2/${path}`);
  if (query) {
    for (const [k, v] of Object.entries(query)) {
      if (v === undefined || v === null) continue;
      url.searchParams.set(k, String(v));
    }
  }
  return url.toString();
}

interface ZdErrorBody {
  error?: string;
  description?: string;
  details?: Record<string, Array<{ description?: string }>>;
}

// Extract Zendesk's human-readable description from an error body when one
// exists. Search errors nest descriptions under `details`; most others use
// top-level `description` or `error`.
function describeBody(parsed: ZdErrorBody | null): string | undefined {
  if (!parsed) return undefined;
  if (parsed.description) return parsed.description;
  const first = Object.values(parsed.details ?? {})[0];
  return first?.[0]?.description ?? parsed.error;
}

async function readJson<T>(response: Response, method: string): Promise<T> {
  const text = await response.text();
  try {
    return JSON.parse(text) as T;
  } catch {
    throw new ZendeskApiError(
      `Zendesk ${method}: non-JSON response (HTTP ${response.status}).`,
      response.status,
    );
  }
}

// Shared GET with auth, timeout, rate-limit and auth-retry handling.
// Retries exactly once after a 401 invalid_token: the access token expired
// server-side or was revoked, so drop the cache, mint a new token, retry.
export async function zdGet<T>(
  path: string,
  options: ZdGetOptions = {},
): Promise<T> {
  const method = `GET /api/v2/${path}`;

  const runOnce = async (): Promise<Response> => {
    const token = await getZendeskAccessToken();
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
    try {
      return await fetch(buildUrl(path, options.query), {
        method: "GET",
        headers: {
          Authorization: `Bearer ${token}`,
          Accept: "application/json",
        },
        signal: controller.signal,
      });
    } finally {
      clearTimeout(timer);
    }
  };

  let response: Response;
  try {
    response = await runOnce();
    if (response.status === 401) {
      const body = await readJson<ZdErrorBody>(response, method).catch(
        () => null,
      );
      if (body?.error === "invalid_token") {
        resetTokenCache();
        response = await runOnce();
      } else {
        throw new ZendeskApiError(
          `Zendesk ${method}: unauthorized (HTTP 401). Check the OAuth ` +
            "client credentials (ZENDESK_CLIENT_ID / ZENDESK_CLIENT_SECRET).",
          401,
          body?.error,
        );
      }
    }
  } catch (err) {
    if (err instanceof ZendeskApiError || err instanceof ZendeskAuthError) {
      throw err;
    }
    throw new ZendeskApiError(transportError(method, err));
  }

  // Rate limited: surface the retry hint so the agent can back off precisely.
  if (response.status === 429) {
    const retryAfterRaw =
      response.headers.get("retry-after") ?? undefined;
    const retryAfter = retryAfterRaw ? Number(retryAfterRaw) : undefined;
    throw new ZendeskApiError(
      `Zendesk rate limited on ${method}.` +
        (retryAfter && Number.isFinite(retryAfter)
          ? ` Retry in ~${retryAfter}s.`
          : " Retry shortly."),
      429,
      "ratelimited",
      Number.isFinite(retryAfter) ? retryAfter : undefined,
    );
  }

  if (!response.ok) {
    const body = await readJson<ZdErrorBody>(response, method).catch(() => null);
    const detail = describeBody(body);
    if (response.status === 403) {
      throw new ZendeskApiError(
        `Zendesk ${method}: forbidden (HTTP 403). The access token scope ` +
          "does not cover this endpoint. This extension requests read-only " +
          "scopes (tickets:read users:read organizations:read); a 403 on a " +
          "read usually means the client's Allowed scopes in Admin Center " +
          "were configured narrower than that.",
        403,
        body?.error,
      );
    }
    if (response.status === 404) {
      throw new ZendeskApiError(
        `Zendesk ${method}: not found (HTTP 404).${detail ? ` ${detail}` : ""}`,
        404,
        body?.error,
      );
    }
    if (response.status === 401) {
      // Second 401 after a fresh token: credentials are genuinely bad.
      throw new ZendeskApiError(
        `Zendesk ${method}: unauthorized even after refreshing the OAuth ` +
          "token (HTTP 401). Verify ZENDESK_CLIENT_ID / " +
          "ZENDESK_CLIENT_SECRET and that the client has not been revoked.",
        401,
        body?.error,
      );
    }
    if (response.status >= 500) {
      throw new ZendeskApiError(
        `Zendesk ${method}: server error (HTTP ${response.status}). Retry; ` +
          "check https://status.zendesk.com.",
        response.status,
      );
    }
    throw new ZendeskApiError(
      `Zendesk ${method} failed (HTTP ${response.status}).` +
        (detail ? ` ${detail}` : ""),
      response.status,
      body?.error,
    );
  }

  return readJson<T>(response, method);
}

// Classify a fetch() throw (network error or abort/timeout) into a readable
// message. Shared by zdGet and zdDownload.
function transportError(method: string, err: unknown): string {
  const msg = err instanceof Error ? err.message : String(err);
  if (msg.includes("abort")) {
    return `Zendesk ${method} timed out after ${REQUEST_TIMEOUT_MS / 1000}s.`;
  }
  return `Network error reaching Zendesk (${method}): ${msg}`;
}

// Attachment content URLs are pre-signed and redirect (302) to storage. Send
// NO Authorization header: a bearer header breaks the storage-host redirect
// signature (verified against production 2026-08-28 - plain GET + redirects
// returns 200, authenticated GET returns a 403 HTML error page). Node fetch
// follows redirects by default.
const DOWNLOAD_TIMEOUT_MS = 60_000;
export const MAX_DOWNLOAD_BYTES = 100 * 1024 * 1024;

export async function zdDownload(
  url: string,
): Promise<{ bytes: Uint8Array; contentType: string | null }> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), DOWNLOAD_TIMEOUT_MS);
  try {
    const response = await fetch(url, {
      method: "GET",
      headers: { Accept: "*/*" },
      redirect: "follow",
      signal: controller.signal,
    });
    if (!response.ok) {
      throw new ZendeskApiError(
        `Zendesk attachment download failed (HTTP ${response.status}). ` +
          "The signed URL may have expired; re-run zendesk_get_comments to " +
          "get a fresh one.",
        response.status,
      );
    }
    const declared = Number(response.headers.get("content-length") ?? "0");
    if (declared > MAX_DOWNLOAD_BYTES) {
      throw new ZendeskApiError(
        `Zendesk attachment too large (${declared} bytes; limit ${MAX_DOWNLOAD_BYTES}).`,
        413,
      );
    }
    const buffer = await response.arrayBuffer();
    if (buffer.byteLength > MAX_DOWNLOAD_BYTES) {
      throw new ZendeskApiError(
        `Zendesk attachment too large (${buffer.byteLength} bytes; limit ${MAX_DOWNLOAD_BYTES}).`,
        413,
      );
    }
    return {
      bytes: new Uint8Array(buffer),
      contentType: response.headers.get("content-type"),
    };
  } catch (err) {
    if (err instanceof ZendeskApiError) throw err;
    throw new ZendeskApiError(transportError("attachment download", err));
  } finally {
    clearTimeout(timer);
  }
}
