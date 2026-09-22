import { describe, expect, it } from "vitest";
import { appendGuidanceTail, terminalEventFor } from "../lib/stream-facade";

describe("terminalEventFor (C2 regression: done vs error branching)", () => {
	it("routes stopReason 'stop' to a done event", () => {
		expect(terminalEventFor("stop")).toEqual({ kind: "done", reason: "stop" });
	});

	it("routes 'length' and 'toolUse' to done", () => {
		expect(terminalEventFor("length")).toEqual({ kind: "done", reason: "length" });
		expect(terminalEventFor("toolUse")).toEqual({ kind: "done", reason: "toolUse" });
	});

	it("routes 'error' to an error event (not done)", () => {
		expect(terminalEventFor("error")).toEqual({ kind: "error", reason: "error" });
	});

	it("routes 'aborted' to an error event (not done)", () => {
		expect(terminalEventFor("aborted")).toEqual({ kind: "error", reason: "aborted" });
	});

	it("defaults undefined to done/stop", () => {
		expect(terminalEventFor(undefined)).toEqual({ kind: "done", reason: "stop" });
	});
});

describe("terminalEventFor (unknown stop reasons coerce to a known done value)", () => {
	it("maps an unrecognized reason to done/stop instead of leaking it", () => {
		// e.g. a future provider's "content_filter" — must stay within the union.
		expect(terminalEventFor("content_filter")).toEqual({ kind: "done", reason: "stop" });
		expect(terminalEventFor("max_completion_tokens")).toEqual({ kind: "done", reason: "stop" });
	});

	it("still routes 'error'/'aborted' to the error branch", () => {
		expect(terminalEventFor("error")).toEqual({ kind: "error", reason: "error" });
		expect(terminalEventFor("aborted")).toEqual({ kind: "error", reason: "aborted" });
	});
});

describe("appendGuidanceTail", () => {
	it("is a no-op when guidance is blank", () => {
		const msgs = [{ role: "user", content: [{ type: "text", text: "hi" }] }];
		expect(appendGuidanceTail(msgs, "   ")).toBe(msgs);
	});

	it("appends a guidance block to the last user message (array content)", () => {
		const msgs = [{ role: "user", content: [{ type: "text", text: "q" }] }];
		const out = appendGuidanceTail(msgs, "GUIDANCE");
		expect(out).not.toBe(msgs); // returns a copy, does not mutate input
		expect(msgs[0].content).toHaveLength(1); // input untouched
		expect(out[0].content).toHaveLength(2);
		expect(out[0].content[1]).toMatchObject({ type: "text", text: expect.stringContaining("GUIDANCE") });
	});

	// Regression: string content was previously dropped, replaced by [block] alone.
	it("preserves string content by wrapping it before the guidance block", () => {
		const msgs = [{ role: "user", content: "my question" }];
		const out = appendGuidanceTail(msgs, "GUIDANCE");
		expect(out[0].content).toHaveLength(2);
		expect(out[0].content[0]).toMatchObject({ type: "text", text: "my question" });
		expect(out[0].content[1]).toMatchObject({ type: "text", text: expect.stringContaining("GUIDANCE") });
	});

	it("appends to the LAST user message when several are present", () => {
		const msgs = [
			{ role: "user", content: [{ type: "text", text: "first" }] },
			{ role: "assistant", content: [{ type: "text", text: "ok" }] },
			{ role: "user", content: [{ type: "text", text: "second" }] },
		];
		const out = appendGuidanceTail(msgs, "G");
		expect(out[0].content).toHaveLength(1); // first user untouched
		expect(out[2].content).toHaveLength(2); // last user gets guidance
	});
});
