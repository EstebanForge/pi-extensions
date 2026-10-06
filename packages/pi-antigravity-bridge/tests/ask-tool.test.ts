// Tests for the AskAntigravity tool's catalog parsing and alias resolution.
//
// agy prints TWO columns per line: "<slug>  <display label>". --model takes
// only the slug (col 1); the label is display-only. Gemini and Claude bases
// split their tier out to a separate --effort (the base slug alone is
// invalid); unverified families keep agy's exact slug with NO --effort, and
// the retired gpt-oss family is filtered out outright.
// Run: npm test

import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { test, vi } from "vitest";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { buildFinalPrompt, resolveModel, reviewerAgentMd, stageReviewerAgent, toolModelsFromRaw } from "../src/ask-tool.js";
import { toAgyEffort } from "../src/models.js";

vi.mock("../src/mcp-registration.js", () => ({
	acquireBridgeSuppression: () => () => {},
}));

// The REAL `agy models` stdout shape (verified live 2026-10, trimmed to two
// flash families).
const RAW = [
	"gemini-3.8-flash-high     Gemini 3.8 Flash (High)",
	"gemini-3.8-flash-medium   Gemini 3.8 Flash (Medium)",
	"gemini-3.8-flash-low      Gemini 3.8 Flash (Low)",
	"gemini-3.6-flash-high     Gemini 3.6 Flash (High)",
	"gemini-3.6-flash-medium   Gemini 3.6 Flash (Medium)",
	"gemini-3.6-flash-low      Gemini 3.6 Flash (Low)",
	"gemini-3.1-pro-high       Gemini 3.1 Pro (High)",
	"gemini-3.1-pro-low        Gemini 3.1 Pro (Low)",
	"claude-opus-5-5-low       Claude Opus 5.5 (Low)",
	"claude-opus-5-5-medium    Claude Opus 5.5 (Medium)",
	"claude-opus-5-5-high      Claude Opus 5.5 (High)",
	"claude-sonnet-5-5-low     Claude Sonnet 5.5 (Low)",
	"claude-sonnet-5-5-medium  Claude Sonnet 5.5 (Medium)",
	"claude-sonnet-5-5-high    Claude Sonnet 5.5 (High)",
	"gpt-oss-120b-medium       GPT-OSS 120B (Medium)",
].join("\n");

const entries = toolModelsFromRaw(RAW);
const DEFAULT_THINKING = "medium";

test("toolModelsFromRaw: drops the hidden family even while agy still lists it", () => {
	assert.ok(RAW.includes("gpt-oss-120b-medium"), "fixture must carry the line the filter removes");
	assert.equal(entries.some((e) => e.full.startsWith("gpt-oss-")), false);
});

test("resolveModel: bare base ids resolve to the nearest tier variant", () => {
	// The provider advertises the bare id (antigravity/claude-sonnet-5-5),
	// but a bare base is invalid upstream without --effort: the resolver
	// must pick a variant, not pass the base through raw.
	assert.deepEqual(resolveModel("claude-sonnet-5-5", entries, DEFAULT_THINKING), {
		model: "claude-sonnet-5-5",
		effort: "medium",
	});
	assert.deepEqual(resolveModel("claude-opus-5-5", entries, DEFAULT_THINKING, "high"), {
		model: "claude-opus-5-5",
		effort: "high",
	});
});

test("toolModelsFromRaw: splits the slug (col 1) off the display label", () => {
	// The label must never reach --model: full is the slug only.
	const flashHigh = entries.find((e) => e.full === "gemini-3.8-flash-high");
	assert.deepEqual(flashHigh, {
		full: "gemini-3.8-flash-high",
		family: "flash",
		version: "3.8",
		tier: "high",
	});

	// Tiered Claude slugs parse like Gemini: the -low/-medium/-high suffix is
	// the tier, family "other".
	const sonnetLow = entries.find((e) => e.full === "claude-sonnet-5-5-low");
	assert.deepEqual(sonnetLow, {
		full: "claude-sonnet-5-5-low",
		family: "other",
		version: null,
		tier: "low",
	});
	const opus = entries.find((e) => e.full === "claude-opus-5-5-high");
	assert.equal(opus?.tier, "high");
	assert.equal(opus?.family, "other");
});

test("resolveModel: friendly alias splits Gemini base + default effort", () => {
	assert.deepEqual(resolveModel("flash", entries, DEFAULT_THINKING), {
		model: "gemini-3.8-flash",
		effort: "medium",
	});
	// Pro has no medium variant; its family default is high.
	assert.deepEqual(resolveModel("pro", entries, DEFAULT_THINKING), {
		model: "gemini-3.1-pro",
		effort: "high",
	});
});

test("resolveModel: explicit tier and pinned version", () => {
	assert.deepEqual(resolveModel("flash high", entries, DEFAULT_THINKING), {
		model: "gemini-3.8-flash",
		effort: "high",
	});
	assert.deepEqual(resolveModel("3.6 flash low", entries, DEFAULT_THINKING), {
		model: "gemini-3.6-flash",
		effort: "low",
	});
});

test("resolveModel: short aliases pick the tiered Claude entry and split base+effort", () => {
	// Claude ships low/medium/high like Gemini now: the alias resolves to the
	// base slug and the tier rides --effort (agy rejects a bare base).
	assert.deepEqual(resolveModel("sonnet", entries, DEFAULT_THINKING), {
		model: "claude-sonnet-5-5",
		effort: "medium",
	});
	assert.deepEqual(resolveModel("opus", entries, DEFAULT_THINKING), {
		model: "claude-opus-5-5",
		effort: "medium",
	});
	// gpt-oss is filtered from the catalog and its alias is gone: resolution
	// returns null so the caller passes the raw string and agy rejects it
	// loudly instead of the tool offering a dying model.
	assert.equal(resolveModel("gpt-oss", entries, DEFAULT_THINKING), null);
	assert.equal(resolveModel("gpt-oss-120b-medium", entries, DEFAULT_THINKING), null);
});

test("resolveModel: an exact tiered slug splits to base + effort (not passed whole)", () => {
	// Passing the whole tiered slug to --model is what agy rejects; the resolver
	// must split it exactly like an alias would.
	assert.deepEqual(resolveModel("gemini-3.6-flash-high", entries, DEFAULT_THINKING), {
		model: "gemini-3.6-flash",
		effort: "high",
	});
	// An exact slug from a filtered family no longer resolves either.
	assert.equal(resolveModel("gpt-oss-120b-medium", entries, DEFAULT_THINKING), null);
	// Unknown input stays null: the caller passes it raw to agy.
	assert.equal(resolveModel("futuremodel-9-ultra", entries, DEFAULT_THINKING), null);
	// Claude tiered slugs split exactly like Gemini's.
	assert.deepEqual(resolveModel("claude-sonnet-5-5-low", entries, DEFAULT_THINKING), {
		model: "claude-sonnet-5-5",
		effort: "low",
	});
});

test("resolveModel: explicit preferred tier beats alias tier, default, and clamps to the family", () => {
	// thinking/effort param wins over the alias's own tier and the default.
	assert.deepEqual(resolveModel("flash high", entries, DEFAULT_THINKING, "low"), {
		model: "gemini-3.8-flash",
		effort: "low",
	});
	// Pro has no medium variant; the explicit tier clamps to the nearest
	// listed tier (distance tie low/high -> higher rank wins).
	assert.deepEqual(resolveModel("pro", entries, DEFAULT_THINKING, "medium"), {
		model: "gemini-3.1-pro",
		effort: "high",
	});
	// The explicit tier beats the Claude default and clamps to listed tiers.
	assert.deepEqual(resolveModel("sonnet", entries, DEFAULT_THINKING, "high"), {
		model: "claude-sonnet-5-5",
		effort: "high",
	});
});

test("toAgyEffort: full pi thinking-level vocabulary clamps to agy tiers", () => {
	const all: readonly ("low" | "medium" | "high")[] = ["low", "medium", "high"];
	assert.equal(toAgyEffort("minimal", all), "low");
	assert.equal(toAgyEffort("medium", all), "medium");
	assert.equal(toAgyEffort("xhigh", all), "high");
	assert.equal(toAgyEffort("max", all), "high");
	assert.equal(toAgyEffort(undefined, all), "low");
});

test("resolveModel: short aliases still resolve when agy omits them (static overlay)", () => {
	// agy lists only Gemini here; the static overlay fills in the rest so the
	// aliases never regress to the old human-name format.
	const geminiOnly = toolModelsFromRaw(
		[
			"gemini-3.6-flash-high   Gemini 3.6 Flash (High)",
			"gemini-3.6-flash-medium Gemini 3.6 Flash (Medium)",
			"gemini-3.6-flash-low    Gemini 3.6 Flash (Low)",
		].join("\n"),
	);
	assert.deepEqual(resolveModel("sonnet", geminiOnly, DEFAULT_THINKING), {
		model: "claude-sonnet-5-5",
		effort: "medium",
	});
	// The dropped family is not resurrected by any overlay.
	assert.equal(resolveModel("gpt-oss", geminiOnly, DEFAULT_THINKING), null);
});

// --- Prompt assembly (headless plan-mode hardening) ------------------------
// Root cause probed 2026-09-28: `agy -p --mode plan` soft-denies run_command
// and the turn ends AT the denial (exit 0, empty stdout, no second model
// turn), so one unguarded command attempt kills the whole run. The prompt is
// the only lever the tool owns without touching user config.

test("buildFinalPrompt: plan mode appends the no-commands guard", () => {
	const out = buildFinalPrompt("Review the diff.\n---\ndiff body", "plan", false);
	assert.ok(out.startsWith("Review the diff."));
	// The guard must forbid shell commands outright and point the model back
	// at the prompt material - the only reliably available input.
	assert.match(out, /Do not run shell commands/);
	assert.match(out, /ends the session immediately/);
	assert.ok(
		out.endsWith("state exactly what is missing in your answer instead of trying to fetch it."),
	);
});

test("buildFinalPrompt: plan + digest keeps digest prefix first, guard last", () => {
	const out = buildFinalPrompt("body", "plan", true);
	assert.ok(out.startsWith("(Use compact digests, not full file contents.)\n"));
	assert.ok(out.includes("(Use compact digests, not full file contents.)\nbody\n"));
	assert.ok(out.endsWith("instead of trying to fetch it."));
});

test("buildFinalPrompt: accept-edits never carries the guard", () => {
	// Edit runs keep their tools under skip-permissions; appending the guard
	// would break delegated edits and command use.
	assert.equal(buildFinalPrompt("do the edit", "accept-edits", false), "do the edit");
	assert.equal(
		buildFinalPrompt("do the edit", "accept-edits", true),
		"(Use compact digests, not full file contents.)\ndo the edit",
	);
});

// --- Plan-mode reviewer agent (enforced edit denial) -----------------------
// Probed 2026-09-28 on agy 1.2.12: a per-call agent whose tools list carries
// no file-editing tool reports "none" for edits (hard block, with or without
// the skip flag); commandExecutionPolicy auto lets read commands run headless
// with no user allow rules; plan discipline blocks a redirect-write. The
// prompt guard alone was observed failing once (a sub-agent edited files),
// so the toolset restriction is the real enforcement layer.

test("buildFinalPrompt: agent-enforced plan run forbids file mutation, not commands", () => {
	const out = buildFinalPrompt("review this", "plan", false, true);
	assert.match(out, /Do not create, modify, or delete any files/);
	// Commands are the analysis capability under the agent; the old guard
	// forbidding them outright must NOT apply.
	assert.doesNotMatch(out, /Do not run shell commands/);
	assert.match(out, /Read-only commands \(git log, git diff/);
});

test("buildFinalPrompt: agent-enforced accept-edits run is unchanged", () => {
	assert.equal(buildFinalPrompt("do the edit", "accept-edits", false, true), "do the edit");
});

test("reviewerAgentMd: toolset must never contain a file-editing tool", () => {
	const md = reviewerAgentMd("pi-bridge-ask-x");
	assert.match(md, /^name: pi-bridge-ask-x$/m);
	assert.match(md, /commandExecutionPolicy: auto/);
	assert.match(md, /mainAgent: true/);
	// The hard edit block is tool ABSENCE: these must never appear.
	assert.doesNotMatch(md, /create_file/);
	assert.doesNotMatch(md, /edit_file/);
	assert.doesNotMatch(md, /write_file/);
	assert.match(md, /- view_file/);
	assert.match(md, /- run_command/);
});

test("stageReviewerAgent: creates a unique pid-marked agent dir under root", () => {
	const root = fs.mkdtempSync(path.join(os.tmpdir(), "ask-agents-"));
	const a = stageReviewerAgent(root);
	const b = stageReviewerAgent(root);
	assert.notEqual(a.name, b.name);
	assert.match(a.name, /^pi-bridge-ask-/);
	assert.ok(fs.existsSync(path.join(a.dir, "agent.md")));
	assert.equal(fs.readFileSync(path.join(a.dir, ".pid"), "utf8").trim(), String(process.pid));
	fs.rmSync(root, { recursive: true, force: true });
});

// --- Execute wiring (argv captured through the fake-binary seam) -----------

type RegisteredTool = {
	name: string;
	execute: (
		id: string,
		params: Record<string, unknown>,
		signal?: unknown,
		onUpdate?: unknown,
		ctx?: Record<string, unknown>,
	) => Promise<{ content: Array<{ type: string; text: string }> }>;
};

// The binary resolves at SPAWN time, so AGY_BIN must stay pointed at the
// fake through execute - registration does not spawn (the repo hit this
// exact bug before; see the ask-tool-empty-output header note).
async function registerTool(): Promise<RegisteredTool> {
	const tools: RegisteredTool[] = [];
	const fakePi = {
		registerTool: (tool: RegisteredTool) => tools.push(tool),
	} as unknown as ExtensionAPI;
	const { registerAskAntigravityTool } = await import("../src/ask-tool.js");
	await registerAskAntigravityTool(fakePi, []);
	assert.equal(tools.length, 1);
	return tools[0];
}

/** Fake agy that records its argv (NUL-delimited) and exits 0 with a stub answer. */
function makeArgvCapturingAgyBin(argvFile: string): string {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), "agy-bin-argv-"));
	const bin = path.join(dir, "agy");
	const script = [
		"#!/usr/bin/env bash",
		`printf '%s\\0' "$@" > ${JSON.stringify(argvFile)}`,
		"echo ok",
		"exit 0",
		"",
	].join("\n");
	fs.writeFileSync(bin, script, { mode: 0o755 });
	return bin;
}

function withEnvs(
	values: Record<string, string | undefined>,
	fn: () => Promise<void>,
): Promise<void> {
	const prevs = Object.entries(values).map(([k]) => [k, process.env[k]] as const);
	return (async () => {
		for (const [k, v] of Object.entries(values)) {
			if (v === undefined) delete process.env[k];
			else process.env[k] = v;
		}
		try {
			await fn();
		} finally {
			for (const [k, prev] of prevs) {
				if (prev === undefined) delete process.env[k];
				else process.env[k] = prev;
			}
		}
	})();
}

test("execute: plan run passes --agent and the skip flag, prompt carries the review guard, agent dir cleaned up", () =>
	withEnvs(
		{ AGY_SKIP_PERMISSIONS: "true" },
		async () => {
			const agentsRoot = fs.mkdtempSync(path.join(os.tmpdir(), "ask-agents-root-"));
			const argvFile = path.join(agentsRoot, "argv.txt");
			const tool = await registerTool();
			const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "ask-cwd-"));
			await withEnvs(
				{ AGY_AGENTS_ROOT: agentsRoot, AGY_BIN: makeArgvCapturingAgyBin(argvFile) },
				async () => {
					const result = await tool.execute("t1", { prompt: "review this", mode: "plan", cwd }, undefined, undefined, { cwd });
					// Surface an execute failure instead of a confusing argv ENOENT.
					assert.equal(result.content[0].text, "ok");
					const argv = fs.readFileSync(argvFile, "utf8").split("\0");
					const agentIdx = argv.indexOf("--agent");
					assert.ok(agentIdx !== -1, "plan run must pass --agent");
					const agentName = argv[agentIdx + 1] ?? "";
					assert.match(agentName, /^pi-bridge-ask-/);
					// Knob on + agent staged: the flag is safe again - the agent has no
					// file-editing tools, so the write vector it used to open is gone.
					assert.ok(argv.includes("--dangerously-skip-permissions"));
					const prompt = argv[argv.indexOf("-p") + 1] ?? "";
					assert.match(prompt, /Do not create, modify, or delete any files/);
					assert.doesNotMatch(prompt, /Do not run shell commands/);
					assert.ok(!fs.existsSync(path.join(agentsRoot, agentName)), "agent dir must be removed after the run");
					fs.rmSync(cwd, { recursive: true, force: true });
					fs.rmSync(agentsRoot, { recursive: true, force: true });
				},
			);
		},
	));

test("execute: plan run with agent staging failed falls back to no agent, no skip flag, command forbidding guard", () =>
	withEnvs(
		{ AGY_SKIP_PERMISSIONS: "true" },
		async () => {
			// An agents root under a regular file makes mkdir fail -> staging throws.
			const blocker = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "ask-blocker-")), "not-a-dir");
			fs.writeFileSync(blocker, "x");
			const argvFile = path.join(path.dirname(blocker), "argv.txt");
			const tool = await registerTool();
			const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "ask-cwd-"));
			await withEnvs(
				{ AGY_AGENTS_ROOT: path.join(blocker, "sub"), AGY_BIN: makeArgvCapturingAgyBin(argvFile) },
				async () => {
					const result = await tool.execute("t1", { prompt: "review this", mode: "plan", cwd }, undefined, undefined, { cwd });
					assert.equal(result.content[0].text, "ok");
					const argv = fs.readFileSync(argvFile, "utf8").split("\0");
					assert.ok(!argv.includes("--agent"), "staging failure must not pass --agent");
					assert.ok(
						!argv.includes("--dangerously-skip-permissions"),
						"fallback plan run must keep the no-skip rule (guard-only)",
					);
					const prompt = argv[argv.indexOf("-p") + 1] ?? "";
					assert.match(prompt, /Do not run shell commands/);
					fs.rmSync(path.dirname(blocker), { recursive: true, force: true });
				},
			);
		},
	));
