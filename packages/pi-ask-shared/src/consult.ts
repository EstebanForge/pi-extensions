// Consult core: one call per peer that composes the shared argv builders,
// runProcess lifecycle, and stream-event parsers into a plain
// {answer, sessionId} result. Consumers (pi-unblock, future review gates)
// resolve their own CLI binary; this module owns the peer protocol only.
//
// Contract notes:
// - Prompts travel where each CLI expects them: claude via stdin (variadic
//   flags would swallow a positional), codex as the trailing `--` positional,
//   agy as the trailing -p positional.
// - Every returned/errored answer is ANSI-stripped (reviewer output goes into
//   transcripts; terminal control sequences have no business there).
// - Failures are thrown as ConsultError with the reason classed, so callers
//   can degrade (e.g. headless notify-only) without string-matching.
// - Session handles: claude captures init first-writer-wins, codex echoes
//   thread.started latest-wins, agy prints no id (discovery stays an
//   extension concern), so agy consults return null.
import {
	buildAgyArgs,
	buildClaudeArgs,
	buildCodexArgs,
	buildTimeBudgetNotice,
	buildFinalPrompt,
	consumeClaudeEvent,
	consumeCodexEvent,
	emptyClaudeEventState,
	emptyCodexEventState,
	type Mode,
	type ResolvedModel,
	type SandboxMode,
} from "./index.js";
import { MAX_TIMEOUT_MS, RunSpawnError, runProcess, type RunProcessOutcome } from "./run.js";

export type ConsultPeer = "claude" | "codex" | "agy";

export type ConsultFailureReason =
	| "invalid-options"
	| "empty-answer"
	/** The peer ran but reported an error result (e.g. claude is_error). */
	| "peer-error"
	| "nonzero-exit"
	| "timeout"
	| "aborted"
	| "spawn";

export class ConsultError extends Error {
	readonly reason: ConsultFailureReason;
	readonly exitCode: number | null;
	readonly stderr: string;
	/** Whatever the peer produced before failing (sanitized, diagnostics only). */
	readonly answer: string;
	readonly sessionId: string | null;

	constructor(
		reason: ConsultFailureReason,
		details: {
			exitCode?: number | null;
			stderr?: string;
			answer?: string;
			sessionId?: string | null;
			message?: string;
		} = {},
	) {
		super(details.message ?? `consult failed: ${reason}`);
		this.name = "ConsultError";
		this.reason = reason;
		this.exitCode = details.exitCode ?? null;
		this.stderr = details.stderr ?? "";
		this.answer = details.answer ?? "";
		this.sessionId = details.sessionId ?? null;
	}
}

export interface ConsultOptions {
	peer: ConsultPeer;
	/** Executable. Consumers pass process.execPath + a script path, or the
	 *  peer CLI's absolute path; PATH lookup is the consumer's call. */
	binary: string;
	/** Leading arguments (typically just the script path / subcommand). */
	args: string[];
	prompt: string;
	timeoutMs: number;
	signal?: AbortSignal;
	cwd?: string;
	/** claude: --model. codex: -m (null keeps codex's own default). agy: the
	 *  resolved --model slug when no agy.resolved is given. */
	model?: string | null;
	claude?: {
		effort?: string;
		mode?: "read" | "none" | "full";
		allowFullMode?: boolean;
		/** Valid UUID resumes that session; invalid ids spawn fresh (same rule
		 *  as the ask extension). */
		sessionId?: string;
		extraArgs?: string[];
	};
	codex?: {
		reasoning?: string;
		sandbox?: SandboxMode;
		addDir?: string | null;
		sessionId?: string;
		extraArgs?: string[];
	};
	agy?: {
		mode?: Mode;
		extraArgs?: string[];
		addDirs?: string[];
		conversationId?: string | null;
		/** Consults default to false: a headless review never needs command
		 *  execution, and the flag cannot be trusted under plan mode. */
		skipPermissions?: boolean;
		/** Full resolved model (slug + effort tier); overrides `model`. */
		resolved?: ResolvedModel;
	};
}

export interface ConsultResult {
	/** Sanitized peer answer (ANSI-stripped, trimmed). */
	answer: string;
	/** claude session id / codex thread id; agy prints none, so null. */
	sessionId: string | null;
	exitCode: number;
	timedOut: boolean;
	aborted: boolean;
}

// Escape-sequence stripping, hardest first. CSI covers colon parameters and
// intermediate bytes; the 8-bit C1 form (0x9b) is an equal-introducer; OSC and
// DCS/SOS/PM/APC get terminated and unterminated variants (an unterminated
// string eats up to the next escape so nothing after it survives live).
// Applied repeatedly to a fixed point: nested sequences like ESC [ ESC [ 0 m
// reassemble into a live escape after a single pass.
const ESCAPE_PATTERNS: RegExp[] = [
	/\x1b\[[0-9:;<=>?]*[!-/]*[@-~]/g,
	/\x9b[0-9:;<=>?]*[!-/]*[@-~]/g,
	/\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)/g,
	/\x1b\][^\x07\x1b]*/g,
	/\x1b[PX^_][\s\S]*?(?:\x1b\\|\x9c)/g,
	/\x1b[PX^_][\s\S]*$/g,
	/\x07/g,
];

/** Strip terminal control sequences (CSI SGR/cursor incl. colon parameters and
 *  the 8-bit C1 form, OSC titles incl. unterminated, DCS strings), normalize
 *  CRLF, and trim. Applied to every consult answer before it can reach a
 *  transcript; iterated to a fixed point so obfuscated/nested sequences cannot
 *  reassemble into live escapes. */
export function sanitizeReviewerOutput(text: string): string {
	let out = text;
	for (let i = 0; i < 8; i++) {
		const next = ESCAPE_PATTERNS.reduce((acc, re) => acc.replace(re, ""), out);
		if (next === out) break;
		out = next;
	}
	// Terminal backstop: no escape or C1 introducer survives sanitization.
	return out
		.replace(/[\x1b\x9b]/g, "")
		.replace(/\r\n?/g, "\n")
		.trim();
}

/** Per-peer setup extracted from the options: argv, prompt transport, and the
 *  answer/session extraction over the parsed event state. */
function peerSetup(opts: ConsultOptions): {
	args: string[];
	stdin?: string;
	onLine?: (line: string) => void;
	extract: (outcome: RunProcessOutcome) => { answer: string; sessionId: string | null; peerError: boolean };
} {
	const { peer } = opts;
	// Peer agents never see the deadline value; give them the budget so they
	// can pace toward a complete answer instead of dying mid-task.
	const budget = buildTimeBudgetNotice(opts.timeoutMs);
	const prompt = budget ? `${opts.prompt}\n\n${budget}` : opts.prompt;
	if (peer === "claude") {
		const c = opts.claude ?? {};
		const state = emptyClaudeEventState();
		return {
			args: [
				...opts.args,
				...buildClaudeArgs({
					model: opts.model ?? undefined,
					effort: c.effort ?? "default",
					mode: c.mode ?? "read",
					allowFullMode: c.allowFullMode ?? false,
					sessionId: c.sessionId,
					extraArgs: c.extraArgs ?? [],
				}),
			],
			// Variadic flags ahead of the prompt force the stdin transport.
			stdin: prompt,
			onLine: (line) => {
				try {
					consumeClaudeEvent(JSON.parse(line) as never, state);
				} catch {
					// Non-JSON lines are progress noise; the result event carries
					// the answer.
				}
			},
			extract: () => ({
				answer: state.finalMessage || state.assistantText,
				sessionId: state.sessionId,
				peerError: state.resultIsError,
			}),
		};
	}
	if (peer === "codex") {
		const c = opts.codex ?? {};
		const state = emptyCodexEventState();
		return {
			args: [
				...opts.args,
				...buildCodexArgs({
					model: opts.model ?? null,
					reasoning: c.reasoning ?? "medium",
					sandbox: c.sandbox ?? "read-only",
					cwd: opts.cwd ?? process.cwd(),
					addDir: c.addDir ?? null,
					sessionId: c.sessionId,
					extraArgs: c.extraArgs ?? [],
					// The prompt is the trailing positional after `--`; codex's
					// stdio is ignore, so nothing blocks on stdin.
					prompt,
				}),
			],
			onLine: (line) => {
				try {
					consumeCodexEvent(JSON.parse(line) as never, state);
				} catch {
					// Non-JSON progress lines only.
				}
			},
			extract: () => ({
				answer: state.finalMessage,
				sessionId: state.sessionId,
				peerError: false,
			}),
		};
	}
	// agy: raw stdout transport. Plan is the default consult mode (read-only
	// posture; the headless guard is appended by buildFinalPrompt and the
	// fail-closed env filter lives inside buildAgyArgs).
	const a = opts.agy ?? {};
	const mode: Mode = a.mode ?? "plan";
	const resolved: ResolvedModel =
		a.resolved ?? { model: opts.model ?? "", effort: undefined };
	return {
		args: [
			...opts.args,
			...buildAgyArgs({
				cwd: opts.cwd ?? process.cwd(),
				resolved,
				mode,
				reviewerAgentName: null,
				skipPermissions: a.skipPermissions ?? false,
				conversationId: a.conversationId ?? null,
				timeoutMinutes: Math.max(1, Math.ceil(opts.timeoutMs / 60_000)),
				addDirs: a.addDirs ?? [],
				extraArgs: a.extraArgs ?? [],
				prompt: buildFinalPrompt(prompt, mode, false, false),
			}),
		],
		extract: (outcome) => ({
			answer: outcome.stdoutRaw,
			sessionId: null,
			peerError: false,
		}),
	};
}

export async function runConsult(opts: ConsultOptions): Promise<ConsultResult> {
	const { binary, timeoutMs, signal, cwd } = opts;
	if (!(typeof timeoutMs === "number" && Number.isFinite(timeoutMs) && timeoutMs > 0 && timeoutMs <= MAX_TIMEOUT_MS)) {
		// runProcess's watchdog clamps non-positive (and 2^31ms-plus) setTimeout
		// values to 1ms, which would kill the peer instantly.
		throw new ConsultError("invalid-options", {
			message: `consult timeoutMs must be a positive finite number up to ${MAX_TIMEOUT_MS}, got ${timeoutMs}`,
		});
	}

	let outcome: RunProcessOutcome;
	let setup: ReturnType<typeof peerSetup>;
	try {
		// peerSetup is inside the guard too: a malformed options shape must
		// surface as ConsultError, never as a raw throw into the caller.
		setup = peerSetup(opts);
		outcome = await runProcess({
			binary,
			args: setup.args,
			stdin: setup.stdin,
			cwd,
			timeoutMs,
			signal,
			onLine: setup.onLine,
		});
	} catch (err) {
		if (err instanceof ConsultError) throw err;
		if (err instanceof RunSpawnError) {
			throw new ConsultError("spawn", { stderr: err.stderr, message: err.message });
		}
		// Anything else (bad options, spawn validation) also means the run
		// never produced output: class it as spawn.
		throw new ConsultError("spawn", {
			message: err instanceof Error ? err.message : String(err),
		});
	}

	const { answer, sessionId, peerError } = setup.extract(outcome);
	const partial = sanitizeReviewerOutput(answer);

	if (outcome.aborted) {
		throw new ConsultError("aborted", {
			answer: partial,
			sessionId,
			stderr: outcome.stderr,
		});
	}
	if (outcome.timedOut) {
		throw new ConsultError("timeout", {
			answer: partial,
			sessionId,
			stderr: outcome.stderr,
		});
	}
	if (peerError) {
		throw new ConsultError("peer-error", {
			exitCode: outcome.exitCode,
			answer: partial,
			sessionId,
			stderr: outcome.stderr,
			message: "reviewer reported an error result",
		});
	}
	if (outcome.exitCode !== 0) {
		throw new ConsultError("nonzero-exit", {
			exitCode: outcome.exitCode,
			answer: partial,
			sessionId,
			stderr: outcome.stderr,
		});
	}
	if (!partial) {
		throw new ConsultError("empty-answer", {
			exitCode: outcome.exitCode,
			sessionId,
			stderr: outcome.stderr,
		});
	}

	return {
		answer: partial,
		sessionId,
		exitCode: outcome.exitCode,
		timedOut: false,
		aborted: false,
	};
}
