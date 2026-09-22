// Zendesk auth: OAuth client-credentials grant. Env-only, no file fallback,
// no API tokens (Zendesk deprecates API tokens: unused tokens auto-deactivate
// from 2026-07-28, all stop working 2027-04-30).
//
// Required env:
//   ZENDESK_SUBDOMAIN      e.g. "{subdomain}" for https://{subdomain}.zendesk.com
//   ZENDESK_CLIENT_ID      OAuth client identifier (confidential client)
//   ZENDESK_CLIENT_SECRET  OAuth client secret (shown once at creation)
//
// One-time setup in Admin Center: Apps and integrations > APIs > OAuth clients.
// Create a Confidential client and set Allowed scopes to the read set below so
// the client can never request broader access. The client-credentials flow has
// no refresh token: re-POST /oauth/tokens when the access token expires.
//
// The client secret is opaque - never logged, echoed, or redacted anywhere.

export const ZENDESK_OAUTH_SCOPE =
  "tickets:read users:read organizations:read ticket_views:read";

export class ZendeskAuthError extends Error {
  readonly kind: "missing_env" | "token_request_failed";
  constructor(message: string, kind: ZendeskAuthError["kind"]) {
    super(message);
    this.name = "ZendeskAuthError";
    this.kind = kind;
  }
}

export interface ZendeskCredentials {
  subdomain: string;
  clientId: string;
  clientSecret: string;
}

// Read the three env vars or throw with setup instructions. The rich message
// is the point: the agent (or the human) can act on it directly.
export function getZendeskCredentials(): ZendeskCredentials {
  const subdomain = process.env.ZENDESK_SUBDOMAIN?.trim();
  const clientId = process.env.ZENDESK_CLIENT_ID?.trim();
  const clientSecret = process.env.ZENDESK_CLIENT_SECRET?.trim();
  if (!subdomain || !clientId || !clientSecret) {
    const missing = [
      !subdomain && "ZENDESK_SUBDOMAIN",
      !clientId && "ZENDESK_CLIENT_ID",
      !clientSecret && "ZENDESK_CLIENT_SECRET",
    ]
      .filter(Boolean)
      .join(", ");
    throw new ZendeskAuthError(
      `Zendesk: missing env var(s): ${missing}. ` +
        "In Admin Center go to Apps and integrations > APIs > OAuth clients, " +
        "create a Confidential client, set Allowed scopes to " +
        `"${ZENDESK_OAUTH_SCOPE}", then export ` +
        "ZENDESK_SUBDOMAIN, ZENDESK_CLIENT_ID, and ZENDESK_CLIENT_SECRET " +
        "in the shell that runs pi. API tokens are not supported: Zendesk " +
        "retires them on 2027-04-30.",
      "missing_env",
    );
  }
  return { subdomain, clientId, clientSecret };
}

// True when all three env vars are present and non-empty. UI/status use only -
// never use this to gate a tool (call getZendeskAccessToken inside the tool so
// the rich ZendeskAuthError surfaces).
export function hasZendeskCredentials(): boolean {
  return Boolean(
    process.env.ZENDESK_SUBDOMAIN?.trim() &&
      process.env.ZENDESK_CLIENT_ID?.trim() &&
      process.env.ZENDESK_CLIENT_SECRET?.trim(),
  );
}

interface CachedToken {
  accessToken: string;
  // Milliseconds since epoch after which the token should be re-requested.
  expiresAt: number;
}

let cachedToken: CachedToken | undefined;

// Re-request the token this long before the reported expiry, so a request in
// flight does not ride an expiring token.
const EXPIRY_MARGIN_MS = 60_000;

interface ZendeskTokenResponse {
  access_token?: string;
  token_type?: string;
  scope?: string;
  expires_in?: number;
  error?: string;
  error_description?: string;
}

function tokenEndpoint(subdomain: string): string {
  return `https://${subdomain}.zendesk.com/oauth/tokens`;
}

// Exchange client credentials for an access token. No refresh token exists in
// this flow; callers just call this again after expiry (see
// getZendeskAccessToken). Throws ZendeskAuthError on missing env or a failed
// token request; error bodies are surfaced verbatim because Zendesk puts the
// useful part in `error` (invalid_client, invalid_scope, ...).
export async function requestZendeskAccessToken(): Promise<string> {
  const { subdomain, clientId, clientSecret } = getZendeskCredentials();

  // URLSearchParams = stdlib form-encoding. Zendesk accepts
  // application/x-www-form-urlencoded per the OAuth 2.0 spec default.
  const body = new URLSearchParams({
    grant_type: "client_credentials",
    client_id: clientId,
    client_secret: clientSecret,
    scope: ZENDESK_OAUTH_SCOPE,
  });

  let response: Response;
  try {
    response = await fetch(tokenEndpoint(subdomain), {
      method: "POST",
      headers: {
        "Content-Type": "application/x-www-form-urlencoded",
        Accept: "application/json",
      },
      body: body.toString(),
    });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    throw new ZendeskAuthError(
      `Zendesk: network error requesting OAuth token: ${msg}`,
      "token_request_failed",
    );
  }

  const text = await response.text();
  let parsed: ZendeskTokenResponse | null = null;
  try {
    parsed = JSON.parse(text) as ZendeskTokenResponse;
  } catch {
    // Non-JSON body; fall through to the status-based message.
  }

  if (!response.ok || !parsed?.access_token) {
    const detail =
      parsed?.error_description ?? parsed?.error ?? `HTTP ${response.status}`;
    throw new ZendeskAuthError(
      `Zendesk OAuth token request failed: ${detail}. ` +
        "Check ZENDESK_CLIENT_ID / ZENDESK_CLIENT_SECRET, that the client is " +
        "Confidential, and that the token scope is within the client's " +
        "Allowed scopes (400 invalid_scope = requested scope exceeds the " +
        "ceiling configured in Admin Center).",
      "token_request_failed",
    );
  }

  return parsed.access_token;
}

// Return a valid access token, using the cache when it is fresh. Reactively
// refreshes when the cache is missing or inside the expiry margin. The 401
// path (server-side revocation before expiry) is handled in api.ts, which
// calls resetTokenCache() and retries once.
export async function getZendeskAccessToken(): Promise<string> {
  if (cachedToken && Date.now() < cachedToken.expiresAt) {
    return cachedToken.accessToken;
  }
  const accessToken = await requestZendeskAccessToken();

  // expires_in is in seconds and technically optional; default to the
  // documented 30-minute value when absent.
  const expiresInSec = 1800;
  cachedToken = {
    accessToken,
    expiresAt: Date.now() + expiresInSec * 1000 - EXPIRY_MARGIN_MS,
  };
  return accessToken;
}

// Drop the cached token. Called by api.ts after a 401 invalid_token so the
// retry fetches a fresh one; also used in tests.
export function resetTokenCache(): void {
  cachedToken = undefined;
}

// Test-only alias matching the sibling extensions' _resetAuthCache naming.
export function _resetAuthCache(): void {
  resetTokenCache();
}
