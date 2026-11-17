// Quota-exhaustion notice detection (issue #16). agy streams the account's
// quota notice as plain agent text and ends the turn with end_turn, so the
// provider reclassifies the settled response into a pi error instead of a
// successful reply.
//
// The pi-side errorMessage wording is load-bearing: pi-ai's
// isRetryableAssistantError gates provider failover and classifies
// "quota exceeded" / "billing" wording as fail-fast (no router handoff), so
// the message must carry a retryable marker ("rate limit") while staying
// clear of every non-retryable pattern. The raw upstream notice is never
// echoed, so upstream copy drift cannot poison the classification.

/** Reset interval parsed from the notice, e.g. "153h38m14s". */
export interface QuotaNotice {
	resetsIn?: string;
}

// Anchored at the start and length-capped so only a notice-shaped
// (near-)whole response reclassifies; a long answer that merely discusses
// quota must never match.
const NOTICE_PATTERN = /^\s*(?:⚠\s*)?(?:[a-z]+\s+)?quota\s+(?:reached|exhausted|exceeded|limit reached)/i;
const RESET_PATTERN = /resets?\s+in\s+((?:\d+h)?(?:\d+m)?(?:\d+s))/i;
const NOTICE_MAX_CHARS = 400;

/** Classify a settled driver response as a quota-exhaustion notice.
 *  Conservative by design: false negatives keep a normal reply, false
 *  positives would turn real answers into errors. */
export function detectQuotaNotice(response: string): QuotaNotice | undefined {
	const trimmed = response.trim();
	if (trimmed.length === 0 || trimmed.length > NOTICE_MAX_CHARS) return undefined;
	if (!NOTICE_PATTERN.test(trimmed)) return undefined;
	const resetsIn = RESET_PATTERN.exec(trimmed)?.[1];
	return resetsIn ? { resetsIn } : {};
}

/** Retryable-classified pi errorMessage for a detected notice. */
export function quotaErrorMessage(notice: QuotaNotice): string {
	const reset = notice.resetsIn ? `; resets in ${notice.resetsIn}` : "";
	return `agy rate limit (ResourceExhausted): Antigravity quota exhausted${reset}`;
}
