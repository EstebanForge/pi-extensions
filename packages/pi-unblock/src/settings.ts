// Settings for pi-unblock: one project-scoped file (.pi/unblock-settings.json)
// over defaults. Deliberately flat: no global/project layering in v1, no
// per-trigger overrides (recorded v2 considerations).
import { join } from "node:path";
import { MAX_TIMEOUT_MS, tryReadJson } from "@estebanforge/pi-ask-shared";

export type Reviewer = "claude" | "codex" | "agy";

export interface UnblockSettings {
	reviewer: Reviewer;
	/** Executable override (stub CLIs in tests, wrappers in prod); null uses
	 *  the stock CLI name resolved via PATH. */
	binary: string | null;
	model: string | null;
	threshold: number;
	cooldownSec: number;
	timeoutSec: number;
	maxAutoConsultsPerSession: number;
	/** Always sent ahead of the consult frame. Blank by default. */
	preprompt: string;
	contextMaxTurns: number;
	maxOutputCharsPerTurn: number;
	autoUnblockOnFailure: boolean;
	confirmOnPush: boolean;
	/** Merged with the policy defaults; never replaces them. */
	ignoredCommands: string[];
}

export const DEFAULT_SETTINGS: UnblockSettings = {
	reviewer: "claude",
	binary: null,
	model: null,
	threshold: 3,
	cooldownSec: 120,
	timeoutSec: 45,
	maxAutoConsultsPerSession: 3,
	preprompt: "",
	contextMaxTurns: 4,
	maxOutputCharsPerTurn: 4000,
	autoUnblockOnFailure: true,
	confirmOnPush: true,
	ignoredCommands: [],
};

const REVIEWERS: readonly string[] = ["claude", "codex", "agy"];

function str(v: unknown, fallback: string): string {
	return typeof v === "string" ? v : fallback;
}

function num(v: unknown, fallback: number): number {
	return typeof v === "number" && Number.isFinite(v) ? v : fallback;
}

function bool(v: unknown, fallback: boolean): boolean {
	return typeof v === "boolean" ? v : fallback;
}

function strArray(v: unknown): string[] {
	return Array.isArray(v) ? v.filter((x): x is string => typeof x === "string") : [];
}

/** Load settings from <cwd>/.pi/unblock-settings.json, coercing every field
 *  back to its default when the type is wrong (config files are written by
 *  humans; a typo must not crash the extension). */
export function loadUnblockSettings(cwd: string): UnblockSettings {
	const raw = tryReadJson(join(cwd, ".pi", "unblock-settings.json")) as Record<string, unknown>;
	const reviewer = str(raw.reviewer, DEFAULT_SETTINGS.reviewer);
	return {
		reviewer: (REVIEWERS as readonly string[]).includes(reviewer)
			? (reviewer as Reviewer)
			: DEFAULT_SETTINGS.reviewer,
		binary: typeof raw.binary === "string" ? raw.binary : DEFAULT_SETTINGS.binary,
		model: typeof raw.model === "string" ? raw.model : DEFAULT_SETTINGS.model,
		threshold: Math.max(2, num(raw.threshold, DEFAULT_SETTINGS.threshold)),
		cooldownSec: Math.max(0, num(raw.cooldownSec, DEFAULT_SETTINGS.cooldownSec)),
		// Upper clamp: consult timeoutMs above setTimeout's 2^31-1 ms ceiling
		// would clamp to 1ms and kill the reviewer instantly.
		timeoutSec: Math.min(Math.max(5, num(raw.timeoutSec, DEFAULT_SETTINGS.timeoutSec)), Math.floor(MAX_TIMEOUT_MS / 1000)),
		maxAutoConsultsPerSession: Math.max(
			1,
			num(raw.maxAutoConsultsPerSession, DEFAULT_SETTINGS.maxAutoConsultsPerSession),
		),
		preprompt: str(raw.preprompt, DEFAULT_SETTINGS.preprompt),
		contextMaxTurns: Math.max(1, num(raw.contextMaxTurns, DEFAULT_SETTINGS.contextMaxTurns)),
		maxOutputCharsPerTurn: Math.max(
			200,
			num(raw.maxOutputCharsPerTurn, DEFAULT_SETTINGS.maxOutputCharsPerTurn),
		),
		autoUnblockOnFailure: bool(raw.autoUnblockOnFailure, DEFAULT_SETTINGS.autoUnblockOnFailure),
		confirmOnPush: bool(raw.confirmOnPush, DEFAULT_SETTINGS.confirmOnPush),
		ignoredCommands: strArray(raw.ignoredCommands),
	};
}

/** Resolve the CLI invocation for a reviewer: the stock binary name (PATH
 *  lookup is Node spawn's business) or the configured override. */
export function resolveCliFor(reviewer: Reviewer, binaryOverride: string | null): {
	binary: string;
	args: string[];
} {
	return { binary: binaryOverride ?? reviewer, args: [] };
}
