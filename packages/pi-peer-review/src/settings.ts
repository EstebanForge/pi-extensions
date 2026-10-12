// Settings for pi-peer-review: one project-scoped file (.pi/unblock-settings.json)
// over defaults. Deliberately flat: no global/project layering in v1, no
// per-trigger overrides (recorded v2 considerations).
import { mkdirSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { MAX_TIMEOUT_MS, tryReadJson } from "@estebanforge/pi-ask-shared";

export type Reviewer = "claude" | "codex" | "agy";

export interface UnblockSettings {
	reviewer: Reviewer;
	/** Executable override (stub CLIs in tests, wrappers in prod); null uses
	 *  the stock CLI name resolved via PATH. */
	binary: string | null;
	model: string | null;
	/** Default thinking effort for whichever reviewer is active; null uses
	 *  the CLI's own default. Ladders differ per CLI (claude:
	 *  default|low|medium|high|xhigh; codex: minimal..max; agy:
	 *  low|medium|high), so this is a free string. */
	effort: string | null;
	/** Per-reviewer model/effort defaults; beat the global pair when set. */
	claudeModel: string | null;
	claudeEffort: string | null;
	codexModel: string | null;
	codexEffort: string | null;
	agyModel: string | null;
	agyEffort: string | null;
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
	effort: null,
	claudeModel: null,
	claudeEffort: null,
	codexModel: null,
	codexEffort: null,
	agyModel: null,
	agyEffort: null,
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

/** Field clamps shared by the defensive loader and the /unblock settings
 *  editor, so a saved value never loads back differently than it was typed. */
export const SETTING_LIMITS = {
	thresholdMin: 2,
	cooldownSecMin: 0,
	timeoutSecMin: 5,
	// Above setTimeout's 2^31-1 ms ceiling the timer clamps to 1ms and kills
	// the reviewer instantly.
	timeoutSecMax: Math.floor(MAX_TIMEOUT_MS / 1000),
	maxAutoConsultsMin: 1,
	contextMaxTurnsMin: 1,
	maxOutputCharsPerTurnMin: 200,
} as const;

function str(v: unknown, fallback: string): string {
	return typeof v === "string" ? v : fallback;
}

function num(v: unknown, fallback: number): number {
	return typeof v === "number" && Number.isFinite(v) ? v : fallback;
}

function bool(v: unknown, fallback: boolean): boolean {
	return typeof v === "boolean" ? v : fallback;
}

/** Optional string setting: a wrong type or a missing key is null. */
function strOrNull(v: unknown): string | null {
	return typeof v === "string" ? v : null;
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
		effort: strOrNull(raw.effort),
		claudeModel: strOrNull(raw.claudeModel),
		claudeEffort: strOrNull(raw.claudeEffort),
		codexModel: strOrNull(raw.codexModel),
		codexEffort: strOrNull(raw.codexEffort),
		agyModel: strOrNull(raw.agyModel),
		agyEffort: strOrNull(raw.agyEffort),
		threshold: Math.max(SETTING_LIMITS.thresholdMin, num(raw.threshold, DEFAULT_SETTINGS.threshold)),
		cooldownSec: Math.max(SETTING_LIMITS.cooldownSecMin, num(raw.cooldownSec, DEFAULT_SETTINGS.cooldownSec)),
		// Upper clamp: see SETTING_LIMITS.timeoutSecMax.
		timeoutSec: Math.min(
			Math.max(SETTING_LIMITS.timeoutSecMin, num(raw.timeoutSec, DEFAULT_SETTINGS.timeoutSec)),
			SETTING_LIMITS.timeoutSecMax,
		),
		maxAutoConsultsPerSession: Math.max(
			SETTING_LIMITS.maxAutoConsultsMin,
			num(raw.maxAutoConsultsPerSession, DEFAULT_SETTINGS.maxAutoConsultsPerSession),
		),
		preprompt: str(raw.preprompt, DEFAULT_SETTINGS.preprompt),
		contextMaxTurns: Math.max(SETTING_LIMITS.contextMaxTurnsMin, num(raw.contextMaxTurns, DEFAULT_SETTINGS.contextMaxTurns)),
		maxOutputCharsPerTurn: Math.max(
			SETTING_LIMITS.maxOutputCharsPerTurnMin,
			num(raw.maxOutputCharsPerTurn, DEFAULT_SETTINGS.maxOutputCharsPerTurn),
		),
		autoUnblockOnFailure: bool(raw.autoUnblockOnFailure, DEFAULT_SETTINGS.autoUnblockOnFailure),
		confirmOnPush: bool(raw.confirmOnPush, DEFAULT_SETTINGS.confirmOnPush),
		ignoredCommands: strArray(raw.ignoredCommands),
	};
}

/** Persist a patch onto .pi/unblock-settings.json: merge over the existing
 *  file so hand-added keys survive, atomic tmp+rename so a crash cannot
 *  truncate the config. Returns the written path. */
export function saveUnblockSettings(cwd: string, patch: Partial<UnblockSettings>): string {
	const targetPath = join(cwd, ".pi", "unblock-settings.json");
	const next = { ...tryReadJson(targetPath), ...patch };
	mkdirSync(dirname(targetPath), { recursive: true });
	const tmp = `${targetPath}.${process.pid}.tmp`;
	try {
		writeFileSync(tmp, JSON.stringify(next, null, "\t") + "\n");
		renameSync(tmp, targetPath);
	} catch (err) {
		try {
			unlinkSync(tmp);
		} catch {}
		throw err;
	}
	return targetPath;
}

/** Resolve the CLI invocation for a reviewer: the stock binary name (PATH
 *  lookup is Node spawn's business) or the configured override. */
export function resolveCliFor(reviewer: Reviewer, binaryOverride: string | null): {
	binary: string;
	args: string[];
} {
	return { binary: binaryOverride ?? reviewer, args: [] };
}

/** Model/effort resolution for one consult: per-reviewer keys beat the
 *  global pair, null falls through to the CLI's own defaults. */
export function resolveReviewerCall(
	s: UnblockSettings,
	reviewer: Reviewer,
): { model: string | null; effort: string | null } {
	const perModel = { claude: s.claudeModel, codex: s.codexModel, agy: s.agyModel }[reviewer];
	const perEffort = { claude: s.claudeEffort, codex: s.codexEffort, agy: s.agyEffort }[reviewer];
	return { model: perModel ?? s.model, effort: perEffort ?? s.effort };
}
