// File-backed persistence for agentmemory extension flags.
//
// pi's extension flags (pi.registerFlag) are in-memory only: seeded from
// registerFlag's `default` and CLI `--flag-name` args at process start. There
// is no setFlag on ExtensionAPI, and `pi config set <flag> <value>` is NOT a
// real command (pi config only accepts -l/--approve/--no-approve). So we own a
// tiny settings file at <piDir>/pi-agentmemory.json mapping flag names to
// booleans. The factory reads it at load to seed each registerFlag default; the
// /agentmemory toggle writes through to it before reloading. `piDir` =
// process.env.PI_CODING_AGENT_DIR || ~/.pi/agent.

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

const SETTINGS_FILENAME = "pi-agentmemory.json";

type FlagMap = Record<string, boolean>;

// Resolve the agent config dir the same way pi does (dist/config.js
// getAgentDir): env override wins, else ~/.pi/agent. Exported so tests can
// point it elsewhere.
export function getPiDir(): string {
  const envDir = process.env.PI_CODING_AGENT_DIR;
  if (envDir) return envDir;
  return join(homedir(), ".pi", "agent");
}

export function getSettingsPath(): string {
  return join(getPiDir(), SETTINGS_FILENAME);
}

/**
 * Read persisted flag settings as a name→boolean map. Missing or corrupt
 * file → {} (callers fall back to the in-code default for each flag).
 */
export function loadFlagSettings(): FlagMap {
  try {
    const path = getSettingsPath();
    if (!existsSync(path)) return {};
    const parsed = JSON.parse(readFileSync(path, "utf8")) as Record<string, unknown>;
    const out: FlagMap = {};
    // Keep only literal boolean values; drop anything else defensively so a
    // hand-edited or corrupt file can't inject a wrong-typed seed.
    for (const [k, v] of Object.entries(parsed)) {
      if (typeof v === "boolean") out[k] = v;
    }
    return out;
  } catch {
    // Corrupt / unreadable file → empty map → use in-code defaults.
    return {};
  }
}

/**
 * Persist a single flag into the settings file, merging into whatever is
 * already on disk. mkdir recursive + writeFileSync. Returns true on success.
 */
export function saveFlagSetting(name: string, value: boolean): boolean {
  const dir = getPiDir();
  const path = join(dir, SETTINGS_FILENAME);
  try {
    const current = loadFlagSettings();
    current[name] = value;
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
    writeFileSync(path, JSON.stringify(current, null, 2) + "\n", "utf8");
    return true;
  } catch {
    // Disk write failed (permissions, read-only fs). The subsequent reload
    // re-seeds registerFlag defaults from disk, so the session keeps working
    // with whatever is currently persisted.
    return false;
  }
}
