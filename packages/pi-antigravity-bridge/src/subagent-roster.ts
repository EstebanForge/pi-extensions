// In-memory subagent roster, folded from driver activities.
//
// agy has no read-only subcommand for live subagent state, so the only
// zero-token source is the turn stream: subagent spawns arrive as ordinary
// tool steps (invoke_subagent, run_subagent, define_subagent,
// browser_subagent), send_message addresses a spawned agent, and
// manage_subagents carries lifecycle actions. The roster folds
// DriverActivity — the engine-agnostic contract both turn engines emit — so
// stream-json (stepId-keyed) and ACP (toolCallId-keyed) feed one roster.
//
// Accepted heuristic limits (telemetry only, never persisted — agy's own
// conversation database remains the durable record):
// - send_message routes to the FIRST entry with the matching agent name
//   regardless of status, so a message after a name is reused may credit a
//   stale entry.
// - manage_subagents kill marks ALL running entries killed; the target arg
//   is ignored because its shape is not stable across agy builds.
// - Parallel spawns with the same agent name are separate entries, but
//   name-based routing cannot tell them apart.

import type { DriverActivity } from "./driver-types.js";

/** Tools whose start opens a roster entry and whose done/error closes it. */
const SPAWN_TOOLS = new Set(["invoke_subagent", "run_subagent", "browser_subagent"]);
/** Tools addressed at an already-spawned agent. */
const MESSAGE_TOOLS = new Set(["send_message"]);
/** Tools carrying lifecycle actions (kill/stop/...). */
const MANAGE_TOOLS = new Set(["manage_subagents"]);

/** Arg keys that plausibly name the target agent (their casing varies). */
const NAME_ARG_KEYS = /^(name|subagent|subagent_name|agent|agent_name|type|recipient|role|to)$/i;
/** Arg keys plausibly holding a manage_subagents lifecycle action. */
const ACTION_ARG_KEYS = /^(action|command|operation|op)$/i;
const DETAIL_MAX = 120;

export interface SubagentEntry {
	/** Stable fold key: `s:<stepId>` on stream-json, `n:<seq>` on ACP. */
	key: string;
	name: string;
	status: "running" | "done" | "error" | "killed";
	spawnedAtMs: number;
	lastActivityMs: number;
	/** send_message count since spawn. */
	messages: number;
	/** First non-name string arg, truncated — usually the task text. */
	detail: string;
	error?: string;
}

function truncate(value: string): string {
	return value.length > DETAIL_MAX ? `${value.slice(0, DETAIL_MAX)}…` : value;
}

/** First string arg whose key plausibly names the agent. */
function subagentNameFromArgs(args: Record<string, unknown>): string {
	for (const [k, v] of Object.entries(args)) {
		if (NAME_ARG_KEYS.test(k) && typeof v === "string" && v.trim()) return truncate(v.trim());
	}
	return "subagent";
}

/** First string arg that is not the name — the task text, when agy passes one. */
function detailFromArgs(args: Record<string, unknown>): string {
	for (const [k, v] of Object.entries(args)) {
		if (!NAME_ARG_KEYS.test(k) && typeof v === "string" && v.trim()) return truncate(v.trim());
	}
	return "";
}

interface ExtractedSpawn {
	name: string;
	detail: string;
}

function extractSpawnsFromArgs(args: Record<string, unknown>): ExtractedSpawn[] {
	const raw = args.Subagents ?? args.subagents;
	if (Array.isArray(raw) && raw.length > 0) {
		const out: ExtractedSpawn[] = [];
		for (const item of raw) {
			if (item && typeof item === "object") {
				const rec = item as Record<string, unknown>;
				const name =
					(typeof rec.Role === "string" && rec.Role.trim()) ||
					(typeof rec.role === "string" && rec.role.trim()) ||
					(typeof rec.TypeName === "string" && rec.TypeName.trim()) ||
					(typeof rec.type_name === "string" && rec.type_name.trim()) ||
					(typeof rec.name === "string" && rec.name.trim()) ||
					"subagent";
				const detail =
					(typeof rec.Prompt === "string" && rec.Prompt.trim()) ||
					(typeof rec.prompt === "string" && rec.prompt.trim()) ||
					(typeof rec.task === "string" && rec.task.trim()) ||
					"";
				out.push({ name: truncate(name), detail: truncate(detail) });
			}
		}
		if (out.length > 0) return out;
	}
	return [{ name: subagentNameFromArgs(args), detail: detailFromArgs(args) }];
}

function manageActionIsKill(args: Record<string, unknown>): boolean {
	for (const [k, v] of Object.entries(args)) {
		if (ACTION_ARG_KEYS.test(k) && typeof v === "string" && /kill|stop|terminate|cancel/i.test(v))
			return true;
	}
	return false;
}

export class SubagentRoster {
	#entries = new Map<string, SubagentEntry>();
	#acpSeq = 0;

	/** Fold key precedence: ACP toolCallId (stable protocol id), stream-json
	 *  numeric stepId, then a process-local sequence for hypothetical engines
	 *  with neither. */
	#keyFor(activity: Extract<DriverActivity, { type: "tool_start" }>): string {
		if (activity.toolCallId !== undefined) return `t:${activity.toolCallId}`;
		if (activity.stepId !== undefined) return `s:${activity.stepId}`;
		return `n:${this.#acpSeq++}`;
	}

	#entriesFor(activity: Extract<DriverActivity, { type: "tool_done" | "tool_error" }>): SubagentEntry[] {
		const baseKey =
			activity.toolCallId !== undefined
				? `t:${activity.toolCallId}`
				: activity.stepId !== undefined
					? `s:${activity.stepId}`
					: undefined;
		if (baseKey !== undefined) {
			const matched: SubagentEntry[] = [];
			for (const [k, v] of this.#entries) {
				if (k === baseKey || k.startsWith(`${baseKey}:`)) matched.push(v);
			}
			return matched;
		}
		for (const entry of this.#entries.values()) {
			if (entry.status === "running") return [entry];
		}
		return [];
	}

	/** Fold one driver activity. Non-tool activities are ignored; unknown
	 *  tool names are other features' business. Never throws: roster
	 *  bookkeeping must not be able to fail a turn. */
	fold(activity: DriverActivity): void {
		try {
			this.#fold(activity);
		} catch {
			/* roster is best-effort telemetry */
		}
	}

	#fold(activity: DriverActivity): void {
		if (activity.type === "tool_start") {
			if (SPAWN_TOOLS.has(activity.name)) {
				const baseKey = this.#keyFor(activity);
				const spawns = extractSpawnsFromArgs(activity.args);
				const now = Date.now();
				for (let i = 0; i < spawns.length; i++) {
					const key = spawns.length === 1 ? baseKey : `${baseKey}:${i}`;
					this.#entries.set(key, {
						key,
						name: spawns[i]!.name,
						status: "running",
						spawnedAtMs: now,
						lastActivityMs: now,
						messages: 0,
						detail: spawns[i]!.detail,
					});
				}
				return;
			}
			if (MESSAGE_TOOLS.has(activity.name)) {
				const entry = this.#entryByName(subagentNameFromArgs(activity.args));
				if (entry) {
					entry.messages += 1;
					entry.lastActivityMs = Date.now();
				}
				return;
			}
			if (MANAGE_TOOLS.has(activity.name) && manageActionIsKill(activity.args)) {
				const now = Date.now();
				for (const entry of this.#entries.values()) {
					if (entry.status === "running") {
						entry.status = "killed";
						entry.lastActivityMs = now;
					}
				}
			}
			return;
		}
		if (activity.type === "tool_done" || activity.type === "tool_error") {
			const entries = this.#entriesFor(activity);
			if (entries.length === 0) return;
			const now = Date.now();
			for (const entry of entries) {
				entry.lastActivityMs = now;
				if (activity.type === "tool_error") {
					entry.status = "error";
					entry.error = truncate(activity.message);
				} else if (entry.status === "running") {
					entry.status = "done";
				}
			}
		}
	}

	#entryByName(name: string, ...statuses: SubagentEntry["status"][]): SubagentEntry | undefined {
		for (const entry of this.#entries.values()) {
			if (entry.name === name && (statuses.length === 0 || statuses.includes(entry.status)))
				return entry;
		}
		return undefined;
	}

	/** Entries in spawn order (Map preserves insertion). */
	snapshot(): SubagentEntry[] {
		return [...this.#entries.values()];
	}

	/** Live wire for status surfaces. */
	runningCount(): number {
		let n = 0;
		for (const entry of this.#entries.values()) if (entry.status === "running") n += 1;
		return n;
	}
}

export function formatSubagentRoster(entries: SubagentEntry[]): string {
	const running = entries.filter((e) => e.status === "running").length;
	const lines = [`antigravity subagents: ${entries.length} tracked, ${running} running`];
	for (const entry of entries) {
		const secs = Math.max(0, Math.round((Date.now() - entry.spawnedAtMs) / 1000));
		const dur = secs >= 60 ? `${Math.floor(secs / 60)}m${String(secs % 60).padStart(2, "0")}s` : `${secs}s`;
		const parts = [
			`${entry.name} · ${entry.status} · ${dur}`,
			entry.messages > 0 ? `${entry.messages} msg` : undefined,
			entry.detail || undefined,
			entry.error ? `error: ${entry.error}` : undefined,
		].filter((p): p is string => p !== undefined);
		lines.push(`- ${parts.join(" · ")}`);
	}
	return lines.join("\n");
}
