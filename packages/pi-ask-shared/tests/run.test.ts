import path from "node:path";
import { describe, expect, it } from "vitest";
import { runProcess, RunSpawnError } from "../src/run.js";

// Characterization suite for the shared peer-process lifecycle, extracted
// from runClaudeProcess / runCodexProcess / runAgyProcess. Locks the
// agy-mandated gates: settle on stream close (never exit), stdin transport
// (never argv), EPIPE tolerance, timeout/abort kill-tree behavior, and
// buffer caps. Real child processes throughout — no spawn mocks.

const FIXTURE = path.join(import.meta.dirname, "fixtures", "peer-fake.mjs");

function peer(mode: string, arg?: string | number): { binary: string; args: string[] } {
	const args = [FIXTURE, mode];
	if (arg !== undefined) args.push(String(arg));
	return { binary: process.execPath, args };
}

const line = (buf: string[]) => (l: string) => buf.push(l);

describe("runProcess — line mode", () => {
	it("delivers every line even when the child exits with pending stdout data", async () => {
		// The close-vs-exit gate: 50k lines written then immediate exit().
		// Settling on `exit` would truncate; `close` must drain the pipe.
		const seen: string[] = [];
		const out = await runProcess({ ...peer("lines", 50_000), timeoutMs: 30_000, onLine: line(seen) });
		expect(out.exitCode).toBe(0);
		expect(seen.length).toBe(50_000);
		expect(seen[0]).toBe("line-1");
		expect(seen.at(-1)).toBe("line-50000");
	});

	it("flushes a trailing line missing its newline at close", async () => {
		const seen: string[] = [];
		const out = await runProcess({ ...peer("stream-delay"), timeoutMs: 10_000, onLine: line(seen) });
		expect(out.exitCode).toBe(0);
		expect(seen).toEqual(["early", "trailing-no-newline"]);
	});

	it("does not retain raw stdout in line mode", async () => {
		const out = await runProcess({ ...peer("lines", 3), timeoutMs: 10_000, onLine: line([]) });
		expect(out.stdoutRaw).toBe("");
	});

	it("keeps only the valve tail of a pathological single line", async () => {
		const seen: string[] = [];
		const out = await runProcess({ ...peer("big-line", 1_100_000), timeoutMs: 30_000, onLine: line(seen) });
		expect(out.exitCode).toBe(0);
		// Single flushed line, truncated well below the 1.1MB payload, tail kept.
		expect(seen.length).toBe(1);
		expect(seen[0].length).toBeLessThan(1_100_000);
		expect(seen[0].endsWith("x")).toBe(true);
	});
});

describe("runProcess — raw mode", () => {
	it("accumulates full stdout when no onLine handler is given", async () => {
		const out = await runProcess({ ...peer("raw"), timeoutMs: 10_000 });
		expect(out.stdoutRaw).toBe("raw output continues");
	});

	it("streams chunks live via onChunk before close", async () => {
		// The raw-peer status-tail contract: chunks arrive while the child
		// is still running, not only at close.
		const chunks: string[] = [];
		const out = await runProcess({ ...peer("raw"), timeoutMs: 10_000, onChunk: (c) => chunks.push(c) });
		expect(chunks.length).toBeGreaterThan(0);
		expect(chunks.join("")).toBe("raw output continues");
		expect(out.stdoutRaw).toBe("raw output continues");
	});
});

describe("runProcess — stdin transport", () => {
	it("delivers a 250KB prompt via stdin, never via argv", async () => {
		const seen: string[] = [];
		const { binary, args } = peer("stdin-echo");
		expect(args.length).toBe(2); // prompt never travels as an argument
		const out = await runProcess({ binary, args, stdin: "y".repeat(250_000), timeoutMs: 10_000, onLine: line(seen) });
		expect(seen).toEqual(["GOT:250000"]);
		expect(out.exitCode).toBe(0);
	});

	it("ignores EPIPE when the child exits without reading stdin", async () => {
		const out = await runProcess({ ...peer("stdin-no-read"), stdin: "unused prompt", timeoutMs: 10_000 });
		expect(out.exitCode).toBe(0);
	});
});

describe("runProcess — lifecycle", () => {
	it("reports genuine non-zero exit codes", async () => {
		const out = await runProcess({ ...peer("exit-code", 3), timeoutMs: 10_000 });
		expect(out.exitCode).toBe(3);
		expect(out.timedOut).toBe(false);
		expect(out.aborted).toBe(false);
	});

	it("kills the tree on timeout and reports timedOut", async () => {
		const out = await runProcess({ ...peer("hang", 10_000), timeoutMs: 200 });
		expect(out.timedOut).toBe(true);
		expect(out.aborted).toBe(false);
	});

	it("kills the tree on abort and reports aborted", async () => {
		const controller = new AbortController();
		setTimeout(() => controller.abort(), 30);
		const out = await runProcess({ ...peer("hang", 10_000), timeoutMs: 30_000, signal: controller.signal });
		expect(out.aborted).toBe(true);
	});

	it("kills immediately on an already-aborted signal", async () => {
		const controller = new AbortController();
		controller.abort();
		const out = await runProcess({ ...peer("hang", 10_000), timeoutMs: 30_000, signal: controller.signal });
		expect(out.aborted).toBe(true);
	});

	it("hands the kill switch to onSpawn and honors it", async () => {
		let killTree: (() => void) | undefined;
		const run = runProcess({
			...peer("hang", 10_000),
			timeoutMs: 30_000,
			onSpawn: (k) => {
				killTree = k;
			},
		});
		await new Promise((r) => setTimeout(r, 100));
		expect(killTree).toBeTypeOf("function");
		killTree!();
		const out = await run;
		expect(out.timedOut).toBe(false);
	});

	it("caps stderr accumulation below the flood size", async () => {
		const out = await runProcess({ ...peer("stderr-flood"), timeoutMs: 10_000 });
		expect(out.stderr.length).toBeGreaterThan(0);
		expect(out.stderr.length).toBeLessThan(100_000);
	});

	it("rejects with RunSpawnError for a missing binary", async () => {
		await expect(
			runProcess({ binary: "/nonexistent/peer-binary-xyz", args: [], timeoutMs: 10_000 }),
		).rejects.toBeInstanceOf(RunSpawnError);
	});
});
