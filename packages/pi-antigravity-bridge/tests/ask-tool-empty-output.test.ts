// Regression: exit 0 with EMPTY stdout must not read as a silent success.
// Headless agy auto-denies a permission-gated tool call (e.g. the command
// gate in plan mode — the flag is withheld there since the plan-mode fix),
// prints the reason only to stderr, and ends cleanly. The tool used to fall
// through to the success path and return just the conversation footer, which
// the delegator read as "returned only a conversationId, zero output, no
// error" (silent-failure bug found 2026-09-25, peer handoff).
//
// Stub: AGY_BIN pointed at a fake binary that exits 0 with empty stdout and
// the real jetski stderr message. mcp-registration is mocked (the real one
// rewrites the user's global ~/.gemini/config/mcp_config.json).
//
// Run: npm test

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { expect, test, vi } from "vitest";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

vi.mock("../src/mcp-registration.js", () => ({
	acquireBridgeSuppression: () => () => {},
}));

import { registerAskAntigravityTool } from "../src/ask-tool.js";

type ToolResult = { content: Array<{ type: string; text: string }> };

type RegisteredTool = {
	name: string;
	execute: (
		id: string,
		params: Record<string, unknown>,
		signal?: unknown,
		onUpdate?: unknown,
		ctx?: Record<string, unknown>,
	) => Promise<ToolResult>;
	renderResult: (
		result: unknown,
		opts: { expanded?: boolean; isPartial?: boolean },
		theme: unknown,
	) => unknown;
};

// The REAL stderr agy prints when a headless run auto-denies a command
// permission (captured verbatim from a plan-mode repro, 2026-09-25).
const DENIED_STDERR = [
	'jetski: no output produced — a tool required the "command" permission that',
	"headless mode cannot prompt for, so it was auto-denied. Add an allow-rule under",
	"permissions.allow in settings.json (e.g. command(<target>)). Alternatively,",
	"re-run with --dangerously-skip-permissions to auto-approve all tools.",
].join("\n");

function makeFakeAgyBin(stderr: string): string {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), "agy-bin-empty-"));
	const bin = path.join(dir, "agy");
	const script = ["#!/usr/bin/env bash"];
	if (stderr) {
		script.push("cat >&2 <<'AGY_STDERR_EOF'", stderr, "AGY_STDERR_EOF");
	}
	script.push("exit 0", "");
	fs.writeFileSync(bin, script.join("\n"), { mode: 0o755 });
	return bin;
}

async function registerTool(bin: string): Promise<RegisteredTool> {
	const prevBin = process.env.AGY_BIN;
	process.env.AGY_BIN = bin;
	try {
		const tools: RegisteredTool[] = [];
		const fakePi = {
			registerTool: (tool: RegisteredTool) => tools.push(tool),
		} as unknown as ExtensionAPI;
		await registerAskAntigravityTool(fakePi, []);
		expect(tools).toHaveLength(1);
		return tools[0];
	} finally {
		if (prevBin === undefined) delete process.env.AGY_BIN;
		else process.env.AGY_BIN = prevBin;
	}
}

async function runEmptyOutput(tool: RegisteredTool, bin: string): Promise<ToolResult> {
	// The binary resolves at EXECUTE time, so AGY_BIN must stay pointed at the
	// fake through the call, not just through registration.
	const prevBin = process.env.AGY_BIN;
	process.env.AGY_BIN = bin;
	try {
		// mode plan mirrors the reported failure: the skip-permissions flag is
		// withheld there, so permission gates bite (the fake ignores args).
		return await tool.execute(
			"t1",
			{ prompt: "review", cwd: process.cwd(), timeoutMinutes: 1, mode: "plan" },
			undefined,
			undefined,
			{},
		);
	} finally {
		if (prevBin === undefined) delete process.env.AGY_BIN;
		else process.env.AGY_BIN = prevBin;
	}
}

test(
	"exit 0 with empty stdout surfaces the stderr denial, not a silent success",
	{ timeout: 20_000 },
	async () => {
		const bin = makeFakeAgyBin(DENIED_STDERR);
		try {
			const tool = await registerTool(bin);
			const res = await runEmptyOutput(tool, bin);
			const text = res.content[0].text;

			// Loud failure note carrying agy's own reason.
			expect(text).toContain("produced no output");
			expect(text).toContain("auto-denied");
			expect(text).toContain("permissions.allow");

			// Old bug shape: a footer-only empty success.
			expect(text).not.toMatch(/^\[agy conversationId/);
		} finally {
			fs.rmSync(path.dirname(bin), { recursive: true, force: true });
		}
	},
);

test(
	"exit 0 with empty stdout AND empty stderr still fails loudly",
	{ timeout: 20_000 },
	async () => {
		const bin = makeFakeAgyBin("");
		try {
			const tool = await registerTool(bin);
			const res = await runEmptyOutput(tool, bin);
			const text = res.content[0].text;

			expect(text).toContain("produced no output");
			// Empty stderr: the note omits the segment instead of printing an
			// empty "stderr: " label.
			expect(text).not.toContain("stderr:");
			expect(text).not.toMatch(/^\[agy conversationId/);
		} finally {
			fs.rmSync(path.dirname(bin), { recursive: true, force: true });
		}
	},
);

test("renderResult flips to the error glyph on the empty-output failure", async () => {
	// Registration tolerates a missing binary; the render path never spawns.
	const tool = await registerTool("/nonexistent/agy-fake");

	const calls: Array<[string, string]> = [];
	const theme = {
		fg: (style: string, s: string) => {
			calls.push([style, s]);
			return s;
		},
	};
	const rendered = tool.renderResult(
		{
			content: [{ type: "text", text: "agy exited cleanly but produced no output." }],
			details: { exitCode: 0, aborted: false, timedOut: false, empty: true },
		},
		{ expanded: false, isPartial: false },
		theme,
	);
	expect(rendered).toBeDefined();

	// The old errored condition (exitCode/aborted/timedOut only) rendered a
	// green checkmark for this exact failure (peer review, finding 1).
	expect(
		calls.some(([style, s]) => style === "error" && s.includes("AskAntigravity error")),
	).toBe(true);
});
