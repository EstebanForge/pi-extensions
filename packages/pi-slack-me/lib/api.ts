// Minimal Slack Web API client. Plain fetch under the hood; no SDK, no bot
// token path. Mirrors the style of pi-asana's lib/api.ts: one call function,
// rich error class, JSON in / JSON out.
//
// Slack's response shape differs from Asana's: every method returns
//   { "ok": true, ... }              (success)
//   { "ok": false, "error": "..." }  (logical failure, HTTP may still be 200)
// We surface the `error` string on failure and map interesting HTTP status
// codes (429, 5xx) to friendly hints. Rate limiting is a first-class case:
// Slack returns a Retry-After header we forward to the caller via the error
// message so the agent can decide whether to retry.

import { getSlackToken } from "./auth";

const SLACK_BASE_URL = "https://slack.com/api";
const REQUEST_TIMEOUT_MS = 30_000;

export interface SlackGetOptions {
  query?: Record<string, string | number | boolean | undefined>;
}

export interface SlackPostOptions {
  /** JSON body. Slack accepts application/json for write methods. */
  body?: Record<string, unknown>;
  /** Form-encoded body for methods that reject JSON (files.getUploadURLExternal). */
  form?: Record<string, string>;
  query?: Record<string, string | number | boolean | undefined>;
}

// Error carrying the Slack `error` code, HTTP status, and an optional
// retry-after hint (seconds). isRateLimited / isAuthError let tool callers
// branch without parsing message text.
export class SlackApiError extends Error {
  readonly status: number;
  readonly code?: string;
  readonly retryAfter?: number;
  readonly isRateLimited: boolean;
  readonly isAuthError: boolean;
  constructor(
    message: string,
    status = 0,
    code?: string,
    retryAfter?: number,
  ) {
    super(message);
    this.name = "SlackApiError";
    this.status = status;
    this.code = code;
    this.retryAfter = retryAfter;
    this.isRateLimited = status === 429 || code === "ratelimited";
    this.isAuthError =
      status === 401 ||
      code === "invalid_auth" ||
      code === "not_authed" ||
      code === "token_revoked" ||
      code === "token_expired";
  }
}

interface SlackResponse {
  ok: boolean;
  error?: string;
  warning?: string;
  response_metadata?: { next_cursor?: string };
}

function buildUrl(
  method: string,
  query: SlackGetOptions["query"],
): string {
  const url = new URL(`${SLACK_BASE_URL}/${method}`);
  if (query) {
    for (const [k, v] of Object.entries(query)) {
      if (v === undefined || v === null) continue;
      url.searchParams.set(k, String(v));
    }
  }
  return url.toString();
}

// Shared response parser for the JSON Web API methods. Handles rate limiting,
// the {ok:false} logical-failure body (Slack returns HTTP 200 on these), and
// non-2xx HTTP. Used by both slackGet and slackPost so the parsing logic is
// not triplicated.
async function readSlackJson<T = SlackResponse>(
  method: string,
  response: Response,
): Promise<T> {
  // Rate limited: Slack returns 429 with a Retry-After header (seconds).
  // Surface it as a structured error so callers can back off precisely.
  if (response.status === 429) {
    const retryAfterRaw = response.headers.get("retry-after");
    const retryAfter = retryAfterRaw ? Number(retryAfterRaw) : undefined;
    throw new SlackApiError(
      `Slack rate limited on ${method}.` +
        (retryAfter ? ` Retry in ~${retryAfter}s.` : " Retry shortly."),
      response.status,
      "ratelimited",
      retryAfter,
    );
  }

  const text = await response.text();
  let parsed: SlackResponse | null = null;
  try {
    parsed = JSON.parse(text) as SlackResponse;
  } catch {
    // Body was not JSON; fall through to the HTTP-status message below.
  }

  // Slack usually returns 200 even on logical failure, so check ok first.
  if (parsed && parsed.ok === false) {
    throw new SlackApiError(
      friendlyError(method, parsed.error, response.status),
      response.status,
      parsed.error,
    );
  }

  if (!response.ok) {
    throw new SlackApiError(
      friendlyStatus(method, response.status),
      response.status,
    );
  }

  return (parsed as T) ?? (JSON.parse(text) as T);
}

// Call a Slack Web API method via GET. Returns the full parsed JSON body
// (Slack wraps results in {ok, ...}); callers read the fields they need and
// can grab response_metadata.next_cursor for pagination. Throws SlackApiError
// on transport failure, non-2xx HTTP, or a logical {ok:false} body.
export async function slackGet<T = SlackResponse>(
  method: string,
  options: SlackGetOptions = {},
): Promise<T> {
  const token = getSlackToken();
  const url = buildUrl(method, options.query);

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);

  let response: Response;
  try {
    response = await fetch(url, {
      method: "GET",
      headers: { Authorization: `Bearer ${token}`, Accept: "application/json" },
      signal: controller.signal,
    });
  } catch (err) {
    clearTimeout(timer);
    throw new SlackApiError(transportError(method, err));
  }

  try {
    return await readSlackJson<T>(method, response);
  } finally {
    clearTimeout(timer);
  }
}

// Call a Slack Web API method via POST. Used by the write tools
// (chat.postMessage / chat.update / chat.delete) and the image upload flow.
// `body` is sent as application/json; `form` is sent as
// application/x-www-form-urlencoded - the upload-ticket methods claim JSON
// support in the docs but reject it live (invalid_arguments, probed
// 2026-09-05), so files.getUploadURLExternal/completeUploadExternal go
// through `form`. Same response parsing and error handling either way.
export async function slackPost<T = SlackResponse>(
  method: string,
  options: SlackPostOptions = {},
): Promise<T> {
  const token = getSlackToken();
  const url = buildUrl(method, options.query);

  const headers: Record<string, string> = {
    Authorization: `Bearer ${token}`,
    Accept: "application/json",
  };
  let body: string | undefined;
  if (options.body !== undefined) {
    headers["Content-Type"] = "application/json; charset=utf-8";
    body = JSON.stringify(options.body);
  } else if (options.form !== undefined) {
    headers["Content-Type"] = "application/x-www-form-urlencoded";
    body = new URLSearchParams(options.form).toString();
  }

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);

  let response: Response;
  try {
    response = await fetch(url, {
      method: "POST",
      headers,
      body,
      signal: controller.signal,
    });
  } catch (err) {
    clearTimeout(timer);
    throw new SlackApiError(transportError(method, err));
  }

  try {
    return await readSlackJson<T>(method, response);
  } finally {
    clearTimeout(timer);
  }
}

// Upload raw file bytes to a presigned upload URL from
// files.getUploadURLExternal. No Authorization header on purpose: the URL is
// single-use and pre-authorized, and adding a Bearer header can break the
// signature check. HTTP status is the only success signal Slack gives here;
// a non-2xx carries the failure detail in the body, which we surface verbatim
// (trimmed) so workspace upload restrictions stay diagnosable.
export async function slackUploadBytes(
  uploadUrl: string,
  bytes: Buffer,
  contentType: string,
): Promise<void> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
  let response: Response;
  try {
    response = await fetch(uploadUrl, {
      method: "POST",
      headers: { "Content-Type": contentType },
      body: new Uint8Array(bytes),
      signal: controller.signal,
    });
  } catch (err) {
    clearTimeout(timer);
    throw new SlackApiError(transportError("file upload", err));
  }
  if (!response.ok) {
    const detail = (await response.text().catch(() => "")).slice(0, 200);
    throw new SlackApiError(
      `Slack file upload failed (HTTP ${response.status}).${detail ? ` ${detail}` : ""}`,
      response.status,
    );
  }
}

// Fetch a binary file from a url_private URL with token auth. Returns the
// raw ArrayBuffer. Used by the file download tool for images and documents.
export async function slackDownload(url: string): Promise<ArrayBuffer> {
  const token = getSlackToken();
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
  try {
    const response = await fetch(url, {
      headers: { Authorization: `Bearer ${token}` },
      signal: controller.signal,
    });
    if (!response.ok) {
      throw new SlackApiError(
        `Slack file download failed (HTTP ${response.status}).`,
        response.status,
      );
    }
    return await response.arrayBuffer();
  } catch (err) {
    if (err instanceof SlackApiError) throw err;
    throw new SlackApiError(transportError("file download", err));
  } finally {
    clearTimeout(timer);
  }
}

// Classify a fetch() throw (network error or abort/timeout) into a readable
// message. Shared by slackGet / slackPost / slackDownload.
function transportError(method: string, err: unknown): string {
  const msg = err instanceof Error ? err.message : String(err);
  if (msg.includes("abort")) {
    return `Slack ${method} timed out after ${REQUEST_TIMEOUT_MS / 1000}s.`;
  }
  return `Network error reaching Slack (${method}): ${msg}`;
}

// The OAuth scope a given Web API method needs (user token). Used to make the
// missing_scope error point at the RIGHT scope instead of a hardcoded one.
// chat.* methods are all chat:write; opening a DM (conversations.open) needs
// im:write, which is easy to miss when adding DM support; the whole file
// upload flow (getUploadURLExternal / completeUploadExternal) needs files:write.
function requiredScopeFor(method: string): string {
  if (method.startsWith("chat.")) return "chat:write";
  if (method === "conversations.open") return "im:write";
  if (method.startsWith("files.") && method !== "files.info") return "files:write";
  return "a required scope";
}

// Map Slack `error` codes to hints an agent can act on. Keep terse; the code
// is always included by SlackApiError for programmatic branching.
function friendlyError(method: string, code: string | undefined, status: number): string {
  if (!code) return `Slack ${method} failed (HTTP ${status}).`;
  switch (code) {
    case "not_in_channel":
      return `Slack: not_in_channel. With a user token this means the calling user is not a member of that conversation. Try slack_list_channels to see conversations you can access.`;
    case "channel_not_found":
      return `Slack: channel_not_found. The channel ID is wrong, archived, or not visible to the calling user. Run slack_list_channels to confirm.`;
    case "missing_scope":
      return `Slack: missing_scope. The user token lacks ${requiredScopeFor(method)} for ${method}. Re-install the app with the scopes listed in the README.`;
    case "cant_update_message":
      return `Slack: cant_update_message. Only messages authored by the calling user can be edited with a user token. Verify the message ts is one of your own.`;
    case "invalid_auth":
    case "not_authed":
    case "token_revoked":
    case "token_expired":
      return `Slack: ${code}. The SLACK_USER_TOKEN is invalid, revoked, or expired. Re-install the app at https://api.slack.com/apps and update the token.`;
    default:
      return `Slack ${method} failed: ${code}.`;
  }
}

function friendlyStatus(method: string, status: number): string {
  if (status === 401) return `Slack ${method}: unauthorized (HTTP 401). Check SLACK_USER_TOKEN.`;
  if (status === 404) return `Slack ${method}: endpoint or resource not found (HTTP 404).`;
  if (status >= 500) return `Slack ${method}: server error (HTTP ${status}). Retry; check https://status.slack.com.`;
  return `Slack ${method} failed (HTTP ${status}).`;
}
