// Redaction: secret-shaped material embedded in free text (stderr tails,
// error messages, log string values) must never survive to disk or UI.

import assert from "node:assert/strict";
import { test } from "vitest";
import { redactText } from "../src/redact.js";

test("redactText: API keys embedded in prose", () => {
	assert.equal(redactText("boom AIzaSyA-1234567890abcdefghijklmnopqrstu done"), "boom <redacted> done");
	assert.equal(redactText("sk-abc123def456ghi789jkl failed"), "<redacted> failed");
	assert.equal(redactText("npm_XXXXXXXXXXXXXXXXXXXXXX rejected"), "<redacted> rejected");
	assert.equal(redactText("ghp_XXXXXXXXXXXXXXXXXXXXXX revoked"), "<redacted> revoked");
});

test("redactText: OAuth tokens", () => {
	assert.equal(redactText("auth failed for ya29.a0AfB_by-abcdef123456"), "auth failed for <redacted>");
	assert.equal(redactText("refresh token 1//abcXYZ9876543210-_ref expired"), "refresh token <redacted> expired");
});

test("redactText: authorization and cookie headers", () => {
	const out = redactText("request rejected; authorization: Bearer sk-abc123def456ghi789jkl");
	assert.equal(out.includes("sk-abc"), false);
	assert.ok(out.includes("<redacted>"));
	assert.ok(redactText("set-cookie: session=abc123; path=/").includes("<redacted>"));
});

test("redactText: token-ish JSON fields", () => {
	const out = redactText('{"client_secret":"s3cr3t-value-xyz","api_key":"AIzaSyA-1234567890abcdefghijklmnopqrstu"}');
	assert.equal(out.includes("s3cr3t"), false);
	assert.equal(out.includes("AIzaSyA"), false);
	assert.ok(out.includes("<redacted>"));
});

test("redactText: ordinary text untouched", () => {
	assert.equal(redactText("turn 3 completed, 1284 tokens used, status OK"), "turn 3 completed, 1284 tokens used, status OK");
	assert.equal(redactText(""), "");
});

test("redactText: word-boundary stops mid-word false positives", () => {
	// "desk-" contains "sk-"; without the left \b this corrupted ordinary text.
	assert.equal(redactText("desk-1234567890123456 is a desk id"), "desk-1234567890123456 is a desk id");
	assert.equal(redactText("risk-management-123456789012"), "risk-management-123456789012");
});
