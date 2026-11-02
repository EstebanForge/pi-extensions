// Regression: the expand hint must come from the render context pi injects,
// not from a package import. pi 1.5 changed keyHint so an imported copy
// cannot see the host keybindings and formats app.* ids as "".
//
// Run: npm test

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, expect, test } from "vitest";
import factory from "../extensions/index.js";

const ENV_AGENT_DIR = "PI_CODING_AGENT_DIR";

let savedAgentDir: string | undefined;
let savedClaudeBin: string | undefined;
let tempRoot: string;

beforeEach(() => {
	savedAgentDir = process.env[ENV_AGENT_DIR];
	savedClaudeBin = process.env.CLAUDE_BIN;
	tempRoot = mkdtempSync(join(tmpdir(), "pi-ask-claude-hint-"));
	process.env[ENV_AGENT_DIR] = tempRoot;
	// Nonexistent binary: registration is independent of availability; this
	// only short-circuits the version probe.
	process.env.CLAUDE_BIN = join(tempRoot, "no-such-claude");
});

afterEach(() => {
	if (savedAgentDir === undefined) delete process.env[ENV_AGENT_DIR];
	else process.env[ENV_AGENT_DIR] = savedAgentDir;
	if (savedClaudeBin === undefined) delete process.env.CLAUDE_BIN;
	else process.env.CLAUDE_BIN = savedClaudeBin;
	rmSync(tempRoot, { recursive: true, force: true });
});

test("renderResult takes the expand hint from the injected context keyHint", async () => {
	const tools: Array<{
		name: string;
		renderResult: (result: unknown, opts: { expanded?: boolean; isPartial?: boolean }, theme: unknown, context?: unknown) => unknown;
	}> = [];
	const pi = new Proxy(
		{ registerTool: (tool: { name: string }) => void tools.push(tool as never) } as Record<string | symbol, unknown>,
		{
			get(target, prop) {
				return prop in target ? target[prop] : () => {};
			},
		},
	);
	await factory(pi as never);
	const tool = tools.find((t) => t.name === "AskClaude");
	expect(tool).toBeDefined();

	const calls: Array<[string, string]> = [];
	const theme = {
		fg: (style: string, s: string) => {
			calls.push([style, s]);
			return s;
		},
	};
	const hintCalls: Array<[string, string]> = [];
	const context = {
		keyHint: (id: string, description: string) => {
			hintCalls.push([id, description]);
			return `^E ${description}`;
		},
	};
	const rendered = tool!.renderResult(
		{ content: [{ type: "text", text: "x".repeat(1100) }], details: { exitCode: 0 } },
		{ expanded: false, isPartial: false },
		theme,
		context,
	);
	expect(rendered).toBeDefined();
	expect(hintCalls).toEqual([["app.tools.expand", "to expand"]]);
	expect(calls.some(([style, s]) => style === "dim" && s.includes("^E to expand"))).toBe(true);
});
