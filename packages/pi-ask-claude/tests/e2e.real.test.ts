// End-to-end test: drives the real AskClaude tool.execute() against the live
// `claude` CLI. Gated behind E2E_CLAUDE=1 so the default `npm test` stays
// hermetic (no binary, no network, no subscription quota used in CI).
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import factory from "../extensions/index.js";

const ENV_AGENT_DIR = "PI_CODING_AGENT_DIR";

let savedAgentDir: string | undefined;
let savedClaudeBin: string | undefined;
let tempRoot: string;

beforeEach(() => {
	savedAgentDir = process.env[ENV_AGENT_DIR];
	savedClaudeBin = process.env.CLAUDE_BIN;
	tempRoot = mkdtempSync(join(tmpdir(), "pi-ask-claude-e2e-"));
	process.env[ENV_AGENT_DIR] = tempRoot;
	// Let the real `claude` on PATH resolve (do not override CLAUDE_BIN).
	delete process.env.CLAUDE_BIN;
	// settings.json WITHOUT pi-claude-bridge => no conflict => tool registers.
	writeFileSync(join(tempRoot, "settings.json"), JSON.stringify({ packages: ["npm:pi-ask-codex"] }));
});

afterEach(() => {
	if (savedAgentDir === undefined) delete process.env[ENV_AGENT_DIR];
	else process.env[ENV_AGENT_DIR] = savedAgentDir;
	if (savedClaudeBin === undefined) delete process.env.CLAUDE_BIN;
	else process.env.CLAUDE_BIN = savedClaudeBin;
	rmSync(tempRoot, { recursive: true, force: true });
});

function makePi() {
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
		{ get(t, p) {
			return p in t ? (t as any)[p] : () => {};
		} },
	);
	return { pi, getTool: () => tool };
}

describe.skipIf(!process.env.E2E_CLAUDE)("AskClaude e2e (real claude CLI)", () => {
	it("stands down when the REAL ~/.pi/agent has the bridge active", async () => {
		// Use the real agent dir (the live env has npm:pi-claude-bridge enabled
		// AND askClaude.enabled=true), so the guard MUST fire.
		delete process.env[ENV_AGENT_DIR];
		const { pi, getTool } = makePi();
		const cmds: string[] = [];
		(pi as any).registerCommand = (n: string) => void cmds.push(n);
		await factory(pi);
		expect(getTool()).toBeNull();
		expect(cmds).toContain("claude");
	}, 60_000);

	it("read mode returns the answer and a captured sessionId", async () => {
		const { pi, getTool } = makePi();
		await factory(pi);
		const tool = getTool();
		expect(tool).toBeTruthy();

		const result = await tool.execute(
			"e2e",
			{ prompt: "Reply with exactly: OK", mode: "read" },
			new AbortController().signal,
			undefined,
			{ cwd: tempRoot, model: { provider: "zai", baseUrl: "zai" } },
		);

		const text = result.content?.[0]?.text ?? "";
		expect(text).toContain("OK");
		expect(result.details?.sessionId).toMatch(
			/^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$/,
		);
		expect(result.details?.exitCode).toBe(0);
	}, 120_000);

	it("resumes a prior session and remembers context", async () => {
		const { pi, getTool } = makePi();
		await factory(pi);
		const tool = getTool();

		const first = await tool.execute(
			"e2e1",
			{ prompt: "Remember the secret word: PINEAPPLE. Reply OK.", mode: "read" },
			new AbortController().signal,
			undefined,
			{ cwd: tempRoot, model: { provider: "zai", baseUrl: "zai" } },
		);
		const sid = first.details?.sessionId;
		expect(sid).toBeTruthy();

		const second = await tool.execute(
			"e2e2",
			{ prompt: "What was the secret word? Reply with just the word.", mode: "read", sessionId: sid },
			new AbortController().signal,
			undefined,
			{ cwd: tempRoot, model: { provider: "zai", baseUrl: "zai" } },
		);
		expect(second.content?.[0]?.text ?? "").toContain("PINEAPPLE");
	}, 180_000);
});
