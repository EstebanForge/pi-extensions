// Subscription quota view: `agy --print /usage --output-format json`.
//
// agy has no usage subcommand; the /usage slash command inside print mode
// returns the same structured payload the agy TUI panel shows and burns
// zero tokens (live-verified agy 1.2.10: status SUCCESS, usage all zeros,
// command.data.groups[] with window "weekly" | "5h" buckets carrying
// remaining_fraction and reset_time). Print mode answers in ~10s on this
// machine, so the spawn budget here is its own 30s, not the 8s discovery
// watchdog shared by models/agents.
//
// The quota is account-level: it reads the agy CLI's Google identity, so it
// is equally true for stream-json turns and ACP-server turns (same account)
// — but a pure-ACP install without the CLI cannot fetch it; the command
// layer fails closed with a pointer instead of a raw error.

import { spawnAgyRaw } from "./models.js";

export const USAGE_TIMEOUT_MS = 30_000;
const USAGE_CAP_BYTES = 1024 * 1024;

export interface AgyQuotaBucket {
	id?: string;
	name: string;
	/** agy's window tag: "weekly" | "5h" (tolerant of future tags). */
	window: string;
	remainingFraction: number;
	resetTime?: string;
}

export interface AgyQuotaGroup {
	name: string;
	description?: string;
	buckets: AgyQuotaBucket[];
}

export interface AgyQuotaReport {
	groups: AgyQuotaGroup[];
}

type Json = Record<string, unknown>;

const asObject = (v: unknown): Json | undefined => (v !== null && typeof v === "object" ? (v as Json) : undefined);
const asString = (v: unknown): string | undefined => (typeof v === "string" ? v : undefined);
const asNumber = (v: unknown): number | undefined => (typeof v === "number" && Number.isFinite(v) ? v : undefined);
const firstString = (o: Json, keys: string[]): string | undefined => {
	for (const k of keys) {
		const v = asString(o[k]);
		if (v !== undefined) return v;
	}
	return undefined;
};

function parseBucket(v: unknown): AgyQuotaBucket | undefined {
	const o = asObject(v);
	if (!o) return undefined;
	const remaining = asNumber(o.remaining_fraction) ?? asNumber(o.remainingFraction) ?? asNumber(o.remaining);
	const name = firstString(o, ["name", "id"]);
	if (remaining === undefined || name === undefined) return undefined;
	return {
		id: asString(o.id),
		name,
		window: firstString(o, ["window"]) ?? "unknown",
		remainingFraction: Math.max(0, Math.min(1, remaining)),
		resetTime: firstString(o, ["reset_time", "resetTime"]),
	};
}

function parseGroup(v: unknown): AgyQuotaGroup | undefined {
	const o = asObject(v);
	if (!o) return undefined;
	const name = asString(o.name);
	if (name === undefined) return undefined;
	const buckets = Array.isArray(o.buckets)
		? o.buckets.map(parseBucket).filter((b): b is AgyQuotaBucket => b !== undefined)
		: [];
	return { name, description: asString(o.description), buckets };
}

/** Parse the /usage JSON payload. Tolerant: unwraps a stream-json result
 *  envelope when present (print mode does not send one), accepts snake_case
 *  and camelCase field aliases, clamps fractions. Throws a short reason on
 *  any structural mismatch — callers render it, never stack it. */
export function parseAgyUsageJson(text: string): AgyQuotaReport {
	let payload: Json | undefined;
	try {
		payload = asObject(JSON.parse(text));
	} catch {
		throw new Error("response was not JSON");
	}
	if (!payload) throw new Error("response was not an object");
	// Print mode answers at the top level; if some future agy shells the
	// command through its stream instead, the wrapper is the same event-keyed
	// NDJSON grammar the driver already parses (see fake-agy-bin frames:
	// {"event":"init",...}), so unwrap {event:"result", result:{...}}.
	const inner = payload.event !== undefined ? asObject(payload.result) : payload;
	if (!inner) throw new Error("result envelope carried no result object");
	const status = (firstString(inner, ["status"]) ?? "").toUpperCase();
	if (status !== "" && status !== "SUCCESS" && status !== "OK") {
		throw new Error(`agy reported status ${status}`);
	}
	const command = asObject(inner.command);
	if (command === undefined || command.name !== "usage") {
		throw new Error("payload is not a /usage command result");
	}
	const data = asObject(command.data) ?? asObject(inner.data);
	const rawGroups = data !== undefined && Array.isArray(data.groups) ? data.groups : undefined;
	if (rawGroups === undefined) throw new Error("no quota groups in payload");
	const groups = rawGroups.map(parseGroup).filter((g): g is AgyQuotaGroup => g !== undefined);
	if (groups.length === 0) throw new Error("no quota groups returned");
	return { groups };
}

/** Fetch quota through the CLI. Undefined on any fetch failure (missing
 *  binary, non-zero exit, timeout, cap) — same degrade-to-empty contract as
 *  the model catalog; the caller renders the difference. The spawn watchdog
 *  runs 5s past agy's own --print-timeout so the CLI's clean timeout-exit
 *  always wins the race over our SIGKILL. */
export async function fetchAgyQuota(binary: string): Promise<AgyQuotaReport | undefined> {
	const raw = await spawnAgyRaw(
		binary,
		["--print", "/usage", "--output-format", "json", "--print-timeout", `${Math.ceil(USAGE_TIMEOUT_MS / 1000)}s`],
		USAGE_TIMEOUT_MS + 5_000,
		USAGE_CAP_BYTES,
	);
	if (raw === "") return undefined;
	try {
		return parseAgyUsageJson(raw);
	} catch {
		return undefined;
	}
}

// --- rendering ---------------------------------------------------------------

/** 20-segment remaining bar. */
export function quotaBar(fraction: number): string {
	const filled = Math.round(Math.max(0, Math.min(1, fraction)) * 20);
	return `${"█".repeat(filled)}${"░".repeat(20 - filled)}`;
}

/** Clock-style reset label: "resets 19:53" today, else "resets 09:10 on 4 Sep". */
export function resetLabel(resetTime: string, now: Date): string {
	const at = new Date(resetTime);
	if (Number.isNaN(at.getTime())) return "";
	const hhmm = `${String(at.getHours()).padStart(2, "0")}:${String(at.getMinutes()).padStart(2, "0")}`;
	const sameDay =
		at.getFullYear() === now.getFullYear() &&
		at.getMonth() === now.getMonth() &&
		at.getDate() === now.getDate();
	if (sameDay) return `resets ${hhmm}`;
	const day = at.getDate();
	const mon = at.toLocaleString("en", { month: "short" });
	return `resets ${hhmm} on ${day} ${mon}`;
}

const WINDOW_RANK: Record<string, number> = { "5h": 0, weekly: 1 };

/** Full report text: per group, 5h bucket before weekly (the window users
 *  hit first), name labeled bar with percent and reset time. */
export function formatAgyQuotaReport(report: AgyQuotaReport, now: Date = new Date()): string {
	const lines: string[] = ["Antigravity quota (account-level, both engines)"];
	for (const group of report.groups) {
		lines.push("", group.name);
		const buckets = [...group.buckets].sort(
			(a, b) => (WINDOW_RANK[a.window] ?? 9) - (WINDOW_RANK[b.window] ?? 9),
		);
		for (const bucket of buckets) {
			const pct = Math.round(bucket.remainingFraction * 100);
			const reset = bucket.resetTime !== undefined ? ` · ${resetLabel(bucket.resetTime, now)}` : "";
			lines.push(`  ${bucket.name}: ${quotaBar(bucket.remainingFraction)} ${pct}%${reset}`);
		}
	}
	return lines.join("\n");
}
