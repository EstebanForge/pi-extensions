import { spawn } from "node:child_process";

/**
 * Common peer-process lifecycle for the ask-* extensions and pi-unblock,
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
	/** Hands over the kill switch before any terminal event can fire, so
	 *  the background registry can stop the run on session shutdown. */
	onSpawn?: (killTree: () => void) => void;
	/** Max stderr chars retained; further chunks are dropped. */
	stderrCapChars?: number;
	lineBufMaxChars?: number;
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

export function runProcess(opts: RunProcessOptions): Promise<RunProcessOutcome> {
	const {
		binary,
		args,
		stdin,
		cwd,
		timeoutMs,
		signal,
		onLine,
		onSpawn,
		stderrCapChars = DEFAULT_STDERR_CAP_CHARS,
		lineBufMaxChars = DEFAULT_LINE_BUF_MAX_CHARS,
	} = opts;

	let stdoutRaw = "";
	let stderrBuf = "";

	return new Promise<RunProcessOutcome>((resolveP, rejectP) => {
		const proc = spawn(binary, args, {
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

		let sigkillTimer: ReturnType<typeof setTimeout> | undefined;
		let watchdog: ReturnType<typeof setTimeout> | undefined;
		let settled = false;
		let timedOut = false;

		// Kill the whole process group; SIGTERM first, then SIGKILL after a
		// grace period. The SIGKILL timer is armed only once.
		const killTree = () => {
			try {
				if (proc.pid) process.kill(-proc.pid, "SIGTERM");
			} catch {}
			if (!sigkillTimer) {
				sigkillTimer = setTimeout(() => {
					try {
						if (proc.pid) process.kill(-proc.pid, "SIGKILL");
					} catch {}
				}, GRACE_AFTER_KILL_MS);
			}
		};

		// Hand the kill switch to the background registry before any
		// terminal event can fire.
		onSpawn?.(killTree);

		const cleanup = () => {
			if (watchdog) clearTimeout(watchdog);
			if (sigkillTimer) clearTimeout(sigkillTimer);
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
