// File-backed persistence for pi-glm-tweaks settings.
//
// pi's extension flags (pi.registerFlag) are in-memory only, seeded from
// `default` and CLI `--flag-name` args at process start. There is no
// setFlag on ExtensionAPI and `pi config set <flag>` is NOT a real command
// (pi config only accepts -l/--approve/--no-approve). So we own a tiny
// settings file at <piDir>/pi-glm-tweaks.json, hydrate each registerFlag
// default from it at load, and write through on toggle. This makes settings
// survive pi restarts; the per-session apply path is ctx.reload()
// re-running the factory, which re-seeds the defaults from disk. `piDir` =
// process.env.PI_CODING_AGENT_DIR || ~/.pi/agent.
//
// Values are boolean (flags) or string (enum settings like glm-api-route);
// the on-disk JSON shape is a flat map either way, so pre-1.4.0 files with
// only booleans load unchanged.

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

const SETTINGS_FILENAME = "pi-glm-tweaks.json";

// Resolve the agent config dir the same way pi does (dist/config.js getAgentDir):
// env override wins, else ~/.pi/agent. Exported so tests can point it elsewhere.
export function getPiDir(): string {
	const envDir = process.env.PI_CODING_AGENT_DIR;
	if (envDir) return envDir;
	return join(homedir(), ".pi", "agent");
}

export function getSettingsPath(): string {
	return join(getPiDir(), SETTINGS_FILENAME);
}

/**
 * Load the persisted settings map. Missing/corrupt file → {} (caller falls
 * back to the setting's own default). Reads fresh from disk each call — the
 * file is tiny and reads happen only at factory load and session_start
 * model registration, so no cache is needed and toggle/reload stays
 * consistent. Non-boolean, non-string
 * values (corrupt hand-edited file) are dropped on load.
 */
export function loadSettings(): Record<string, boolean | string> {
	try {
		const path = getSettingsPath();
		if (!existsSync(path)) return {};
		const parsed = JSON.parse(readFileSync(path, "utf8")) as unknown;
		if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) return {};
		const obj = parsed as Record<string, unknown>;
		const out: Record<string, boolean | string> = {};
		for (const [name, val] of Object.entries(obj)) {
			if (typeof val === "boolean" || typeof val === "string") out[name] = val;
		}
		return out;
	} catch {
		// Corrupt / unreadable file -> empty map; settings fall back to defaults.
		return {};
	}
}

/** Boolean-only view (the flag registry). Unchanged semantics from v1. */
export function loadFlagSettings(): Record<string, boolean> {
	const out: Record<string, boolean> = {};
	for (const [name, val] of Object.entries(loadSettings())) {
		if (typeof val === "boolean") out[name] = val;
	}
	return out;
}

/** String-only view (enum settings such as glm-api-route). */
export function loadStringSettings(): Record<string, string> {
	const out: Record<string, string> = {};
	for (const [name, val] of Object.entries(loadSettings())) {
		if (typeof val === "string") out[name] = val;
	}
	return out;
}

/**
 * Persist + merge a single setting value (flag or enum) into the settings
 * file. mkdir recursive + writeFileSync, merge into the existing map so
 * concurrent writes don't clobber each other. Returns true on success;
 * false on disk error (caller notifies). The subsequent ctx.reload()
 * re-seeds flags from disk (registerFlag default), so the value still
 * applies this session when this returns true.
 */
export function saveSetting(name: string, value: boolean | string): boolean {
	const dir = getPiDir();
	const path = join(dir, SETTINGS_FILENAME);
	try {
		if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
		const existing = loadSettings();
		existing[name] = value;
		writeFileSync(path, JSON.stringify(existing, null, 2) + "\n", "utf8");
		return true;
	} catch {
		// Disk write failed (permissions, read-only fs). Caller notifies the
		// user; the session keeps working with whatever is currently in memory.
		return false;
	}
}
