import { describe, expect, it } from "vitest";
import {
	buildClaudeArgs,
	cleanClaudeStderr,
	consumeClaudeEvent,
	emptyClaudeEventState,
	type ClaudeStreamEvent,
} from "../src/peers/claude.js";

// Characterization suite for the Claude peer adapter, ported from
// pi-ask-claude's inline logic before its extension was refactored onto
// this module. Pins: argv shape (prompt never in argv), the session-id
// capture rules, result/usage extraction, assistant-text fallback, and
// the status-line vocabulary.

const ev = (partial: Record<string, unknown>): ClaudeStreamEvent => partial as unknown as ClaudeStreamEvent;

describe("buildClaudeArgs", () => {
	const base = {
		effort: "default" as const,
		mode: "read" as const,
		allowFullMode: true,
		extraArgs: [],
	};

	it("always uses print + stream-json + verbose, never carries the prompt", () => {
		const args = buildClaudeArgs({ ...base });
		expect(args[0]).toBe("-p");
		expect(args[args.indexOf("--output-format") + 1]).toBe("stream-json");
		expect(args).toContain("--verbose");
		// Variadic flags would swallow a positional prompt; stdin carries it.
		expect(args.every((a) => a !== "do the thing")).toBe(true);
	});

	it("maps the three permission modes", () => {
		const full = buildClaudeArgs({ ...base, mode: "full" });
		expect(full[full.indexOf("--permission-mode") + 1]).toBe("bypassPermissions");

		const none = buildClaudeArgs({ ...base, mode: "none" });
		expect(none[none.indexOf("--tools") + 1]).toBe("");

		const read = buildClaudeArgs({ ...base, mode: "read" });
		expect(read[read.indexOf("--allowedTools") + 1]).toContain("Read");
		expect(read[read.indexOf("--allowedTools") + 1]).not.toContain("Bash");
	});

	it("degrades full mode to the read allowlist when allowFullMode is false", () => {
		const args = buildClaudeArgs({ ...base, mode: "full", allowFullMode: false });
		expect(args).not.toContain("--permission-mode");
		expect(args[args.indexOf("--allowedTools") + 1]).toContain("Read");
	});

	it("omits --effort for default; forwards system prompts only when non-empty", () => {
		expect(buildClaudeArgs({ ...base })).not.toContain("--effort");
		const high = buildClaudeArgs({ ...base, effort: "high" });
		expect(high[high.indexOf("--effort") + 1]).toBe("high");

		const quiet = buildClaudeArgs({ ...base });
		expect(quiet).not.toContain("--system-prompt");
		expect(quiet).not.toContain("--append-system-prompt");
		const loud = buildClaudeArgs({ ...base, systemPrompt: "be terse", appendSystemPrompt: "check tests" });
		expect(loud[loud.indexOf("--system-prompt") + 1]).toBe("be terse");
		expect(loud[loud.indexOf("--append-system-prompt") + 1]).toBe("check tests");
	});

	it("resumes only on a well-formed UUID; never emits --session-id", () => {
		const fresh = buildClaudeArgs({ ...base });
		expect(fresh).not.toContain("--resume");
		expect(fresh).not.toContain("--session-id");

		const id = "0199a213-81c0-7800-8aa1-bbab2a035a53";
		const resumed = buildClaudeArgs({ ...base, sessionId: id });
		expect(resumed[resumed.indexOf("--resume") + 1]).toBe(id);

		// Leading-dash values must never bind to --resume (arg-injection guard).
		const hostile = buildClaudeArgs({ ...base, sessionId: "--dangerous" });
		expect(hostile).not.toContain("--resume");
	});

	it("splices extra args after the base flags", () => {
		const args = buildClaudeArgs({ ...base, extraArgs: ["--add-dir", "/tmp/x"] });
		expect(args[args.indexOf("--add-dir") + 1]).toBe("/tmp/x");
	});
});

describe("consumeClaudeEvent", () => {
	it("captures the session id from the init event, first writer wins", () => {
		const st = emptyClaudeEventState();
		consumeClaudeEvent(ev({ type: "system", subtype: "init", session_id: "aaa" }), st);
		consumeClaudeEvent(ev({ type: "system", subtype: "init", session_id: "bbb" }), st);
		expect(st.sessionId).toBe("aaa");
	});

	it("extracts result text, error flags, usage, cost and turns", () => {
		const st = emptyClaudeEventState();
		consumeClaudeEvent(
			ev({
				type: "result",
				subtype: "success",
				is_error: false,
				result: "final answer",
				num_turns: 3,
				total_cost_usd: 0.5,
				usage: { input_tokens: 10, output_tokens: 4, cache_read_input_tokens: 7, cache_creation_input_tokens: 2 },
			}),
			st,
		);
		expect(st.finalMessage).toBe("final answer");
		expect(st.resultIsError).toBe(false);
		expect(st.resultSubtype).toBe("success");
		expect(st.turns).toBe(3);
		expect(st.costUsd).toBe(0.5);
		expect(st.usage).toEqual({ inputTokens: 10, outputTokens: 4, cacheReadTokens: 7, cacheWriteTokens: 2 });
	});

	it("marks result errors so a clean exit is never reported as a clean answer", () => {
		const st = emptyClaudeEventState();
		consumeClaudeEvent(ev({ type: "result", subtype: "error_during_execution", is_error: true, result: "" }), st);
		expect(st.resultIsError).toBe(true);
		expect(st.resultSubtype).toBe("error_during_execution");
	});

	it("accumulates assistant text as the fallback answer", () => {
		const st = emptyClaudeEventState();
		consumeClaudeEvent(ev({ type: "assistant", message: { content: [{ type: "text", text: "part one " }] } }), st);
		consumeClaudeEvent(ev({ type: "assistant", message: { content: [{ type: "text", text: "part two" }] } }), st);
		expect(st.assistantText).toBe("part one part two");
	});

	it("surfaces tool_use and tool errors as status lines, skips system noise", () => {
		const st = emptyClaudeEventState();
		consumeClaudeEvent(ev({ type: "system", subtype: "init", session_id: "s" }), st);
		consumeClaudeEvent(
			ev({ type: "assistant", message: { content: [{ type: "tool_use", name: "Bash", input: { command: "npm test" } }] } }),
			st,
		);
		consumeClaudeEvent(ev({ type: "user", message: { content: [{ type: "tool_result", is_error: true }] } }), st);
		consumeClaudeEvent(ev({ type: "assistant", message: { content: [{ type: "text", text: "done" }] } }), st);
		expect(st.statusLines).toEqual(["running: npm test", "tool error"]);
	});

	it("caps the status-line buffer at 100", () => {
		const st = emptyClaudeEventState();
		for (let i = 0; i < 150; i++) {
			consumeClaudeEvent(ev({ type: "assistant", message: { content: [{ type: "tool_use", name: "Bash", input: { command: `cmd ${i}` } }] } }), st);
		}
		expect(st.statusLines.length).toBe(100);
	});
});

describe("cleanClaudeStderr", () => {
	it("drops the stdin-wait warning and bare claude lines", () => {
		const noisy = [
			"Warning: no stdin data received in 3s, proceeding without it.",
			"",
			"claude:",
			"real error: boom",
		].join("\n");
		expect(cleanClaudeStderr(noisy)).toBe("real error: boom");
	});
	it("returns empty for all-noise input", () => {
		expect(cleanClaudeStderr("Warning: no stdin data received\n\nclaude")).toBe("");
	});
});
