import { spawn, type ChildProcess } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

/**
 * Common peer-process lifecycle for the ask-* extensions and pi-peer-review,
 * extracted verbatim from runClaudeProcess / runCodexProcess / runAgyProcess.
 * Zero domain knowledge: no prompts, no model families, no session semantics.
 * Peer adapters map {model, prompt} to argv and own all output parsing; this
 * module owns process mechanics only.
 *
 * Settles on stream `close`, never on process `exit`: buffered stdout
 * flushes at close, and settling early would truncate trailing output.
 * Spawned detached so the whole process group can be signalled (peers spawn
 * their own subprocesses; a direct kill would orphan grandchildren).
 */

export const GRACE_AFTER_KILL_MS = 5000;
export const DEFAULT_STDERR_CAP_CHARS = 64_000;
/** Safety valve for pathological no-newline output; keeps the tail. */
export const DEFAULT_LINE_BUF_MAX_CHARS = 1_000_000;

export interface RunProcessOptions {
	binary: string;
	args: string[];
	/** Written to stdin then ended. Presence switches stdin to "pipe";
	 *  absence leaves it "ignore". Large payloads must travel here, never
	 *  in argv (E2BIG). */
	stdin?: string;
	cwd?: string;
	/** Hard ceiling; expiry kills the process group. */
	timeoutMs: number;
	signal?: AbortSignal;
	/** Newline-delimited output handler (JSONL peers). When set, stdout is
	 *  line-split, a trailing partial line is flushed at close, and raw
	 *  stdout is not retained. When absent, stdout accumulates into
	 *  `stdoutRaw` (plain-text peers). */
	onLine?: (line: string) => void;
	/** Raw stdout chunk stream, delivered as bytes arrive (both modes).
	 *  Raw-mode peers use this for live status tails without waiting for
	 *  close; line-mode peers can ignore it. */
	onChunk?: (chunk: string) => void;
	/** Hands over the kill switch plus the live child handle before any
	 *  terminal event can fire, so the background registry can stop the run
	 *  on session shutdown and raw peers can poll process state (pid,
	 *  exitCode) while the tree is alive. */
	onSpawn?: (killTree: () => void, proc: ChildProcess) => void;
	/** Max stderr chars retained; further chunks are dropped. */
	stderrCapChars?: number;
	lineBufMaxChars?: number;
	/** Injectable for tests; defaults to process.env. */
	env?: NodeJS.ProcessEnv;
	/** Injectable for tests; defaults to process.platform. */
	platform?: NodeJS.Platform;
}

export interface RunProcessOutcome {
	exitCode: number;
	aborted: boolean;
	timedOut: boolean;
	stderr: string;
	/** Raw stdout in raw mode (no onLine handler); empty in line mode. */
	stdoutRaw: string;
}

/** Spawn-level failure (binary missing, permissions). Carries whatever
 *  stderr was captured for diagnostics. */
export class RunSpawnError extends Error {
	readonly stderr: string;
	constructor(message: string, stderr: string) {
		super(message);
		this.stderr = stderr;
	}
}

/** setTimeout's hard ceiling: Node clamps anything above 2^31-1 ms to 1ms,
 * which would kill the peer instantly. */
export const MAX_TIMEOUT_MS = 2_147_483_647;
/** The same ceiling expressed in minutes for callers that think in minutes. */
export const MAX_TIMEOUT_MINUTES = Math.floor(MAX_TIMEOUT_MS / 60_000);

// --- Windows binary resolution and tree kill --------------------------------
// Windows cannot spawn npm .cmd/.bat shims without a shell (Node throws EINVAL
// since CVE-2024-27980), and routing argv through a shell would subject prompt
// text to cmd.exe %-expansion - codex takes its prompt as an argv positional.
// So: probe PATH for the native executable, refuse shims with guidance.

export type SpawnTarget =
	| { kind: "direct"; file: string }
	| { kind: "unavailable"; reason: string };

const WIN32_SPAWNABLE_SUFFIXES = [".COM", ".EXE"];

function isFile(p: string): boolean {
	try {
		return fs.statSync(p, { throwIfNoEntry: false })?.isFile() ?? false;
	} catch {
		return false;
	}
}

function shimReason(binRef: string): string {
	return (
		`"${binRef}" resolves to an npm .cmd/.bat shim. Windows cannot spawn command shells from here, ` +
		"and a shell would corrupt prompt text. Install the native executable (a real .exe) " +
		"or point the binary override environment variable at it."
	);
}

function notFoundReason(binRef: string, base: string): string {
	return `"${binRef}" not found (looked for ${base}.com and ${base}.exe on PATH).`;
}

/** Map a configured peer binary to what spawn can safely launch.
 *  POSIX passes the reference through untouched (spawn does its own PATH
 *  search). On win32 a bare name is probed against PATH with spawnable
 *  suffixes; an explicit path (any separator) is probed next to its own
 *  directory; a .cmd/.bat result is refused rather than shell-routed. */
export function resolveSpawnTarget(
	binRef: string,
	env: NodeJS.ProcessEnv = process.env,
	platform: NodeJS.Platform = process.platform,
): SpawnTarget {
	if (platform !== "win32") return { kind: "direct", file: binRef };
	const base = path.win32.basename(binRef);
	const ext = path.win32.extname(base).toLowerCase();
	if (ext === ".cmd" || ext === ".bat") return { kind: "unavailable", reason: shimReason(binRef) };
	if (binRef.includes("/") || binRef.includes("\\")) {
		if (ext === ".exe" || ext === ".com") return { kind: "direct", file: binRef };
		const dir = path.win32.dirname(binRef);
		for (const suffix of WIN32_SPAWNABLE_SUFFIXES) {
			// Host path.join, not win32.join: the fs layer decides separators
			// when we stat the candidate.
			const candidate = path.join(dir, base + suffix);
			if (isFile(candidate)) return { kind: "direct", file: candidate };
		}
		return { kind: "unavailable", reason: notFoundReason(binRef, base) };
	}
	// A bare name carrying .exe/.com must hit the real file, not name.exe.EXE:
	// probe the raw name first, then the suffixed forms.
	const names = ext ? [binRef, ...WIN32_SPAWNABLE_SUFFIXES.map((s) => binRef + s)] : WIN32_SPAWNABLE_SUFFIXES.map((s) => binRef + s);
	const searchDirs = (env.PATH ?? env.Path ?? "").split(path.win32.delimiter).filter((d) => d !== "");
	for (const dir of searchDirs) {
		for (const name of names) {
			const candidate = path.join(dir, name);
			if (isFile(candidate)) return { kind: "direct", file: candidate };
		}
	}
	return { kind: "unavailable", reason: notFoundReason(binRef, base) };
}

export type KillTreeProc = Pick<ChildProcess, "pid" | "kill">;
type SpawnFn = typeof spawn;

/** Build the kill switch for one spawned peer. POSIX signals the detached
 *  process group (SIGTERM, then SIGKILL after the grace period, armed once).
 *  Windows has no POSIX groups: process.kill(-pid) always fails there, so the
 *  tree dies via taskkill /T /F, falling back to the direct child if taskkill
 *  itself cannot run. */
export function createKillTree(
	proc: KillTreeProc,
	platform: NodeJS.Platform = process.platform,
	spawnFn: SpawnFn = spawn,
): () => void {
	if (platform === "win32") {
		return () => {
			if (!proc.pid) return;
			const fallback = () => {
				try {
					proc.kill("SIGKILL");
				} catch {}
			};
			try {
				spawnFn("taskkill", ["/pid", String(proc.pid), "/T", "/F"], { stdio: "ignore" }).on("error", fallback);
			} catch {
				fallback();
			}
		};
	}
	let sigkillArmed = false;
	return () => {
		try {
			if (proc.pid) process.kill(-proc.pid, "SIGTERM");
		} catch {}
		if (!sigkillArmed) {
			sigkillArmed = true;
			setTimeout(() => {
				try {
					if (proc.pid) process.kill(-proc.pid, "SIGKILL");
				} catch {}
			}, GRACE_AFTER_KILL_MS);
		}
	};
}

export function runProcess(opts: RunProcessOptions): Promise<RunProcessOutcome> {
	// Arm nothing on an impossible timeout: values above setTimeout's 2^31-1 ms
	// ceiling clamp to 1ms and kill the peer instantly.
	if (!(Number.isFinite(opts.timeoutMs) && opts.timeoutMs > 0 && opts.timeoutMs <= MAX_TIMEOUT_MS)) {
		throw new Error(
			`runProcess: timeoutMs must be a positive finite number up to ${MAX_TIMEOUT_MS} (got ${opts.timeoutMs})`,
		);
	}
	const {
		binary,
		args,
		stdin,
		cwd,
		timeoutMs,
		signal,
		onLine,
		onChunk,
		onSpawn,
		env = process.env,
		platform = process.platform,
		stderrCapChars = DEFAULT_STDERR_CAP_CHARS,
		lineBufMaxChars = DEFAULT_LINE_BUF_MAX_CHARS,
	} = opts;

	let stdoutRaw = "";
	let stderrBuf = "";

	return new Promise<RunProcessOutcome>((resolveP, rejectP) => {
		const target = resolveSpawnTarget(binary, env, platform);
		if (target.kind === "unavailable") {
			rejectP(new RunSpawnError(target.reason, ""));
			return;
		}
		const proc = spawn(target.file, args, {
			cwd,
			stdio: [stdin !== undefined ? "pipe" : "ignore", "pipe", "pipe"],
			shell: false,
			detached: true,
		});

		if (stdin !== undefined) {
			// Write then end so the peer proceeds immediately. Ignore EPIPE:
			// the child may exit before reading its stdin.
			proc.stdin?.on("error", () => {});
			proc.stdin?.write(stdin);
			proc.stdin?.end();
		}

		// Decode at the stream level so multibyte UTF-8 split across pipe
		// chunks doesn't corrupt (peer output is frequently non-ASCII).
		proc.stdout?.setEncoding("utf8");
		proc.stderr?.setEncoding("utf8");

		let lineBuf = "";
		proc.stdout?.on("data", (d: string) => {
			onChunk?.(d);
			if (onLine) {
				lineBuf += d;
				if (lineBuf.length > lineBufMaxChars) lineBuf = lineBuf.slice(-100_000);
				let nl: number;
				while ((nl = lineBuf.indexOf("\n")) >= 0) {
					onLine(lineBuf.slice(0, nl));
					lineBuf = lineBuf.slice(nl + 1);
				}
			} else {
				stdoutRaw += d;
				if (stdoutRaw.length > lineBufMaxChars) stdoutRaw = stdoutRaw.slice(-100_000);
			}
		});
		proc.stderr?.on("data", (d: string) => {
			if (stderrBuf.length < stderrCapChars) stderrBuf += d;
		});

		let watchdog: ReturnType<typeof setTimeout> | undefined;
		let settled = false;
		let timedOut = false;

		// Kill the whole process group; SIGTERM first, then SIGKILL after a
		// grace period. Windows routes through taskkill instead (see
		// createKillTree). The fallback timer arms only once.
		const killTree = createKillTree(proc, platform);

		// Hand the kill switch (and the live child handle) to the background
		// registry before any terminal event can fire.
		onSpawn?.(killTree, proc);

		const cleanup = () => {
			if (watchdog) clearTimeout(watchdog);
			if (signal) signal.removeEventListener("abort", onAbort);
		};

		const onAbort = () => killTree();

		// Enforce the timeout cap ourselves; never trust the peer CLI to
		// honor its own timeout flags.
		watchdog = setTimeout(() => {
			timedOut = true;
			killTree();
		}, timeoutMs);

		if (signal) {
			if (signal.aborted) killTree();
			else signal.addEventListener("abort", onAbort, { once: true });
		}

		const finish = (code: number | null) => {
			if (settled) return;
			settled = true;
			cleanup();
			// Flush any trailing line without a newline.
			if (onLine && lineBuf.trim()) onLine(lineBuf);
			resolveP({
				exitCode: code ?? 0,
				aborted: !!signal?.aborted,
				timedOut,
				stderr: stderrBuf,
				stdoutRaw,
			});
		};

		proc.on("error", (err) => {
			cleanup();
			rejectP(new RunSpawnError(err.message, stderrBuf));
		});
		proc.on("close", finish);
	});
}
