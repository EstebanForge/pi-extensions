// Unit tests for buildFullPrompt (src/provider.ts).
//
// G10: pi's composed system prompt (operating instructions + AGENTS.md files)
// is prepended as a delimited block on the FIRST prompt of a fresh agy
// conversation. Pure function: no I/O. Run: npm test

import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "vitest";
import { normalizeContext, type Api, type Model, type SimpleStreamOptions, type TranscriptContext } from "@earendil-works/pi-ai";
import {
	SYSTEM_PROMPT_END,
	SYSTEM_PROMPT_PREAMBLE,
	TOOL_PRIORITY_NOTE,
	ToolRoundTrips,
	buildFullPrompt,
	createStreamSimple,
} from "../src/provider.js";
import { resetSyspromptAgentForTests } from "../src/sysprompt-agent.js";
import { SessionStore } from "../src/sessions.js";
import type { StreamDriver, DriverTurnRequest } from "../src/driver.js";

const SYS = "You are pi. Follow AGENTS.md.";

test("fresh conversation: system prompt block is prepended", () => {
	const out = buildFullPrompt(SYS, "", "hello");
	assert.ok(out.startsWith(SYSTEM_PROMPT_PREAMBLE));
	assert.ok(out.includes(SYS));
	assert.ok(out.endsWith(`${SYSTEM_PROMPT_END}\n\n---\n\nhello`));
	// Delimiters wrap exactly one block.
	assert.equal(out.split(SYSTEM_PROMPT_PREAMBLE).length, 2);
	assert.equal(out.split(SYSTEM_PROMPT_END).length, 2);
});

test("no system prompt: plain passthrough (disabled or absent)", () => {
	// The call site passes undefined when config.systemPrompt is off or the
	// conversation is already bound.
	assert.equal(buildFullPrompt(undefined, "", "hello"), "hello");
});

test("tool priority note rides the system prompt gate, before END", () => {
	const out = buildFullPrompt(SYS, "", "hello");
	const iNote = out.indexOf(TOOL_PRIORITY_NOTE);
	assert.ok(iNote > out.indexOf(SYS), "note comes after the user's system prompt");
	assert.ok(iNote < out.indexOf(SYSTEM_PROMPT_END), "note stays inside the delimited block");
	// Same gate: no system prompt, no note.
	assert.equal(buildFullPrompt(undefined, "", "hello").includes(TOOL_PRIORITY_NOTE), false);
});

test("tool priority note routes subagent delegation through pi (issue #6)", () => {
	// Native tools are named so the model recognizes what to avoid.
	assert.match(TOOL_PRIORITY_NOTE, /invoke_subagent/);
	assert.match(TOOL_PRIORITY_NOTE, /manage_subagents/);
	// Conditional: a session with no pi delegation tool bridged must still
	// be allowed to use native spawns, or the model refuses legitimate work.
	assert.match(TOOL_PRIORITY_NOTE, /only if no pi delegation tool/i);
	// Native spawns run inside agy and are invisible to pi-side harnesses.
	assert.match(TOOL_PRIORITY_NOTE, /invisible to pi/i);
	// Ecosystem delegation tool names are listed verbatim so the model
	// recognizes them in its own tool list (pi-subagents' "subagent",
	// Claude Code-style "Agent").
	assert.match(TOOL_PRIORITY_NOTE, /for example subagent, Agent, agent_spawn/);
});

test("empty-string system prompt is treated as absent", () => {
	assert.equal(buildFullPrompt("", "", "hello"), "hello");
});

test("order: system prompt block, then digest, then user prompt", () => {
	const out = buildFullPrompt(SYS, "[pi compaction summary]\nwe chose sqlite", "do it");
	const iSys = out.indexOf(SYS);
	const iDigest = out.indexOf("we chose sqlite");
	const iPrompt = out.indexOf("do it");
	assert.ok(iSys >= 0 && iDigest > iSys && iPrompt > iDigest);
});

test("digest without system prompt keeps digest preamble + prompt", () => {
	const out = buildFullPrompt(undefined, "digest-body", "hello");
	assert.ok(out.includes("\n\ndigest-body\n\n---\n\nhello"));
});

// --- G10 gating (fresh-vs-bound conversation) --------------------------------
// buildFullPrompt is pure; the DECISION lives in runTurnDriver
// (config.systemPrompt && !existing?.conversationId). On stream-json the
// delivery is a staged agent file via --agent, NOT prompt text: agy's
// ~25KB single-line cap silently drops over-cap turns and poisons the
// conversation (issue #2, probed 2026-09-30). Drive the real streamSimple
// with a fake driver and assert on the actual request handed to driver.run.

const model: Model<Api> = {
	id: "gemini-flash",
	name: "Gemini 3.6 Flash (Medium)",
	api: "agy-bridge" as Api,
	provider: "antigravity",
	baseUrl: "agy-bridge://antigravity",
	reasoning: false,
	input: ["text"],
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
	contextWindow: 1_000_000,
	maxTokens: 65_536,
};

function contextWith(prompt: string, systemPrompt?: string): TranscriptContext {
	return normalizeContext({
		systemPrompt,
		messages: [{ role: "user", content: prompt, timestamp: Date.now() }],
	});
}

interface Harness {
	seen: { opts?: DriverTurnRequest };
	streamSimple: ReturnType<typeof createStreamSimple>;
	dir: string;
}

function gateHarness(): Harness {
	const seen: { opts?: DriverTurnRequest } = {};
	const driver: StreamDriver = {
		run: async (opts: DriverTurnRequest) => {
			seen.opts = opts;
			return {
				id: "fake-turn",
				outcome: Promise.resolve({
					status: "OK",
					response: "ok",
					finished: true,
					aborted: false,
					conversationId: "conv-g10",
				}),
				next: async () => null,
				pushExternal: () => {},
			};
		},
	} as unknown as StreamDriver;
	// One tmp dir = one stable session key (cwd-based) across both turns.
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), "agy-sysprompt-"));
	const streamSimple = createStreamSimple({
		entries: [{ id: "gemini-flash", full: "gemini-3.6-flash" }],
		store: new SessionStore(path.join(dir, "sessions.json")),
		driver,
		roundTrips: new ToolRoundTrips(driver),
	});
	return { seen, streamSimple, dir };
}

async function runTurn(h: Harness, prompt: string, systemPrompt?: string): Promise<void> {
	const stream = h.streamSimple(
		model,
		contextWith(prompt, systemPrompt),
		{ cwd: h.dir } as unknown as SimpleStreamOptions,
	);
	for await (const ev of stream) void ev;
}

function withEnv(values: Record<string, string | undefined>, fn: () => Promise<void>): Promise<void> {
	const prev: Record<string, string | undefined> = {};
	for (const [k, v] of Object.entries(values)) {
		prev[k] = process.env[k];
		if (v === undefined) delete process.env[k];
		else process.env[k] = v;
	}
	return fn().finally(() => {
		for (const [k, v] of Object.entries(prev)) {
			if (v === undefined) delete process.env[k];
			else process.env[k] = v;
		}
	});
}

test("gate: fresh conversation stages the system prompt as an agent, not prompt text", async () => {
	const root = fs.mkdtempSync(path.join(os.tmpdir(), "agy-gate-agents-"));
	await withEnv({ AGY_SYSTEM_PROMPT: "on", AGY_AGENT: undefined, AGY_AGENTS_ROOT: root }, async () => {
		resetSyspromptAgentForTests();
		const h = gateHarness();
		try {
			await runTurn(h, "hello", SYS);
			// The prompt line carries ONLY the user message: the block must not
			// ride it (the cap drop is the bug being fixed).
			assert.equal(h.seen.opts?.prompt, "hello");
			const agent = h.seen.opts?.agent ?? "";
			assert.ok(agent.startsWith("pi-bridge-sys-"), "carrier agent passed via --agent");
			const md = fs.readFileSync(path.join(root, agent, "agent.md"), "utf8");
			assert.ok(md.includes(SYS));
			assert.ok(md.includes(TOOL_PRIORITY_NOTE));
		} finally {
			fs.rmSync(h.dir, { recursive: true, force: true });
			fs.rmSync(root, { recursive: true, force: true });
		}
	});
});

test("gate: bound conversation keeps the carrier agent and never re-sends the block", async () => {
	const root = fs.mkdtempSync(path.join(os.tmpdir(), "agy-gate-agents-"));
	await withEnv({ AGY_SYSTEM_PROMPT: "on", AGY_AGENT: undefined, AGY_AGENTS_ROOT: root }, async () => {
		resetSyspromptAgentForTests();
		const h = gateHarness();
		try {
			await runTurn(h, "hello", SYS);
			await runTurn(h, "turn two", SYS);
			// Turn 1 bound conv-g10 via the outcome; turn 2 must ride agy's own
			// history with the bare user message only. The agent name stays
			// stable so the driver profile never drifts on "agent".
			assert.equal(h.seen.opts?.prompt, "turn two");
			assert.ok((h.seen.opts?.agent ?? "").startsWith("pi-bridge-sys-"));
		} finally {
			fs.rmSync(h.dir, { recursive: true, force: true });
			fs.rmSync(root, { recursive: true, force: true });
		}
	});
});

test("gate: systemPrompt off suppresses the block and the carrier agent", async () => {
	const root = fs.mkdtempSync(path.join(os.tmpdir(), "agy-gate-agents-"));
	await withEnv({ AGY_SYSTEM_PROMPT: "off", AGY_AGENT: undefined, AGY_AGENTS_ROOT: root }, async () => {
		resetSyspromptAgentForTests();
		const h = gateHarness();
		try {
			await runTurn(h, "hello", SYS);
			assert.equal(h.seen.opts?.prompt, "hello");
			assert.equal(h.seen.opts?.agent, undefined);
		} finally {
			fs.rmSync(h.dir, { recursive: true, force: true });
			fs.rmSync(root, { recursive: true, force: true });
		}
	});
});

test("gate: a user-configured agent wins; the block falls back inline (never clobber)", async () => {
	const root = fs.mkdtempSync(path.join(os.tmpdir(), "agy-gate-agents-"));
	await withEnv({ AGY_SYSTEM_PROMPT: "on", AGY_AGENT: "my-own-agent", AGY_AGENTS_ROOT: root }, async () => {
		resetSyspromptAgentForTests();
		const h = gateHarness();
		try {
			await runTurn(h, "hello", SYS);
			assert.equal(h.seen.opts?.agent, "my-own-agent");
			const prompt = h.seen.opts?.prompt ?? "";
			assert.ok(prompt.startsWith(SYSTEM_PROMPT_PREAMBLE));
			assert.ok(prompt.includes(SYS));
			// Nothing staged: the user's agent directory stays untouched.
			assert.equal(fs.readdirSync(root).length, 0);
		} finally {
			fs.rmSync(h.dir, { recursive: true, force: true });
			fs.rmSync(root, { recursive: true, force: true });
		}
	});
});
