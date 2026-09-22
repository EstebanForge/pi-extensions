// Slack auth. Per project decision: this extension acts as YOU, not as a bot.
// Read SLACK_USER_TOKEN (xoxp-...) from the environment ONLY. No file fallback,
// no bot token path, no keyring. The token is opaque - never logged, echoed,
// or redacted anywhere.
//
// Creating the token: api.slack.com/apps &rarr; create app &rarr; OAuth & Permissions
// &rarr; User Token Scopes &rarr; Install to workspace &rarr; copy the xoxp- value.
// See README for the full scope list.

export class SlackAuthError extends Error {
  readonly kind: "missing_token";
  constructor() {
    super(
      "Slack: SLACK_USER_TOKEN env var is not set. " +
        "Create a Slack app at https://api.slack.com/apps, add the User Token " +
        'Scopes listed in the README (channels:history, groups:history, im:history, ' +
        "mpim:history, channels:read, groups:read, im:read, mpim:read, users:read, " +
        "search:read, files:read, chat:write, im:write), install it to your workspace, then " +
        '`export SLACK_USER_TOKEN="xoxp-..."` in the shell that runs pi.',
    );
    this.name = "SlackAuthError";
    this.kind = "missing_token";
  }
}

// Returns the user token or throws. Caches the lookup so we do not re-read the
// environment on every tool call.
let cachedToken: string | undefined;
let cachedAt = 0;
const CACHE_MS = 60_000;

export function getSlackToken(): string {
  const now = Date.now();
  if (cachedToken && now - cachedAt < CACHE_MS) return cachedToken;
  const token = process.env.SLACK_USER_TOKEN?.trim();
  if (!token) {
    cachedToken = undefined;
    cachedAt = now;
    throw new SlackAuthError();
  }
  cachedToken = token;
  cachedAt = now;
  return token;
}

// True when the env var is present and non-empty. UI/status use only - never
// use this to gate a tool (call getSlackToken inside the tool so the rich
// SlackAuthError surfaces).
export function hasSlackToken(): boolean {
  return Boolean(process.env.SLACK_USER_TOKEN?.trim());
}

// Wipe the cached token. Useful in tests; no production code path calls this.
export function _resetAuthCache(): void {
  cachedToken = undefined;
  cachedAt = 0;
}
