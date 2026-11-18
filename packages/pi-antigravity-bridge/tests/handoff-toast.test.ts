import assert from "node:assert/strict";
import { test } from "vitest";
import { sessionKey } from "../src/provider.js";
import { handoffToast } from "../src/handoff-toast.js";

// The toast fires when the user lands on an antigravity bridge model with no
// bound agy conversation and the digest enabled: the next turn opens a fresh
// conversation and the digest re-delivers pi-side context into it. Every
// other shape stays silent.

test("handoff toast: unbound bridge model with digest on announces the handoff", () => {
	assert.equal(
		handoffToast({ api: "agy-bridge", digestEnabled: true, bound: false, hasContext: true, source: "set" }),
		"handoff context will ship to the new agy conversation",
	);
	assert.equal(
		handoffToast({ api: "agy-bridge", digestEnabled: true, bound: false, hasContext: true, source: "cycle" }),
		"handoff context will ship to the new agy conversation",
	);
});

test("handoff toast: non-bridge models stay silent", () => {
	assert.equal(handoffToast({ api: "anthropic-messages", digestEnabled: true, bound: false, hasContext: true, source: "set" }), null);
	assert.equal(handoffToast({ api: undefined, digestEnabled: true, bound: false, hasContext: true, source: "set" }), null);
});

test("handoff toast: digest off would make the message a lie, so it stays silent", () => {
	assert.equal(handoffToast({ api: "agy-bridge", digestEnabled: false, bound: false, hasContext: true, source: "set" }), null);
});

test("handoff toast: a bound conversation continues as-is, no announcement", () => {
	assert.equal(handoffToast({ api: "agy-bridge", digestEnabled: true, bound: true, hasContext: true, source: "set" }), null);
});

test("handoff toast: an empty session has nothing to hand off, stays silent", () => {
	assert.equal(handoffToast({ api: "agy-bridge", digestEnabled: true, bound: false, hasContext: false, source: "set" }), null);
});

test("handoff toast: session restore is not a switch, stays silent", () => {
	assert.equal(handoffToast({ api: "agy-bridge", digestEnabled: true, bound: false, hasContext: true, source: "restore" }), null);
});

// The handler reproduces the provider's binding key from ctx data; these pin
// the exported derivation it depends on.
test("sessionKey export: sid-scoped, engine-suffixed, cwd fallback", () => {
	assert.equal(sessionKey({ sessionId: "s1" }, "/tmp/x", "stream-json"), "sid:s1");
	assert.equal(sessionKey({ sessionId: "s1" }, "/tmp/x", "acp"), "sid:s1@acp");
	assert.equal(sessionKey(undefined, "/tmp/x", "stream-json"), "cwd:/tmp/x");
});
