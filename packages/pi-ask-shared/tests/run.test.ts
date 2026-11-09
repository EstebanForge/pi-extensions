import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import { createKillTree, resolveSpawnTarget, runProcess, RunSpawnError } from "../src/run.js";

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

// --- Windows: binary resolution and tree kill -------------------------------
// The suite's no-mock rule bends only here: createKillTree takes a spawner by
// injection and the POSIX group-kill assertions spy on process.kill, because
// real Windows behavior cannot run on this Linux host.

function binFixture(files: string[]): { dir: string; env: NodeJS.ProcessEnv } {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ask-bin-"));
	for (const f of files) fs.writeFileSync(path.join(dir, f), "#!/bin/sh\n", { mode: 0o755 });
	return { dir, env: { PATH: dir } };
}

describe("resolveSpawnTarget — win32", () => {
	it("probes a bare name against PATH with spawnable suffixes", () => {
		const { dir, env } = binFixture(["claude.EXE"]);
		const t = resolveSpawnTarget("claude", env, "win32");
		expect(t).toEqual({ kind: "direct", file: path.join(dir, "claude.EXE") });
	});

	it("probes the raw name first when a bare binRef already carries .exe", () => {
		const { dir, env } = binFixture(["codex.exe"]);
		const t = resolveSpawnTarget("codex.exe", env, "win32");
		expect(t).toEqual({ kind: "direct", file: path.join(dir, "codex.exe") });
	});

	it("fails closed on an npm .cmd shim with guidance", () => {
		const { env } = binFixture(["codex.cmd"]);
		const t = resolveSpawnTarget("codex.cmd", env, "win32");
		expect(t.kind).toBe("unavailable");
		if (t.kind === "unavailable") expect(t.reason).toMatch(/shim/i);
	});

	it("reports not-found for a bare name with no spawnable artifact", () => {
		const { env } = binFixture([]);
		const t = resolveSpawnTarget("claude", env, "win32");
		expect(t.kind).toBe("unavailable");
		if (t.kind === "unavailable") expect(t.reason).toMatch(/claude\.com/);
	});

	it("probes spawnable suffixes next to an explicit extensionless path", () => {
		const root = fs.mkdtempSync(path.join(os.tmpdir(), "ask-explicit-"));
		// A literal 'C:\tools' directory component: valid on this Linux host,
		// and win32 path semantics treat the backslashes as separators.
		fs.mkdirSync(path.join(root, "C:\\tools"), { recursive: true });
		fs.writeFileSync(path.join(root, "C:\\tools", "claude.EXE"), "", { mode: 0o755 });
		const binRef = `${root}/C:\\tools\\claude`;
		const t = resolveSpawnTarget(binRef, { PATH: "" }, "win32");
		expect(t).toEqual({ kind: "direct", file: path.join(`${root}/C:\\tools`, "claude.EXE") });
		// POSIX stays passthrough: spawn does its own PATH search there.
		expect(resolveSpawnTarget(binRef, { PATH: "" }, "linux")).toEqual({ kind: "direct", file: binRef });
	});

	it("routes backslash binRefs to the explicit branch, not the PATH scan", () => {
		// Falsifiability twin: the fixture sits in the PATH dir under a literal
		// backslash name, so broken routing (PATH scan) would find it and pass.
		const { dir, env } = binFixture(["C:\\tools\\claude.EXE"]);
		const t = resolveSpawnTarget("C:\\tools\\claude", env, "win32");
		expect(t.kind).toBe("unavailable");
		const posix = resolveSpawnTarget("C:\\tools\\claude", env, "linux");
		expect(posix).toEqual({ kind: "direct", file: "C:\\tools\\claude" });
	});
});

describe("createKillTree", () => {
	it("on win32 kills the tree via taskkill and falls back to the child", () => {
		const calls: Array<{ cmd: string; args: string[] }> = [];
		let errCb: ((err: Error) => void) | undefined;
		const proc = { pid: 4242, kill: vi.fn() };
		const kt = createKillTree(proc, "win32", ((cmd: string, args: string[]) => {
			calls.push({ cmd, args });
			return { on: (_ev: string, cb: (err: Error) => void) => ((errCb = cb), proc) } as never;
		}) as never);
		kt();
		expect(calls).toEqual([{ cmd: "taskkill", args: ["/pid", "4242", "/T", "/F"] }]);
		errCb!(new Error("taskkill missing"));
		expect(proc.kill).toHaveBeenCalledWith("SIGKILL");
	});

	it("on posix signals the process group, arming the SIGKILL fallback once", () => {
		const killSpy = vi.spyOn(process, "kill").mockImplementation(() => true);
		vi.useFakeTimers();
		try {
			const proc = { pid: 999_999, kill: vi.fn() };
			const kt = createKillTree(proc, "linux");
			kt();
			kt();
			expect(killSpy.mock.calls.filter((c) => c[1] === "SIGTERM")).toEqual([
				[-999_999, "SIGTERM"],
				[-999_999, "SIGTERM"],
			]);
			vi.advanceTimersByTime(5_000);
			expect(killSpy.mock.calls.filter((c) => c[1] === "SIGKILL")).toEqual([[-999_999, "SIGKILL"]]);
		} finally {
			vi.useRealTimers();
			killSpy.mockRestore();
		}
	});
});

describe("runProcess — win32 gate", () => {
	it("rejects before spawning when the target is an npm shim", async () => {
		await expect(
			runProcess({ binary: "codex.cmd", args: [], timeoutMs: 1_000, platform: "win32" }),
		).rejects.toThrow(/shim/i);
	});
});
