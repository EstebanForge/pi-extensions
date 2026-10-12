// Secret guard: hostile-repo hygiene for material that leaves the machine.
// Paths that are secrets by name are withheld wholesale (never inlined);
// everything that does inline passes a redaction pass first. Pure work.
// snapshot.ts owns isSecretPath for the walk; this module owns content.

/** Marker used wherever redaction or a withheld file removed content. */
export const SECRETS_WITHHELD_MARK = "[redacted by pi-unblock secret guard]";

/** Files that are secrets by name never become review material. */
const SECRET_FILE_PATTERNS: RegExp[] = [
	/(^|\/)\.env($|\.)/,
	/\.pem$/,
	/\.(p12|pfx)$/,
	/(^|\/)id_(rsa|ed25519|ecdsa|dsa)/,
	/\.key$/,
	/(^|\/)\.npmrc$/,
	/(^|\/)\.git-credentials$/,
	/(^|\/)credentials?($|\.)/,
	/(^|\/)\.netrc$/,
	/\.tfstate($|\.)/,
];

export function isSecretPath(relPath: string): boolean {
	return SECRET_FILE_PATTERNS.some((re) => re.test(relPath));
}

const PRIVATE_KEY_BLOCK = /-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----/g;

const TOKEN_PATTERNS: RegExp[] = [
	// GitHub / OpenAI / Slack / AWS / Stripe / npm token shapes (8+ payload).
	/\b(?:ghp|gho|ghu|ghs)_[A-Za-z0-9]{8,}/g,
	/\bgithub_pat_[A-Za-z0-9_]{8,}/g,
	/\bsk-[A-Za-z0-9_-]{8,}/g,
	/\bsk_(?:live|test)_[A-Za-z0-9]{8,}/g,
	/\bxox[baprs]-[A-Za-z0-9-]{8,}/g,
	/\bAKIA[A-Z0-9]{12,}/g,
	/\bnpm_[A-Za-z0-9]{8,}/g,
	// Authorization headers and URL basic-auth credentials.
	/\bBearer\s+[A-Za-z0-9_\-/.=+]{8,}/gi,
	/(:\/\/[^/\s:]+:)([^/\s@]{6,})@/g,
	// Assignment/JSON-style credentials: password = "...", "api_key": "..."
	// Only 8+ value chars, so `retries = 3` and empty strings survive. Group 1
	// keeps the key name and separator; group 2 (the value) is replaced.
	/((?:["']?(?:api[_-]?key|secret|token|password|passwd|passphrase)["']?\s*[:=]\s*["']?))([^\s"']{8,})/gi,
];

/** Redact credential material from text headed to a reviewer. */
export function redactText(text: string): string {
	let out = text.replace(PRIVATE_KEY_BLOCK, SECRETS_WITHHELD_MARK);
	for (const re of TOKEN_PATTERNS) {
		out = out.replace(re, (match, prefix: string | undefined) =>
			typeof prefix === "string" ? `${prefix}${SECRETS_WITHHELD_MARK}` : SECRETS_WITHHELD_MARK,
		);
	}
	return out;
}
