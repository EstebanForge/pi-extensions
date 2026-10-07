// File-backed stripRead setting for pi-image-inline.
//
// pi's extension flags are in-memory only: seeded from registerFlag's
// `default` and CLI args at process start; there is no setFlag. So the
// stripRead choice lives in a tiny settings file at <piDir>/pi-image-inline.json
// and seeds the flag's default at factory load. Same pattern as
// pi-agentmemory's flag-settings and pi-token-cost-ledger's settings.json.

import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

const SETTINGS_FILENAME = "pi-image-inline.json";

export function getPiDir(): string {
	const envDir = process.env.PI_CODING_AGENT_DIR;
	if (envDir) return envDir;
	return join(homedir(), ".pi", "agent");
}

export function getSettingsPath(): string {
	return join(getPiDir(), SETTINGS_FILENAME);
}

/**
 * Read the persisted stripRead lockdown switch. Missing or corrupt file, or
 * a non-boolean value, means false: vision stays available by default.
 */
export function loadStripRead(): boolean {
	try {
		const path = getSettingsPath();
		if (!existsSync(path)) return false;
		const parsed = JSON.parse(readFileSync(path, "utf8")) as Record<string, unknown>;
		return typeof parsed.stripRead === "boolean" ? parsed.stripRead : false;
	} catch {
		return false;
	}
}
