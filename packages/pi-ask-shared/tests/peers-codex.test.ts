import { describe, expect, it } from "vitest";
import {
	buildCodexArgs,
	classifySlug,
	cleanCodexStderr,
	consumeCodexEvent,
	emptyCodexEventState,
	resolveCodexModel,
	type CodexEvent,
	type CodexModelEntry,
} from "../src/peers/codex.js";

// Characterization suite for the Codex peer adapter, ported from
// pi-ask-codex before its extension refactored onto this module. Pins:
// slug taxonomy + alias resolution (highest version, variant priority,
// upgrade chains), the exec argv contract (prompt as trailing positional
// after `--`, resume drops -C/-s but keeps -m/-c), the exec --json event
// grammar, and stderr noise filtering.

const entry = (full: string, over: Partial<CodexModelEntry> = {}): CodexModelEntry => ({
	full,
	family: classifySlug(full).family,
	version: classifySlug(full).version,
	efforts: [],
	upgrade: null,
	hidden: false,
	...over,
});

const ev = (partial: Record<string, unknown>): CodexEvent => partial as unknown as CodexEvent;

describe("classifySlug", () => {
	it("maps the GPT-6 era suffix taxonomy", () => {
		expect(classifySlug("gpt-6.1-sol")).toEqual({ family: "main", version: "6.1" });
		expect(classifySlug("gpt-5.6-terra")).toEqual({ family: "main", version: "5.6" });
		expect(classifySlug("gpt-5.4")).toEqual({ family: "main", version: "5.4" });
		expect(classifySlug("gpt-6.2-astra")).toEqual({ family: "frontier", version: "6.2" });
		expect(classifySlug("gpt-6-luna")).toEqual({ family: "fast", version: "6" });
		expect(classifySlug("gpt-5.3-mini")).toEqual({ family: "fast", version: "5.3" });
		expect(classifySlug("gpt-5.3-nano")).toEqual({ family: "fast", version: "5.3" });
		expect(classifySlug("gpt-5.2-pro")).toEqual({ family: "pro", version: "5.2" });
		expect(classifySlug("gpt-5.1-codex")).toEqual({ family: "codex", version: "5.1" });
		expect(classifySlug("gpt-5.1-codex-max")).toEqual({ family: "codex", version: "5.1" });
	});

	it("lands unknown shapes in other, excluded from alias resolution", () => {
		expect(classifySlug("codex-auto-review")).toEqual({ family: "other", version: null });
		expect(classifySlug("gpt-daybreak-blue-latest")).toEqual({ family: "other", version: null });
		// Compound variants fall to other (exact-only) by design.
		expect(classifySlug("gpt-5.6-mini-pro").family).toBe("other");
	});
});

describe("resolveModel", () => {
	it("returns null flagValue for default/empty (omit --model)", () => {
		expect(resolveCodexModel("default", [])).toEqual({ flagValue: null, entry: null });
		expect(resolveCodexModel("", [])).toEqual({ flagValue: null, entry: null });
	});

	it("picks the highest version of the family, numeric not lexical (5.10 > 5.9)", () => {
		const catalog = [entry("gpt-5.9-sol"), entry("gpt-5.10-sol")];
		const r = resolveCodexModel("full", catalog);
		expect(r.flagValue).toBe("gpt-5.10-sol");
	});

	it("breaks version ties by main variant priority: sol > plain > terra", () => {
		const catalog = [entry("gpt-6.1-terra"), entry("gpt-6.1"), entry("gpt-6.1-sol")];
		expect(resolveCodexModel("full", catalog).flagValue).toBe("gpt-6.1-sol");
		expect(resolveCodexModel("full", [entry("gpt-6.1-terra"), entry("gpt-6.1")]).flagValue).toBe("gpt-6.1");
	});

	it("pins a version when the alias carries one", () => {
		const catalog = [entry("gpt-6.1-sol"), entry("gpt-6-sol")];
		expect(resolveCodexModel("6 mini", [entry("gpt-6-luna"), entry("gpt-6.1-luna")]).flagValue).toBe("gpt-6-luna");
		expect(resolveCodexModel("6.1 full", catalog).flagValue).toBe("gpt-6.1-sol");
	});

	it("routes tier aliases: mini/nano/luna fast, astra frontier, pro pro, codex codex", () => {
		expect(resolveCodexModel("mini", [entry("gpt-6-luna")]).flagValue).toBe("gpt-6-luna");
		expect(resolveCodexModel("astra", [entry("gpt-6.1-astra")]).flagValue).toBe("gpt-6.1-astra");
		expect(resolveCodexModel("pro", [entry("gpt-6-pro")]).flagValue).toBe("gpt-6-pro");
		expect(resolveCodexModel("codex", [entry("gpt-6-codex")]).flagValue).toBe("gpt-6-codex");
	});

	it("excludes hidden entries from alias pools but keeps exact matches", () => {
		const catalog = [entry("gpt-6.1-sol", { hidden: true }), entry("gpt-6-sol")];
		expect(resolveCodexModel("full", catalog).flagValue).toBe("gpt-6-sol");
		expect(resolveCodexModel("gpt-6.1-sol", catalog).flagValue).toBe("gpt-6.1-sol");
	});

	it("passes through unknown aliases and empty families verbatim", () => {
		// A gpt-prefixed non-slug parses as a main-family alias (contains the
		// standalone "gpt" token) and picks the catalog's highest main model;
		// only an EMPTY main family falls through verbatim.
		expect(resolveCodexModel("gpt-daybreak-blue-latest", [entry("gpt-6-sol")]).flagValue).toBe("gpt-6-sol");
		expect(resolveCodexModel("gpt-daybreak-blue-latest", []).flagValue).toBe("gpt-daybreak-blue-latest");
		expect(resolveCodexModel("pro", [entry("gpt-6-sol")]).flagValue).toBe("pro");
		// Pinned version absent from catalog: passthrough, never fabricated.
		expect(resolveCodexModel("9 full", [entry("gpt-6-sol")]).flagValue).toBe("9 full");
	});

	it("follows the upgrade chain for deprecated models, bounded and cycle-safe", () => {
		const deprecated = entry("gpt-5.4-mini", { upgrade: "gpt-6-luna" });
		expect(resolveCodexModel("gpt-5.4-mini", [deprecated, entry("gpt-6-luna")]).flagValue).toBe("gpt-6-luna");
		// Upgrade target absent from catalog: forward the pointer anyway —
		// dispatching the retired slug guarantees a server rejection.
		expect(resolveCodexModel("gpt-5.4-mini", [deprecated]).flagValue).toBe("gpt-6-luna");
		// Cycle: a->b->a terminates deterministically.
		const a = entry("gpt-5.4-mini", { upgrade: "gpt-5.5-mini" });
		const b = entry("gpt-5.5-mini", { upgrade: "gpt-5.4-mini" });
		expect(resolveCodexModel("gpt-5.4-mini", [a, b]).flagValue).toBe("gpt-5.5-mini");
	});
});

describe("buildCodexArgs", () => {
	const base = {
		model: "gpt-6.1-sol" as string | null,
		reasoning: "medium",
		sandbox: "danger-full-access" as const,
		cwd: "/workspace",
		extraArgs: [] as string[],
		prompt: "do the thing",
	};

	it("fresh run: exec --json with prompt as trailing positional after --", () => {
		const args = buildCodexArgs({ ...base });
		expect(args[0]).toBe("exec");
		expect(args).toContain("--json");
		expect(args).toContain("--skip-git-repo-check");
		expect(args[args.indexOf("-m") + 1]).toBe("gpt-6.1-sol");
		expect(args[args.indexOf("-c") + 1]).toBe('model_reasoning_effort="medium"');
		expect(args[args.indexOf("-C") + 1]).toBe("/workspace");
		expect(args[args.indexOf("-s") + 1]).toBe("danger-full-access");
		// `--` ends option parsing so a dash-leading prompt stays the prompt.
		expect(args[args.length - 2]).toBe("--");
		expect(args[args.length - 1]).toBe("do the thing");
	});

	it("resume: keeps -m/-c, drops -C/-s, threads the session id positional", () => {
		const id = "0199a213-81c0-7800-8aa1-bbab2a035a53";
		const args = buildCodexArgs({ ...base, sessionId: id });
		expect(args[1]).toBe("resume");
		expect(args).toContain("-m");
		expect(args).toContain("-c");
		expect(args).not.toContain("-C");
		expect(args).not.toContain("-s");
		expect(args).toContain(id);
	});

	it("omits --model when the resolution is null (codex default)", () => {
		const args = buildCodexArgs({ ...base, model: null });
		expect(args).not.toContain("-m");
	});

	it("rejects a non-UUID continuation id (fresh run, no resume)", () => {
		// A leading-dash value must never bind as the resume positional.
		const args = buildCodexArgs({ ...base, sessionId: "--dangerously-bypass-approvals-and-sandbox" });
		expect(args).not.toContain("resume");
		expect(args).not.toContain("--dangerously-bypass-approvals-and-sandbox");
	});

	it("adds the context dir before the prompt separator", () => {
		const args = buildCodexArgs({ ...base, addDir: "/ctx/dir" });
		expect(args[args.indexOf("--add-dir") + 1]).toBe("/ctx/dir");
		expect(args.indexOf("--add-dir")).toBeLessThan(args.indexOf("--"));
	});

	it("splices extra args after the base flags, before -m", () => {
		const args = buildCodexArgs({ ...base, extraArgs: ["--profile", "work"] });
		expect(args.indexOf("--profile")).toBeGreaterThan(args.indexOf("--skip-git-repo-check"));
		expect(args.indexOf("--profile")).toBeLessThan(args.indexOf("-m"));
	});

	it("carries a 250KB prompt as the positional (codex's documented interface)", () => {
		// Pinned deliberately: codex takes the prompt as argv, unlike the
		// stdin transport other peers use. The E2BIG exposure is codex-side.
		const big = "y".repeat(250_000);
		const args = buildCodexArgs({ ...base, prompt: big });
		expect(args[args.length - 1]).toBe(big);
	});
});

describe("consumeCodexEvent", () => {
	it("captures thread_id, final agent_message, and usage", () => {
		const st = emptyCodexEventState();
		consumeCodexEvent(ev({ type: "thread.started", thread_id: "0199a213-81c0" }), st);
		consumeCodexEvent(
			ev({ type: "item.completed", item: { id: "1", type: "agent_message", text: "final answer" } }),
			st,
		);
		consumeCodexEvent(
			ev({ type: "turn.completed", usage: { input_tokens: 8, output_tokens: 3, reasoning_output_tokens: 5 } }),
			st,
		);
		expect(st.sessionId).toBe("0199a213-81c0");
		expect(st.finalMessage).toBe("final answer");
		expect(st.usage).toEqual({ inputTokens: 8, outputTokens: 3, reasoningTokens: 5 });
	});

	it("surfaces command execution as running/verifying status lines", () => {
		const st = emptyCodexEventState();
		consumeCodexEvent(
			ev({ type: "item.started", item: { id: "1", type: "command_execution", command: "npm test" } }),
			st,
		);
		consumeCodexEvent(
			ev({
				type: "item.started",
				item: { id: "2", type: "command_execution", command: "ls -la" },
			}),
			st,
		);
		consumeCodexEvent(
			ev({
				type: "item.completed",
				item: { id: "1", type: "command_execution", command: "npm test", status: "completed", exit_code: 0 },
			}),
			st,
		);
		expect(st.statusLines).toEqual(["verifying: npm test", "running: ls -la", "command completed: npm test (exit 0)"]);
	});

	it("maps the remaining item vocabulary", () => {
		const st = emptyCodexEventState();
		consumeCodexEvent(
			ev({ type: "item.completed", item: { id: "1", type: "reasoning", text: "thinking hard about it" } }),
			st,
		);
		consumeCodexEvent(
			ev({
				type: "item.completed",
				item: { id: "2", type: "file_change", changes: [{ path: "a.ts", kind: "edit" }, { path: "b.ts", kind: "add" }] },
			}),
			st,
		);
		consumeCodexEvent(ev({ type: "item.started", item: { id: "3", type: "mcp_tool_call" } }), st);
		consumeCodexEvent(ev({ type: "item.completed", item: { id: "4", type: "web_search", query: "pi extensions" } }), st);
		consumeCodexEvent(ev({ type: "item.completed", item: { id: "5", type: "todo_list" } }), st);
		// agent_message completed is the answer, never a status line.
		consumeCodexEvent(
			ev({ type: "item.completed", item: { id: "6", type: "agent_message", text: "answer" } }),
			st,
		);
		expect(st.statusLines).toEqual([
			"thinking: thinking hard about it",
			"edited: a.ts, b.ts",
			"tool: 3",
			"searched: pi extensions",
			"plan updated",
		]);
	});

	it("surfaces turn failures and transient errors without treating them as answers", () => {
		const st = emptyCodexEventState();
		consumeCodexEvent(ev({ type: "turn.failed", error: { message: "rate limited" } }), st);
		consumeCodexEvent(ev({ type: "error", message: "reconnecting..." }), st);
		expect(st.statusLines).toEqual(["failed: rate limited", "reconnecting..."]);
		expect(st.finalMessage).toBe("");
	});

	it("caps the status-line buffer at 100", () => {
		const st = emptyCodexEventState();
		for (let i = 0; i < 150; i++) {
			consumeCodexEvent(ev({ type: "item.started", item: { id: `${i}`, type: "command_execution", command: `cmd ${i}` } }), st);
		}
		expect(st.statusLines.length).toBe(100);
	});
});

describe("cleanCodexStderr", () => {
	it("drops the stdin notice and PATH warning", () => {
		const noisy = [
			"Reading additional input from stdin...",
			"WARNING: proceeding, even though we could not update PATH:",
			"real error: boom",
		].join("\n");
		expect(cleanCodexStderr(noisy)).toBe("real error: boom");
	});
	it("returns empty for all-noise input", () => {
		expect(cleanCodexStderr("Reading additional input from stdin...")).toBe("");
	});
});
