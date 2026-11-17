// Quota-exhaustion notice detection (issue #16). agy streams the account's
// quota notice as agent text and ends the turn with end_turn, so the bridge
// must reclassify the settled response into a retryable pi error. The
// errorMessage wording is load-bearing: pi-ai's isRetryableAssistantError
// gates provider failover and treats "quota exceeded"/"billing" wording as
// fail-fast, so the message must carry a retryable marker while staying
// clear of every non-retryable pattern.
// Run: npm test

import assert from "node:assert/strict";
import { test } from "vitest";
import { isRetryableAssistantError } from "@earendil-works/pi-ai/utils/retry";
import type { AssistantMessage } from "@earendil-works/pi-ai";
import { detectQuotaNotice, quotaErrorMessage } from "../src/quota-notice.js";

const ISSUE_NOTICE =
	"⚠ Individual quota reached. Please upgrade your subscription to increase your limits. Resets in 153h38m14s";

function errorOf(errorMessage: string): AssistantMessage {
	return { stopReason: "error", errorMessage } as AssistantMessage;
}

test("detectQuotaNotice: exact issue notice with reset interval", () => {
	const notice = detectQuotaNotice(ISSUE_NOTICE);
	assert.ok(notice);
	assert.equal(notice.resetsIn, "153h38m14s");
});

test("detectQuotaNotice: leading emoji and surrounding whitespace", () => {
	const notice = detectQuotaNotice(`\n ${ISSUE_NOTICE} \n`);
	assert.ok(notice);
	assert.equal(notice.resetsIn, "153h38m14s");
});

test("detectQuotaNotice: variant tier copy without reset clause", () => {
	const notice = detectQuotaNotice("Daily quota reached for this model. Try again tomorrow.");
	assert.ok(notice);
	assert.equal(notice.resetsIn, undefined);
});

test("detectQuotaNotice: short reset forms parse", () => {
	assert.equal(detectQuotaNotice("⚠ Quota exhausted. Resets in 2h5s")?.resetsIn, "2h5s");
});

test("detectQuotaNotice: long answer mentioning quota does not match", () => {
	const body = `${"Your account quota resets daily. ".repeat(30)}⚠ Individual quota reached. Resets in 153h38m14s`;
	assert.equal(detectQuotaNotice(body), undefined);
});

test("detectQuotaNotice: mid-sentence quota mention does not match", () => {
	assert.equal(detectQuotaNotice("The quota resets every week; here is how to check it."), undefined);
});

test("detectQuotaNotice: empty response", () => {
	assert.equal(detectQuotaNotice(""), undefined);
	assert.equal(detectQuotaNotice("   \n"), undefined);
});

test("quotaErrorMessage: satisfies pi's retryable classifier", () => {
	const notice = detectQuotaNotice(ISSUE_NOTICE);
	assert.ok(notice);
	assert.equal(isRetryableAssistantError(errorOf(quotaErrorMessage(notice))), true);
});

test("quotaErrorMessage: keeps the reset interval in the message", () => {
	const notice = detectQuotaNotice(ISSUE_NOTICE);
	assert.ok(notice);
	assert.match(quotaErrorMessage(notice), /153h38m14s/);
});

test("quotaErrorMessage: omits the reset clause when absent", () => {
	const notice = detectQuotaNotice("Daily quota reached.");
	assert.ok(notice);
	const message = quotaErrorMessage(notice);
	assert.equal(isRetryableAssistantError(errorOf(message)), true);
	assert.equal(message.includes("resets in"), false);
});
