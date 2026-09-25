// Regression: exit 0 with EMPTY stdout must not read as a silent success.
// Headless agy auto-denies a permission-gated tool call (e.g. the command
// gate in plan mode — the flag is withheld there since the plan-mode fix),
// prints the reason only to stderr, and ends cleanly. The tool used to fall
// through to the success path and return just the conversation footer, which
// the caller read as "returned only a conversationId, zero output, no error"
// (silent-failure bug found 2026-09-25, peer handoff).
//
// Seam: AGY_BIN pointed at a fake binary that exits 0 with empty stdout and
// the real jetski stderr message. HOME is pointed at an empty tmpdir so the
// bridge-deferral scan finds nothing and the factory actually registers the
// tool (on a machine with the bridge installed, the factory defers).
//
// Run: npm test

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { expect, test } from "vitest";
import factory from "../extensions/index.js";

type ToolResult = { content: Array<{ type: string; text: string }> };

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

async function registerAndRun(bin: string): Promise<string> {
	const realHome = process.env.HOME;
	const realBin = process.env.AGY_BIN;
	const emptyHome = fs.mkdtempSync(path.join(os.tmpdir(), "agy-home-"));
	process.env.HOME = emptyHome;
	process.env.AGY_BIN = bin;
	try {
		const tools: Array<{
			name: string;
			execute: (
				id: string,
				params: Record<string, unknown>,
				signal?: unknown,
				onUpdate?: unknown,
				ctx?: Record<string, unknown>,
			) => Promise<ToolResult>;
		}> = [];
		const pi = new Proxy(
			{
				registerTool: (tool: (typeof tools)[number]) => tools.push(tool),
			} as Record<string | symbol, unknown>,
			{
				get(target, prop: string | symbol) {
					return prop in target ? target[prop] : () => {};
				},
			},
		);
		await factory(pi as never);
		// Empty HOME: no bridge package.json on the scan paths, no bridge
		// Symbol flag -> the factory must register the tool here.
		expect(tools.map((t) => t.name)).toContain("AskAntigravity");

		// mode plan mirrors the reported failure: the skip-permissions flag is
		// withheld there, so permission gates bite (the fake ignores args).
		const res = await tools[0].execute(
			"t1",
			{ prompt: "review", cwd: process.cwd(), timeoutMinutes: 1, mode: "plan" },
			undefined,
			undefined,
			{},
		);
		return res.content[0].text;
	} finally {
		if (realHome === undefined) delete process.env.HOME;
		else process.env.HOME = realHome;
		if (realBin === undefined) delete process.env.AGY_BIN;
		else process.env.AGY_BIN = realBin;
		fs.rmSync(emptyHome, { recursive: true, force: true });
	}
}

test(
	"exit 0 with empty stdout surfaces the stderr denial, not a silent success",
	{ timeout: 20_000 },
	async () => {
		const bin = makeFakeAgyBin(DENIED_STDERR);
		try {
			const text = await registerAndRun(bin);

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
			const text = await registerAndRun(bin);

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
