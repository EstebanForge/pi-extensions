// Unit tests for buildContextDigest (src/provider.ts).
//
// G1: the digest injects pi-side context agy was not spawned for (compaction
// summaries, other-provider turns, pi-tool results) WITHOUT replaying agy's
// own turns (already in its resumed --conversation DB). Pure function: no I/O.
// Run: npm test

import assert from "node:assert/strict";
import { test } from "vitest";
import type { Message, Usage } from "@earendil-works/pi-ai";
import {
	boundaryFingerprint,
	buildContextDigest,
	buildContextDigestResult,
	compactionFingerprint,
	digestMaxCharsForEngine,
	findLastCompactionIdx,
} from "../src/provider.js";

// pi wraps compaction summaries with this boilerplate (core/messages.js).
const COMP_PREFIX = "The conversation history before this point was compacted into the following summary:\n\n<summary>\n";
const COMP_SUFFIX = "\n</summary>";

function zeroUsage(): Usage {
	return {
		input: 0,
		output: 0,
		cacheRead: 0,
		cacheWrite: 0,
		totalTokens: 0,
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
	};
}

function user(content: string, timestamp = 0): Message {
	return { role: "user", content, timestamp };
}
function compaction(summary: string): Message {
	return user(COMP_PREFIX + summary + COMP_SUFFIX);
}
function asst(provider: string, text: string, timestamp = 0): Message {
	return {
		role: "assistant",
		content: [{ type: "text", text }],
		api: "anthropic-messages" as never,
		provider: provider as never,
		model: "m",
		usage: zeroUsage(),
		stopReason: "stop",
		timestamp,
	};
}
function toolResult(toolName: string, text: string, isError = false, timestamp = 0): Message {
	return {
		role: "toolResult",
		toolCallId: "c",
		toolName,
		content: [{ type: "text", text }],
		isError,
		timestamp,
	};
}

test("empty messages -> empty digest", () => {
	assert.equal(buildContextDigest([], 0), "");
});

test("no compaction and nothing past the watermark -> empty digest", () => {
	// trailing user prompt is always excluded; watermark already covers the rest
	const msgs = [user("hi"), asst("claude", "hello"), user("again")];
	assert.equal(buildContextDigest(msgs, msgs.length), "");
});

test("trailing current prompt is never injected", () => {
	assert.equal(buildContextDigest([user("current prompt")], 0), "");
});

test("compaction summary is injected and its boilerplate wrapper stripped", () => {
	const digest = buildContextDigest([compaction("we decided to use sqlite"), user("now")], 0);
	assert.match(digest, /\[pi compaction summary\]/);
	assert.match(digest, /we decided to use sqlite/);
	assert.doesNotMatch(digest, /<summary>/);
	assert.doesNotMatch(digest, /compacted into the following summary/);
});

test("other-provider assistant turn since watermark is injected", () => {
	const digest = buildContextDigest([asst("claude", "their analysis"), user("now")], 0);
	assert.match(digest, /\[assistant turn from claude\]/);
	assert.match(digest, /their analysis/);
});

test("own (antigravity) assistant turn is skipped to avoid double-counting", () => {
	const msgs = [user("q"), asst("antigravity", "my prior answer"), user("q2")];
	// watermark 1: agy already saw idx 0; idx 1 is its own response -> skipped,
	// and the pre-watermark user msg is not re-injected either.
	assert.equal(buildContextDigest(msgs, 1), "");
	// watermark 0 (fresh session): the prior user msg is legit context agy never
	// saw, so it IS injected, but the antigravity assistant turn never is.
	const d0 = buildContextDigest(msgs, 0);
	assert.match(d0, /\[earlier user message\]/);
	assert.doesNotMatch(d0, /my prior answer/);
});

test("toolResult since watermark is injected, with error label when isError", () => {
	const ok = buildContextDigest([toolResult("read", "file body"), user("now")], 0);
	assert.match(ok, /\[tool result: read\]/);
	assert.match(ok, /file body/);

	const err = buildContextDigest([toolResult("bash", "boom", true), user("now")], 0);
	assert.match(err, /\[tool result: bash \(error\)\]/);
});

test("earlier user message since watermark is injected", () => {
	const digest = buildContextDigest([user("an earlier note"), user("now")], 0);
	assert.match(digest, /\[earlier user message\]/);
	assert.match(digest, /an earlier note/);
});

test("messages before the watermark are excluded", () => {
	const msgs = [user("old"), asst("claude", "old resp"), user("now")];
	// watermark 2 => idx 0 and 1 (the claude turn) are pre-watermark, excluded
	assert.equal(buildContextDigest(msgs, 2), "");
});

test("compaction clamps the window: pre-compaction messages are dropped", () => {
	const msgs = [user("pre-compaction detail"), compaction("the summary"), asst("claude", "post"), user("now")];
	const digest = buildContextDigest(msgs, 0);
	assert.match(digest, /the summary/);
	assert.match(digest, /\[assistant turn from claude\]/);
	assert.match(digest, /post/);
	assert.doesNotMatch(digest, /pre-compaction detail/);
});

test("compaction summary as the immediate predecessor of the prompt injects only the summary", () => {
	const msgs = [user("older"), compaction("just summarized"), user("now")];
	const digest = buildContextDigest(msgs, 0);
	assert.match(digest, /just summarized/);
	assert.doesNotMatch(digest, /older/); // pre-compaction, dropped
	// no delta after the summary (the prompt is excluded), so no delta labels
	assert.doesNotMatch(digest, /\[earlier user message\]/);
});

test("compaction is detected even when watermark points past older messages", () => {
	// watermark 3 would normally start at idx 3, but compaction is at idx 1 =>
	// start clamps to 2, surfacing the post-compaction other-provider turn
	const msgs = [user("a"), compaction("sum"), asst("claude", "after"), user("now")];
	const digest = buildContextDigest(msgs, 3);
	assert.match(digest, /the summary|sum/); // summary always injected
});

test("maxChars keeps the NEWEST delta and marks truncation", () => {
	const msgs = [
		user("old delta line that should be dropped when over budget"),
		user("newest delta line that must survive the cap"),
		user("now"),
	];
	const digest = buildContextDigest(msgs, 0, { maxChars: 90 });
	assert.match(digest, /^\[truncated\]/); // something was cut from the front
	assert.match(digest, /must survive the cap/); // newest kept
	assert.doesNotMatch(digest, /should be dropped/); // oldest dropped first
});

test("maxChars 0 disables the cap", () => {
	const long = "y".repeat(10_000);
	const digest = buildContextDigest([user(long), user("now")], 0, { maxChars: 0 });
	assert.equal(digest.length, `[earlier user message]\n${long}`.length);
});

test("ownProvider override changes which assistant turns are skipped", () => {
	// pretend the bridge registered as "gemini" instead of "antigravity"
	const digest = buildContextDigest([asst("antigravity", "now-foreign turn"), user("now")], 0, {
		ownProvider: "gemini",
	});
	assert.match(digest, /\[assistant turn from antigravity\]/);
});

test("fresh conversation (bound: false) includes own turns and tool results", () => {
	// A fresh agy conversation holds NOTHING server-side: engine switches,
	// recreation recovery, and the mid-session model-switch handoff all open
	// one, so own-provider turns must ship too - the bound-mode skip would
	// otherwise deliver an empty digest and lose the whole pi side.
	const msgs = [asst("antigravity", "prior answer"), toolResult("read", "file body"), user("now")];
	const fresh = buildContextDigest(msgs, 0, { bound: false });
	assert.match(fresh, /\[assistant turn from antigravity\]/);
	assert.match(fresh, /prior answer/);
	assert.match(fresh, /\[tool result: read\]/);
	assert.match(fresh, /file body/);
	// bound mode (default) keeps the own-provider skip
	assert.doesNotMatch(buildContextDigest(msgs, 0), /prior answer/);
});

test("a compaction below a stale watermark resets the window and ships the delta", () => {
	// Post-compaction shrink: the stored count (6) exceeds the transcript
	// length (3). Without the compaction-aware reset the window is empty and
	// every post-compaction delta is silently dropped. First delivery: the
	// summary ships once and the delta restarts after the compaction.
	const msgs = [compaction("the summary"), user("post-compaction note"), user("now")];
	const digest = buildContextDigest(msgs, 6);
	assert.match(digest, /the summary/);
	assert.match(digest, /\[earlier user message\]/);
	assert.match(digest, /post-compaction note/);
});

test("an already-delivered compaction (same content) is not re-injected", () => {
	const msgs = [compaction("the summary"), user("post-compaction note"), user("now")];
	const digest = buildContextDigest(msgs, 6, { seenSummaryId: compactionFingerprint(msgs[0]) });
	assert.doesNotMatch(digest, /the summary/);
	assert.match(digest, /post-compaction note/);
});

test("a second compaction re-arms delivery and restarts the window (pi shape)", () => {
	// pi rebuilds the transcript after every compaction with the summary at
	// the front, so the second compaction lands at the SAME index as the
	// first. Identity must be content-based: a different summary ships even
	// though its index matches the delivered one, and the delta restarts
	// AFTER it - anything between the two compactions is summarized away.
	const msgs = [compaction("new sum"), user("post-second note"), user("now")];
	const first = compaction("old sum");
	const digest = buildContextDigest(msgs, 7, { seenSummaryId: compactionFingerprint(first) });
	assert.match(digest, /new sum/);
	assert.doesNotMatch(digest, /old sum/);
	assert.match(digest, /post-second note/);
	assert.doesNotMatch(digest, /middle/);
});

test("an oversized compaction summary is clamped to the digest budget", () => {
	// A 30KB summary plus an 8000-char cap used to ship a 30KB digest; on
	// stream-json that crosses the ~25KB silent-drop cap (issue #2). The
	// summary must clamp to the cap, head-kept, with a truncation marker.
	const big = compaction("S".repeat(30_000) + " tail gist");
	const digest = buildContextDigest([big, user("now")], 0, { maxChars: 5000 });
	assert.ok(digest.length <= 5000, `digest length ${digest.length} exceeds cap 5000`);
	assert.match(digest, /\[truncated\]/);
	assert.ok(digest.includes("S".repeat(100)), "summary head must be kept");
	assert.doesNotMatch(digest, /tail gist/);
});

test("one oversized toolResult keeps earlier turns visible (issue #25)", () => {
	// The backward truncation loop used to break on the first overflowing
	// part: a single >8KB read result erased every earlier turn from the
	// mid-session handoff (issue #25 repro: "Remember ALPHA-42" vanished).
	const big = toolResult("read", "x".repeat(9_000));
	const digest = buildContextDigest([user("Remember ALPHA-42"), big, user("now")], 0, { maxChars: 8000 });
	assert.match(digest, /ALPHA-42/, "earlier user turn must survive a huge tool result");
	assert.match(digest, /chars elided/, "the oversized body must be elided, not shipped whole");
	assert.ok(!digest.includes("x".repeat(9_000)), "the full oversized body must not ship");
});

test("oversized toolResult elision keeps head and tail (issue #25)", () => {
	const body = "HEAD-START-" + "m".repeat(9000) + "-END-GIST";
	const digest = buildContextDigest([toolResult("bash", body), user("now")], 0, { maxChars: 8000 });
	assert.match(digest, /HEAD-START/, "head slice kept");
	assert.match(digest, /END-GIST/, "tail slice kept");
});

test("assistant toolCall blocks render into the digest with capped args (issue #25)", () => {
	const calls: Message = {
		role: "assistant",
		content: [
			{ type: "text", text: "running the build" } as never,
			{ type: "toolCall", id: "t1", name: "bash", arguments: { command: "x".repeat(500) } } as never,
		],
		api: "anthropic-messages" as never,
		provider: "openai" as never,
		model: "m",
		usage: zeroUsage(),
		stopReason: "stop",
		timestamp: 0,
	};
	const digest = buildContextDigest([calls, user("now")], 0, { maxChars: 8000 });
	assert.match(digest, /running the build/);
	assert.match(digest, /\[tool call: bash\(/, "tool call must render with its name");
	assert.ok(!digest.includes("x".repeat(500)), "args must be capped, not shipped whole");
});

test("a tool-call-only assistant turn now renders (previously skipped)", () => {
	const calls: Message = {
		role: "assistant",
		content: [{ type: "toolCall", id: "t1", name: "edit_file", arguments: { path: "/a" } } as never],
		api: "anthropic-messages" as never,
		provider: "openai" as never,
		model: "m",
		usage: zeroUsage(),
		stopReason: "stop",
		timestamp: 0,
	};
	const digest = buildContextDigest([calls, user("now")], 0, { maxChars: 8000 });
	assert.match(digest, /\[tool call: edit_file\(/, "a call-only turn must still ship");
});

// Direct contracts for the small exported helpers the gate and the toast
// handler depend on.

test("findLastCompactionIdx finds the last summary, skips non-user noise", () => {
	const msgs = [user("plain"), compaction("first"), asst("claude", "noise"), compaction("second"), user("now")];
	assert.equal(findLastCompactionIdx(msgs), 3);
	assert.equal(findLastCompactionIdx([user("plain"), asst("claude", "x")]), -1);
	assert.equal(findLastCompactionIdx([]), -1);
});

test("boundaryFingerprint is role:timestamp, undefined for no message", () => {
	assert.equal(boundaryFingerprint(undefined), undefined);
	assert.equal(boundaryFingerprint(user("x", 1234)), "user:1234");
	assert.equal(boundaryFingerprint(asst("claude", "x", 99)), "assistant:99");
});

test("compactionFingerprint is stable per content and separates summaries", () => {
	const a = compaction("summary A");
	const a2 = compaction("summary A");
	const b = compaction("summary B");
	assert.equal(compactionFingerprint(a), compactionFingerprint(a2));
	assert.notEqual(compactionFingerprint(a), compactionFingerprint(b));
});

test("digestMaxCharsForEngine: acp uncapped by the prompt, stream-json byte-budgeted", () => {
	assert.equal(digestMaxCharsForEngine("acp", 90_000), 8000);
	assert.equal(digestMaxCharsForEngine("stream-json", 0), 8000);
	// Budget from bytes: 25000 - 5000 - 4096 = 15904 -> capped at 8000.
	assert.equal(digestMaxCharsForEngine("stream-json", 5000), 8000);
	assert.equal(digestMaxCharsForEngine("stream-json", 20_000), 904);
	// Exhausted or negative budget ships nothing (maxChars 0 means unbounded,
	// so the sentinel must be null, never 0).
	assert.equal(digestMaxCharsForEngine("stream-json", 21_000), null);
	assert.equal(digestMaxCharsForEngine("stream-json", 25_000), null);
});

test("digest: the window can stop at an explicit end (trailing user run joins the prompt)", () => {
	const msgs = [user("backlog question"), user("current prompt"), user("note")];
	const digest = buildContextDigest(msgs, 0, { bound: false, end: 1 });
	assert.ok(digest.includes("backlog question"), "pre-run backlog stays digest context");
	assert.ok(!digest.includes("current prompt"), "joined prompt members must not reappear in the digest");
	assert.ok(!digest.includes("note"), "the whole run is excluded, not just the last message");
});

test("digest result: untruncated window reports deliveredFrom == windowStart", () => {
	const msgs = [user("alpha"), asst("openai", "beta"), user("gamma")];
	const r = buildContextDigestResult(msgs, 0, { bound: false, maxChars: 8000, includeLast: true });
	assert.equal(r.windowStart, 0);
	assert.equal(r.windowEnd, 3);
	assert.equal(r.deliveredFrom, 0);
	assert.ok(r.text.includes("alpha"));
	assert.ok(r.text.includes("gamma"));
});

test("digest result: budget truncation reports the oldest kept message index", () => {
	// window [0..3): old small, old huge, new small. Newest-first budget keeps
	// only the newest part, so messages 0 and 1 were skipped for budget.
	const msgs = [user("s".repeat(20)), user("h".repeat(5000)), user("t".repeat(20))];
	const r = buildContextDigestResult(msgs, 0, { bound: false, maxChars: 200, includeLast: true });
	assert.equal(r.windowEnd, 3);
	assert.equal(r.deliveredFrom, 2, "deliveredFrom must point at the oldest rendered message");
	assert.ok(r.text.includes("t".repeat(20)));
	assert.ok(!r.text.includes("h".repeat(100)));
});

test("digest result: nothing fits reports deliveredFrom == windowEnd", () => {
	const msgs = [user("h".repeat(5000)), user("t".repeat(5000))];
	const r = buildContextDigestResult(msgs, 0, { bound: false, maxChars: 200 });
	assert.equal(r.windowEnd, 1);
	assert.equal(r.deliveredFrom, 1, "no window content rendered, so nothing is delivered");
	assert.ok(r.text.length < 300, "tail-slice fallback keeps only a marker + slice");
});

test("digest result: bound-mode skips do not move deliveredFrom", () => {
	// own-provider turns render nothing in bound mode; deliveredFrom must
	// still point at the oldest message whose content is in the digest.
	const msgs = [user("alpha"), asst("antigravity", "own turn"), user("gamma")];
	const r = buildContextDigestResult(msgs, 0, { bound: true, maxChars: 8000 });
	assert.equal(r.deliveredFrom, 0);
});
