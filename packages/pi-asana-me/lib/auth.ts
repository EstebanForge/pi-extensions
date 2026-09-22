// Asana auth. Per project decision: read ASANA_ACCESS_TOKEN from the
// environment ONLY. No file fallback, no other env vars, no config file,
// no keyring integration. The PAT itself is treated as opaque - we
// never log, redact, or echo it anywhere.
//
// Creating a PAT: https://app.asana.com/0/my-apps &rarr; Personal access token.

export class AsanaAuthError extends Error {
  readonly kind: "missing_token";
  constructor() {
    super(
      "Asana: ASANA_ACCESS_TOKEN env var is not set. " +
        "Create a personal access token at https://app.asana.com/0/my-apps, " +
        "then `export ASANA_ACCESS_TOKEN=\"<token>\"` in the shell that runs pi.",
    );
    this.name = "AsanaAuthError";
    this.kind = "missing_token";
  }
}

// Returns the PAT or throws. Caches the lookup so we do not re-read the
// environment on every tool call.
let cachedToken: string | undefined;
let cachedAt = 0;
const CACHE_MS = 60_000;

export function getAsanaToken(): string {
  const now = Date.now();
  if (cachedToken && now - cachedAt < CACHE_MS) return cachedToken;
  const token = process.env.ASANA_ACCESS_TOKEN?.trim();
  if (!token) {
    cachedToken = undefined;
    cachedAt = now;
    throw new AsanaAuthError();
  }
  cachedToken = token;
  cachedAt = now;
  return token;
}

// Wipe the cached token. Useful in tests; no production code path calls this.
export function _resetAuthCache(): void {
  cachedToken = undefined;
  cachedAt = 0;
}
