import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import factory, {
	buildClaudeArgs,
	bridgeAskClaudeEnabled,
	bridgeConflictExists,
	bridgePackageEnabled,
	cleanStderr,
	isClaudeBridgeSource,
	loadConfig,
} from "../extensions/index.js";

// getAgentDir() reads PI_CODING_AGENT_DIR; setting it points the whole
// extension (config paths + conflict check) at a throwaway dir per test.
const ENV_AGENT_DIR = "PI_CODING_AGENT_DIR";

let savedAgentDir: string | undefined;
let savedClaudeBin: string | undefined;
let tempRoot: string;

beforeEach(() => {
	savedAgentDir = process.env[ENV_AGENT_DIR];
	savedClaudeBin = process.env.CLAUDE_BIN;
	tempRoot = mkdtempSync(join(tmpdir(), "pi-ask-claude-"));
	process.env[ENV_AGENT_DIR] = tempRoot;
	// Point the binary at nothing so claudeAvailable() resolves false fast
	// (spawn ENOENT). Registration is independent of availability, so this
	// only short-circuits the version probe.
	process.env.CLAUDE_BIN = join(tempRoot, "no-such-claude");
});

afterEach(() => {
	if (savedAgentDir === undefined) delete process.env[ENV_AGENT_DIR];
	else process.env[ENV_AGENT_DIR] = savedAgentDir;
	if (savedClaudeBin === undefined) delete process.env.CLAUDE_BIN;
	else process.env.CLAUDE_BIN = savedClaudeBin;
	delete process.env.FIXTURE_MODE;
	rmSync(tempRoot, { recursive: true, force: true });
});

function writeAgentFile(name: string, contents: unknown): void {
	writeFileSync(join(tempRoot, name), JSON.stringify(contents));
}

// --- buildClaudeArgs -------------------------------------------------------

describe("buildClaudeArgs", () => {
	const base = {
		effort: "default" as const,
		mode: "read" as const,
		allowFullMode: true,
		extraArgs: [],
	};

	it("always uses print + stream-json + verbose", () => {
		const args = buildClaudeArgs({ ...base });
		expect(args[0]).toBe("-p");
		expect(args).toContain("--output-format");
		expect(args[args.indexOf("--output-format") + 1]).toBe("stream-json");
		// claude refuses --print + --output-format=stream-json without --verbose.
		expect(args).toContain("--verbose");
	});

	it("does NOT include the prompt (delivered via stdin instead)", () => {
		const args = buildClaudeArgs({ ...base });
		// No positional prompt: variadic flags would otherwise swallow it.
		expect(args.every((a) => a !== "do the thing" && a !== "hello world")).toBe(true);
	});

	it("read mode uses a read-only --allowedTools allowlist (no plan mode)", () => {
		const args = buildClaudeArgs({ ...base, mode: "read" });
		expect(args).not.toContain("--permission-mode");
		expect(args).not.toContain("--tools");
		const allow = args[args.indexOf("--allowedTools") + 1];
		expect(allow).toContain("Read");
		expect(allow).toContain("Grep");
		expect(allow).not.toContain("Bash");
		expect(allow).not.toContain("Edit");
	});

	it("none mode disables all tools via --tools ''", () => {
		const args = buildClaudeArgs({ ...base, mode: "none" });
		expect(args[args.indexOf("--tools") + 1]).toBe("");
		expect(args).not.toContain("--permission-mode");
	});

	it("full mode uses bypassPermissions when allowed", () => {
		const args = buildClaudeArgs({ ...base, mode: "full", allowFullMode: true });
		expect(args[args.indexOf("--permission-mode") + 1]).toBe("bypassPermissions");
	});

	it("full mode degrades to read allowlist when allowFullMode is false", () => {
		const args = buildClaudeArgs({ ...base, mode: "full", allowFullMode: false });
		expect(args).not.toContain("--permission-mode");
		expect(args[args.indexOf("--allowedTools") + 1]).toContain("Read");
	});

	it("default effort omits --effort", () => {
		const args = buildClaudeArgs({ ...base, effort: "default" });
		expect(args).not.toContain("--effort");
	});

	it("non-default effort passes --effort <level>", () => {
		const args = buildClaudeArgs({ ...base, effort: "high" });
		expect(args[args.indexOf("--effort") + 1]).toBe("high");
	});

	it("passes --model for an alias or full id", () => {
		const args = buildClaudeArgs({ ...base, model: "sonnet" });
		expect(args[args.indexOf("--model") + 1]).toBe("sonnet");
	});

	it("forwards system / append-system prompts only when non-empty", () => {
		const withPrompts = buildClaudeArgs({
			...base,
			systemPrompt: "be terse",
			appendSystemPrompt: "also check tests",
		});
		expect(withPrompts[withPrompts.indexOf("--system-prompt") + 1]).toBe("be terse");
		expect(withPrompts[withPrompts.indexOf("--append-system-prompt") + 1]).toBe("also check tests");

		const without = buildClaudeArgs({ ...base });
		expect(without).not.toContain("--system-prompt");
		expect(without).not.toContain("--append-system-prompt");
	});

	it("fresh run assigns NO session id (captured from init at runtime)", () => {
		const args = buildClaudeArgs({ ...base });
		expect(args).not.toContain("--session-id");
		expect(args).not.toContain("--resume");
	});

	it("continuation uses --resume <id> and no --session-id", () => {
		const id = "0199a213-81c0-7800-8aa1-bbab2a035a53";
		const args = buildClaudeArgs({ ...base, sessionId: id });
		expect(args[args.indexOf("--resume") + 1]).toBe(id);
		expect(args).not.toContain("--session-id");
	});

	it("rejects a non-UUID continuation id (no --resume, fresh run)", () => {
		// A leading-dash value must never bind to --resume (arg-injection guard).
		const args = buildClaudeArgs({ ...base, sessionId: "--dangerous" });
		expect(args).not.toContain("--resume");
		expect(args).not.toContain("--session-id");
	});

	it("splices extra args after the base flags", () => {
		const args = buildClaudeArgs({ ...base, extraArgs: ["--add-dir", "/tmp/x", "--verbose"] });
		expect(args).toContain("--add-dir");
		expect(args[args.indexOf("--add-dir") + 1]).toBe("/tmp/x");
		expect(args).toContain("--verbose");
	});
});

// --- conflict detection ----------------------------------------------------

describe("isClaudeBridgeSource", () => {
	it("matches npm and git install forms", () => {
		expect(isClaudeBridgeSource("npm:pi-claude-bridge")).toBe(true);
		expect(isClaudeBridgeSource("git:github.com/elidickinson/pi-claude-bridge")).toBe(true);
	});
	it("does not match unrelated packages", () => {
		expect(isClaudeBridgeSource("npm:@estebanforge/pi-ask-claude")).toBe(false);
		expect(isClaudeBridgeSource("npm:pi-antigravity-bridge")).toBe(false);
		expect(isClaudeBridgeSource("npm:not-pi-claude-bridge")).toBe(false);
	});
});

describe("bridgePackageEnabled (settings.json packages entry forms)", () => {
	it("plain string = enabled", () => {
		expect(bridgePackageEnabled("npm:pi-claude-bridge")).toBe(true);
	});
	it("object with no extensions key = enabled", () => {
		expect(bridgePackageEnabled({ source: "npm:pi-claude-bridge" })).toBe(true);
	});
	it("object with non-empty extensions = enabled", () => {
		expect(bridgePackageEnabled({ source: "npm:pi-claude-bridge", extensions: ["+src/index.ts"] })).toBe(true);
	});
	it("object with extensions:[] = disabled", () => {
		expect(bridgePackageEnabled({ source: "npm:pi-claude-bridge", extensions: [] })).toBe(false);
	});
	it("unrelated package = not enabled", () => {
		expect(bridgePackageEnabled("npm:pi-ask-codex")).toBe(false);
		expect(bridgePackageEnabled({ source: "npm:pi-ask-codex", extensions: [] })).toBe(false);
	});
});

describe("bridgeAskClaudeEnabled", () => {
	it("true when global sets enabled:true", () => {
		writeAgentFile("claude-bridge.json", { askClaude: { enabled: true } });
		expect(bridgeAskClaudeEnabled(tempRoot, tempRoot)).toBe(true);
	});
	it("false when absent (opt-in default)", () => {
		writeAgentFile("claude-bridge.json", {});
		expect(bridgeAskClaudeEnabled(tempRoot, tempRoot)).toBe(false);
	});
	it("false when explicitly false", () => {
		writeAgentFile("claude-bridge.json", { askClaude: { enabled: false } });
		expect(bridgeAskClaudeEnabled(tempRoot, tempRoot)).toBe(false);
	});
	it("project overrides global", () => {
		writeAgentFile("claude-bridge.json", { askClaude: { enabled: true } });
		const projDir = join(tempRoot, "proj");
		mkdirSync(join(projDir, ".pi"), { recursive: true });
		writeFileSync(join(projDir, ".pi", "claude-bridge.json"), JSON.stringify({ askClaude: { enabled: false } }));
		expect(bridgeAskClaudeEnabled(tempRoot, projDir)).toBe(false);
	});
});

describe("bridgeConflictExists", () => {
	it("no conflict when settings.json has no packages list", () => {
		writeAgentFile("settings.json", {});
		expect(bridgeConflictExists(tempRoot, tempRoot).conflict).toBe(false);
	});

	it("no conflict when bridge is absent from packages", () => {
		writeAgentFile("settings.json", { packages: ["npm:pi-ask-codex", "npm:pi-init"] });
		writeAgentFile("claude-bridge.json", { askClaude: { enabled: true } });
		expect(bridgeConflictExists(tempRoot, tempRoot).conflict).toBe(false);
	});

	it("no conflict when bridge installed but extensions disabled ([])", () => {
		writeAgentFile("settings.json", { packages: [{ source: "npm:pi-claude-bridge", extensions: [] }] });
		writeAgentFile("claude-bridge.json", { askClaude: { enabled: true } });
		expect(bridgeConflictExists(tempRoot, tempRoot).conflict).toBe(false);
	});

	it("no conflict when bridge enabled but askClaude not set (opt-in)", () => {
		writeAgentFile("settings.json", { packages: ["npm:pi-claude-bridge"] });
		writeAgentFile("claude-bridge.json", {});
		expect(bridgeConflictExists(tempRoot, tempRoot).conflict).toBe(false);
	});

	it("CONFLICT when bridge enabled AND askClaude.enabled=true", () => {
		writeAgentFile("settings.json", { packages: ["npm:pi-ask-codex", "npm:pi-claude-bridge"] });
		writeAgentFile("claude-bridge.json", { askClaude: { enabled: true } });
		const r = bridgeConflictExists(tempRoot, tempRoot);
		expect(r.conflict).toBe(true);
		expect(r.reason).toContain("pi-claude-bridge");
	});

	it("fail-open: unparseable settings.json = no conflict", () => {
		writeFileSync(join(tempRoot, "settings.json"), "{ not json");
		expect(bridgeConflictExists(tempRoot, tempRoot).conflict).toBe(false);
	});
});

// --- factory registration branches ----------------------------------------

function makePi() {
	const tools: string[] = [];
	const commands: string[] = [];
	const pi: any = new Proxy(
		{
			registerTool: (def: any) => void tools.push(def?.name),
			registerCommand: (name: string) => void commands.push(name),
			getFlag: () => undefined,
			exec: async () => ({ code: 0, stdout: "", stderr: "" }),
		},
		{
			get(target, prop) {
				return prop in target ? (target as any)[prop] : () => {};
			},
		},
	);
	return { pi, tools, commands };
}

/** Like makePi, but captures the full tool definition (for driving execute()). */
function makePiWithTool() {
	let tool: any = null;
	const pi: any = new Proxy(
		{
			registerTool: (def: any) => {
				tool = def;
			},
			registerCommand: () => {},
			getFlag: () => undefined,
			exec: async () => ({ code: 0, stdout: "", stderr: "" }),
		},
		{
			get(t, p) {
				return p in t ? (t as any)[p] : () => {};
			},
		},
	);
	return { pi, getTool: () => tool };
}

describe("extension factory", () => {
	it("registers the AskClaude tool + /claude command when there is no bridge conflict", async () => {
		writeAgentFile("settings.json", { packages: ["npm:pi-ask-codex"] }); // no bridge
		const { pi, tools, commands } = makePi();
		await factory(pi);
		expect(tools).toContain("AskClaude");
		expect(commands).toContain("claude");
	});

	it("stands down (no tool) when the bridge conflict is active", async () => {
		writeAgentFile("settings.json", { packages: ["npm:pi-claude-bridge"] });
		writeAgentFile("claude-bridge.json", { askClaude: { enabled: true } });
		const { pi, tools, commands } = makePi();
		await factory(pi);
		expect(tools).not.toContain("AskClaude");
		expect(tools).toHaveLength(0);
		// Still registers the explainer command.
		expect(commands).toContain("claude");
	});
});

// --- truthy conflict match (the bridge gates on truthy, not ===true) --------

describe("bridgeAskClaudeEnabled (truthy, mirrors the bridge)", () => {
	it.each([
		["true", true],
		[1, true],
		["true" as unknown as boolean, true],
		["yes" as unknown as boolean, true],
		[0, false],
		["" as unknown as boolean, false],
		[null, false],
	])("enabled=%j => %s", (val, expected) => {
		writeAgentFile("claude-bridge.json", { askClaude: { enabled: val } });
		expect(bridgeAskClaudeEnabled(tempRoot, tempRoot)).toBe(expected);
	});
	it("truthy enabled:1 triggers the conflict", () => {
		writeAgentFile("settings.json", { packages: ["npm:pi-claude-bridge"] });
		writeAgentFile("claude-bridge.json", { askClaude: { enabled: 1 } });
		expect(bridgeConflictExists(tempRoot, tempRoot).conflict).toBe(true);
	});
});

// --- loadConfig: defaultModel sanitize -------------------------------------

describe("loadConfig", () => {
	it("falls back to default when defaultModel starts with '-' (arg-injection guard)", () => {
		writeAgentFile("ask-claude.json", { defaultModel: "--dangerous" });
		expect(loadConfig(tempRoot).defaultModel).toBe("sonnet");
	});
	it("keeps a normal alias", () => {
		writeAgentFile("ask-claude.json", { defaultModel: "opus" });
		expect(loadConfig(tempRoot).defaultModel).toBe("opus");
	});
});

// --- cleanStderr -----------------------------------------------------------

describe("cleanStderr", () => {
	it("drops the stdin-wait warning and empty claude lines", () => {
		const noisy = [
			"Warning: no stdin data received in 3s, proceeding without it.",
			"",
			"claude:",
			"real error: boom",
		].join("\n");
		expect(cleanStderr(noisy)).toBe("real error: boom");
	});
	it("returns empty string for all-noise input", () => {
		expect(cleanStderr("Warning: no stdin data received\n\nclaude")).toBe("");
	});
});

// --- execute() branches via a fake claude fixture --------------------------

function writeClaudeFixture(mode: "ok" | "iserror" | "noresult"): string {
	const script = `#!/usr/bin/env node
const args = process.argv.slice(2);
if (args.includes("--version")) { process.stdout.write("claude-fixture 1.0\\n"); process.exit(0); }
const sid = "11111111-2222-3333-4444-555555555555";
const L = (o) => process.stdout.write(JSON.stringify(o) + "\\n");
// drain stdin (the extension writes the prompt here)
process.stdin.on("data", () => {}).on("end", () => {});
if (process.env.FIXTURE_MODE === "iserror") {
  L({type:"system",subtype:"init",session_id:sid,tools:[]});
  L({type:"result",subtype:"error_during_execution",is_error:true,result:"",num_turns:2});
} else if (process.env.FIXTURE_MODE === "noresult") {
  L({type:"system",subtype:"init",session_id:sid,tools:[]});
  L({type:"assistant",message:{role:"assistant",content:[{type:"text",text:"partial answer"}]}});
} else {
  L({type:"system",subtype:"init",session_id:sid,tools:[]});
  L({type:"assistant",message:{role:"assistant",content:[{type:"text",text:"OK"}]}});
  L({type:"result",subtype:"success",is_error:false,result:"OK",num_turns:1,total_cost_usd:0,usage:{input_tokens:5,output_tokens:2}});
}
process.exit(0);
`;
	const p = join(tempRoot, `claude-fixture-${mode}`);
	writeFileSync(p, script, { mode: 0o755 });
	return p;
}

function callExecute(tool: any, overrides: Record<string, unknown> = {}) {
	return tool.execute(
		"t",
		{ prompt: "hi", mode: "read", ...overrides.params },
		new AbortController().signal,
		undefined,
		{ cwd: tempRoot, model: { provider: "zai", baseUrl: "zai" }, ...overrides.ctx },
	);
}

describe("execute() against a fake claude fixture", () => {
	it("surfaces result.is_error as a note (exit 0, not a clean answer)", async () => {
		process.env.CLAUDE_BIN = writeClaudeFixture("iserror");
		process.env.FIXTURE_MODE = "iserror";
		writeAgentFile("settings.json", { packages: ["npm:pi-ask-codex"] }); // no bridge
		const { pi, getTool } = makePiWithTool();
		await factory(pi);
		const res = await callExecute(getTool());
		const text = res.content?.[0]?.text ?? "";
		expect(text).toContain("claude reported an error");
		expect(text).toContain("error_during_execution");
		expect(res.details?.resultIsError).toBe(true);
	});

	it("falls back to assistant text when no result event is emitted", async () => {
		process.env.CLAUDE_BIN = writeClaudeFixture("noresult");
		process.env.FIXTURE_MODE = "noresult";
		writeAgentFile("settings.json", { packages: ["npm:pi-ask-codex"] });
		const { pi, getTool } = makePiWithTool();
		await factory(pi);
		const res = await callExecute(getTool());
		expect(res.content?.[0]?.text).toContain("partial answer");
	});

	it("returns the answer + captured sessionId on a clean run", async () => {
		process.env.CLAUDE_BIN = writeClaudeFixture("ok");
		process.env.FIXTURE_MODE = "ok";
		writeAgentFile("settings.json", { packages: ["npm:pi-ask-codex"] });
		const { pi, getTool } = makePiWithTool();
		await factory(pi);
		const res = await callExecute(getTool());
		expect(res.content?.[0]?.text).toContain("OK");
		expect(res.details?.sessionId).toBe("11111111-2222-3333-4444-555555555555");
		expect(res.details?.resultIsError).toBe(false);
	});

	it("circular-delegation guard: refuses when provider is claude-bridge", async () => {
		process.env.CLAUDE_BIN = writeClaudeFixture("ok");
		writeAgentFile("settings.json", { packages: ["npm:pi-ask-codex"] });
		const { pi, getTool } = makePiWithTool();
		await factory(pi);
		const res = await callExecute(getTool(), { ctx: { model: { provider: "claude-bridge", baseUrl: "claude-bridge" } } });
		expect(res.content?.[0]?.text).toContain("already running through Claude Code");
		expect(res.details?.stderr).toBe("circular delegation blocked");
	});

	it("liveConflict re-check: refuses if the bridge became active after load", async () => {
		process.env.CLAUDE_BIN = writeClaudeFixture("ok");
		writeAgentFile("settings.json", { packages: ["npm:pi-ask-codex"] }); // no conflict at load
		const { pi, getTool } = makePiWithTool();
		await factory(pi);
		// Now flip the live environment so the bridge IS active.
		writeAgentFile("settings.json", { packages: ["npm:pi-claude-bridge"] });
		writeAgentFile("claude-bridge.json", { askClaude: { enabled: true } });
		const res = await callExecute(getTool());
		expect(res.content?.[0]?.text).toContain("not available");
		expect(res.details?.stderr).toBe("bridge conflict");
	});
});
