// Pure policy core for pi-unblock: failure-streak tracking, consult gating,
// and publish-boundary detection. Zero I/O by design (house style): the
// extension entrypoint feeds it tool-call events and acts on the decisions.
//
// Two rules shape the streak semantics:
// - (tool, command-root) keying: pi's exec is ONE tool, so unrelated failing
//   commands must not stack as consecutive failures.
// - Exploratory commands (grep/rg/find/...) are transparent: they exit 1 on
//   no-match as a normal result and must never build a failure streak.
// - One-turn decay: a streak that did not repeat within the next turn dies.

/** Command roots that never count toward a failure streak. Extensible via
 *  settings.ignoredCommands (merged with these). */
export const DEFAULT_IGNORED_COMMANDS: readonly string[] = [
	"grep",
	"rg",
	"find",
	"which",
	"ls",
	"cat",
	"head",
	"tail",
	"diff",
	"wc",
	"sort",
	"uniq",
];

/** First meaningful token of a shell command: environment assignments are
 *  skipped, surrounding quotes and paths are stripped. */
export function commandRoot(command: string): string | null {
	for (const rawToken of command.trim().split(/\s+/)) {
		if (!rawToken) continue;
		if (/^[A-Za-z_][A-Za-z0-9_]*=/.test(rawToken)) continue;
		const stripped = rawToken.replace(/^["']|["']$/g, "");
		const base = stripped.split("/").pop() ?? stripped;
		return base || null;
	}
	return null;
}

export interface ToolObservation {
	tool: string;
	ok: boolean;
	/** Session turn index; drives one-turn decay. */
	turn: number;
	/** Raw command string; required for exec-keyed observations. */
	command?: string;
}

export interface FailureStreak {
	key: string;
	count: number;
	lastTurn: number;
}

export interface UnblockState {
	streak: FailureStreak | null;
	consultsUsed: number;
	/** Epoch ms of the last consult start; anchors the cooldown. */
	lastConsultAtMs: number | null;
	consultInFlight: boolean;
}

export function newUnblockState(): UnblockState {
	return { streak: null, consultsUsed: 0, lastConsultAtMs: null, consultInFlight: false };
}

export interface StreakGates {
	threshold: number;
	maxAutoConsults?: number;
	ignoredCommands?: readonly string[];
}

export interface TriggerDecision {
	trigger: boolean;
	key: string;
	count: number;
	/** Machine-readable why-not, for logging and tests. "below-threshold"
	 *  doubles as the why-yes when trigger is true. */
	blockedBy:
		| "below-threshold"
		| "past-threshold"
		| "in-flight"
		| "budget"
		| "ignored"
		| "reset";
}

function isIgnored(tool: string, command: string | undefined, extra: readonly string[]): boolean {
	if (tool !== "exec" || command === undefined) return false;
	const root = commandRoot(command);
	if (root === null) return true;
	return [...DEFAULT_IGNORED_COMMANDS, ...extra].includes(root);
}

/** Record one tool result and decide whether the failure loop warrants a
 *  consult. Triggers exactly once per streak (at count === threshold); the
 *  streak is consumed by noteConsultSettled regardless of consult outcome. */
export function noteToolResult(
	state: UnblockState,
	o: ToolObservation,
	gates: StreakGates,
): TriggerDecision {
	const key =
		o.tool === "exec" ? `exec:${commandRoot(o.command ?? "") ?? "unknown"}` : o.tool;

	if (isIgnored(o.tool, o.command, gates.ignoredCommands ?? [])) {
		return { trigger: false, key, count: state.streak?.count ?? 0, blockedBy: "ignored" };
	}

	if (o.ok) {
		// Same-key success breaks the loop; unrelated successes don't.
		if (state.streak?.key === key) state.streak = null;
		return { trigger: false, key, count: 0, blockedBy: "reset" };
	}

	let streak = state.streak;
	if (streak === null || streak.key !== key) {
		streak = { key, count: 0, lastTurn: o.turn };
		state.streak = streak;
	} else if (o.turn > streak.lastTurn + 1) {
		// One-turn decay: the loop did not persist across the boundary.
		streak.count = 0;
	}
	streak.count += 1;
	streak.lastTurn = o.turn;

	if (streak.count !== gates.threshold) {
		return {
			trigger: false,
			key,
			count: streak.count,
			blockedBy: streak.count > gates.threshold ? "past-threshold" : "below-threshold",
		};
	}
	if (state.consultInFlight) {
		// The gate swallowed this streak's one shot (the in-flight settle may
		// carry a different key), so drop it: a fresh streak can re-trigger
		// once the gate opens instead of wedging past the threshold forever.
		state.streak = null;
		return { trigger: false, key, count: streak.count, blockedBy: "in-flight" };
	}
	if (state.consultsUsed >= (gates.maxAutoConsults ?? 3)) {
		return { trigger: false, key, count: streak.count, blockedBy: "budget" };
	}
	return { trigger: true, key, count: streak.count, blockedBy: "below-threshold" };
}

/** Try to start a consult: consumes one unit of the session budget and
 *  anchors the cooldown. Failed consults deliberately consume both — the
 *  gate must not retry-storm a broken reviewer CLI. */
export function noteConsultStarted(
	state: UnblockState,
	nowMs: number,
	opts: { cooldownSec?: number; maxAutoConsults?: number; spend?: boolean } = {},
): { started: boolean; blockedBy?: "in-flight" | "budget" | "cooldown" } {
	const cooldownSec = opts.cooldownSec ?? 120;
	const maxAutoConsults = opts.maxAutoConsults ?? 3;
	if (state.consultInFlight) return { started: false, blockedBy: "in-flight" };
	if (state.consultsUsed >= maxAutoConsults) return { started: false, blockedBy: "budget" };
	if (state.lastConsultAtMs !== null && nowMs - state.lastConsultAtMs < cooldownSec * 1000) {
		return { started: false, blockedBy: "cooldown" };
	}
	state.consultInFlight = true;
	// spend: false (publish boundary, /unblock) runs outside the auto budget:
	// no consultsUsed increment, no cooldown anchor, so human-ordered consults
	// never starve the automatic failure-loop gate.
	const spend = opts.spend ?? true;
	if (spend) {
		state.consultsUsed += 1;
		state.lastConsultAtMs = nowMs;
	}
	return { started: true };
}

/** Settle an in-flight consult. With a key: consumes only the matching
 *  failure streak (a publish or manual consult settling must not wipe a
 *  concurrent failure loop's count). Without: clears any streak.
 *  Always clears the in-flight flag. */
export function noteConsultSettled(state: UnblockState, key?: string): void {
	state.consultInFlight = false;
	if (key === undefined || state.streak?.key === key) state.streak = null;
}

/** Drop the current failure streak without touching the in-flight flag.
 *  Used when a trigger is suppressed (cooldown/budget): the streak starts
 *  over instead of wedging past the threshold forever. */
export function resetStreak(state: UnblockState): void {
	state.streak = null;
}

// --- Publish boundary -------------------------------------------------------

const COMMAND_WRAPPERS = new Set(["sudo", "env", "command", "nohup", "stdbuf", "time"]);

/** Resolve the segment's binary name: skip environment assignments and known
 *  wrapper commands (sudo/env/command/...), then strip any path prefix. */
function segmentBinary(tokens: string[]): string | null {
	let i = 0;
	while (i < tokens.length && /^[A-Za-z_][A-Za-z0-9_]*=/.test(tokens[i] ?? "")) i++;
	while (i < tokens.length && COMMAND_WRAPPERS.has(tokens[i] ?? "")) {
		i++;
		while (i < tokens.length && /^[A-Za-z_][A-Za-z0-9_]*=/.test(tokens[i] ?? "")) i++;
	}
	const bin = tokens[i];
	if (!bin) return null;
	return bin.includes("/") ? (bin.split("/").pop() ?? bin) : bin;
}

/** Split a command line into shell segments on ; && || | & and newlines,
 *  then tokenize each segment with quote-aware splitting (so FOO="a b"
 *  stays one assignment token and quoted payloads do not leak tokens). */
function shellSegments(command: string): string[][] {
	return command
		.split(/\s*(?:&&|\|\||;|\||&|\n)\s*/)
		.map((seg) => tokenizeSegment(seg.trim()))
		.filter((tokens) => tokens.length > 0);
}

function tokenizeSegment(segment: string): string[] {
	const tokens: string[] = [];
	let cur = "";
	let started = false;
	let quote: string | null = null;
	for (let i = 0; i < segment.length; i++) {
		const ch = segment[i];
		if (quote) {
			if (ch === quote) quote = null;
			else cur += ch;
			started = true;
			continue;
		}
		if (ch === '"' || ch === "'") {
			quote = ch;
			started = true;
			continue;
		}
		if (ch === "\\" && i + 1 < segment.length) {
			cur += segment[i + 1];
			i++;
			started = true;
			continue;
		}
		if (/\s/.test(ch)) {
			if (started) {
				tokens.push(cur);
				cur = "";
				started = false;
			}
			continue;
		}
		cur += ch;
		started = true;
	}
	if (started) tokens.push(cur);
	return tokens;
}

/** True when the command line publishes: any `git ... push` or
 *  `gh ... pr create` invocation, including behind flags (git -C repo push),
 *  wrappers (sudo/env/command), absolute paths, environment assignments, and
 *  inside compound commands. Tokenized: the publish token must follow the
 *  segment's resolved git/gh binary, so `echo git push` does not gate.
 *  Residual gaps (documented): quoted re-execution like bash -c 'git push'
 *  and wrapper argument forms (nice -n 5 git push). */
export function isPublishCommand(command: string): boolean {
	if (!command.trim()) return false;
	for (const tokens of shellSegments(command)) {
		const bin = segmentBinary(tokens);
		if (bin === "git" && tokens.includes("push")) return true;
		if (bin === "gh") {
			const idx = tokens.indexOf("pr");
			if (idx !== -1 && tokens[idx + 1] === "create") return true;
		}
	}
	return false;
}

