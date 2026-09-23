// Secret redaction for free text: stderr tails, error messages, log string
// values. Patterns ported from pi-antigravity-acp-provider's errors.redact
// (MIT). No length cap here on purpose: callers already bound their own
// output sizes (8192 stderr tails, MAX_STRING truncation), and a cap inside
// this function would silently shorten their output.

const SECRET_PATTERNS: Array<[RegExp, string]> = [
	// API-key prefixes: Google (AIza), OpenAI-style (sk-), npm, GitHub. The
	// left word-boundary stops mid-word matches ("desk-123456789012").
	[/\b(?:AIza|sk-|npm_|gh[opurs]_)[A-Za-z0-9_-]{12,}/gu, "<redacted>"],
	// Google OAuth tokens (access ya29., refresh 1//).
	[/\b(?:ya29\.|1\/\/)[A-Za-z0-9._~+/-]{12,}/gu, "<redacted>"],
	// Credential header values; the key text stays (useful context).
	[/((?:authorization|cookie|set-cookie)\s*[:=]\s*(?:bearer\s+)?)[^\s,;]+/giu, "$1<redacted>"],
	// Token-ish JSON fields; the key stays.
	[
		/((?:["']?(?:access_token|refresh_token|id_token|client_secret|api[-_]?key)["']?)\s*[:=]\s*["']?)[^"'\s,;&}]+/giu,
		"$1<redacted>",
	],
];

/** Replace secret-shaped material with `<redacted>`, preserving structure. */
export function redactText(text: string): string {
	let out = text;
	for (const [pattern, replacement] of SECRET_PATTERNS) out = out.replace(pattern, replacement);
	return out;
}
