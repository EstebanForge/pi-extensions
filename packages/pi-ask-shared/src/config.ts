import fs from "node:fs";
import path from "node:path";

/**
 * Layered config primitives shared by the ask-* extensions. Extracted
 * verbatim from pi-ask-claude / pi-ask-codex / pi-ask-antigravity
 * (behavior-preserving): project config shadows global on load; saves route
 * all-or-nothing to whichever file already defines a patched key.
 *
 * Callers resolve their own dirs (claude uses pi's getAgentDir(), codex and
 * antigravity hardcode ~/.pi/agent) so no path resolution behavior changes
 * during the extraction.
 */

export interface ConfigPaths {
	globalPath: string;
	projectPath: string;
}

export function configPaths(opts: { globalDir: string; projectDir: string; fileName: string }): ConfigPaths {
	return {
		globalPath: path.join(opts.globalDir, opts.fileName),
		projectPath: path.join(opts.projectDir, opts.fileName),
	};
}

export function tryReadJson(filePath: string): Record<string, unknown> {
	if (!filePath || !fs.existsSync(filePath)) return {};
	try {
		const parsed = JSON.parse(fs.readFileSync(filePath, "utf-8"));
		return parsed && typeof parsed === "object" ? (parsed as Record<string, unknown>) : {};
	} catch {
		return {};
	}
}

export interface LayeredRaw {
	global: Record<string, unknown>;
	project: Record<string, unknown>;
	/** Shallow merge, project keys win over global keys. Unknown keys surface. */
	merged: Record<string, unknown>;
}

export function loadLayeredRaw(paths: ConfigPaths): LayeredRaw {
	const global = tryReadJson(paths.globalPath);
	const project = tryReadJson(paths.projectPath);
	return { global, project, merged: { ...global, ...project } };
}

export interface SaveResult {
	path: string;
	/** True when the write went to the project config (project shadows global). */
	routedToProject: boolean;
}

/** Persist a config patch. If the project config already defines any patched
 *  key, write to the PROJECT file so the change actually takes effect
 *  (project shadows global on load); otherwise write to global.
 *  Atomic: temp file + rename, with temp cleanup on failure.
 *  Routing is all-or-nothing per save: if ANY patched key is shadowed by
 *  project config, the WHOLE patch goes to project. Matches the extensions'
 *  shipped behavior (the slash commands save all keys together; mixing
 *  scopes in one save would surprise more than this does). */
export function saveLayeredConfig(paths: ConfigPaths, patch: Record<string, unknown>): SaveResult {
	const projectRaw = tryReadJson(paths.projectPath);
	const projectShadows = Object.keys(patch).some((k) => k in projectRaw);
	const targetPath = projectShadows ? paths.projectPath : paths.globalPath;

	const existing = tryReadJson(targetPath);
	const next = { ...existing, ...patch };
	const dir = path.dirname(targetPath);
	fs.mkdirSync(dir, { recursive: true });

	const tmp = `${targetPath}.${process.pid}.tmp`;
	try {
		fs.writeFileSync(tmp, JSON.stringify(next, null, 2) + "\n", { mode: 0o600 });
		fs.renameSync(tmp, targetPath);
	} catch (err) {
		try {
			fs.unlinkSync(tmp);
		} catch {}
		throw err;
	}
	return { path: targetPath, routedToProject: projectShadows };
}
