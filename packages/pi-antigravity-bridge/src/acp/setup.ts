import fs from "node:fs";
import os from "node:os";
import path from "node:path";

export interface AcpCleanupResult {
	removedBuilds: string[];
	rootRemoved: boolean;
}

export function defaultManagedAcpRoot(): string {
	return path.join(os.homedir(), ".local", "opt", "agy-acp");
}

function regularFile(file: string): boolean {
	try {
		return fs.lstatSync(file).isFile();
	} catch {
		return false;
	}
}

function realDirectory(file: string): boolean {
	try {
		const stat = fs.lstatSync(file);
		return stat.isDirectory() && !stat.isSymbolicLink();
	} catch {
		return false;
	}
}

function enoent(err: unknown): boolean {
	return (err as NodeJS.ErrnoException).code === "ENOENT";
}

/** Remove only artifacts carrying the old installer's layout markers. */
export function cleanupManagedAcpInstall(root: string = defaultManagedAcpRoot()): AcpCleanupResult {
	let rootStat: fs.Stats;
	try {
		rootStat = fs.lstatSync(root);
	} catch (err) {
		if (enoent(err)) return { removedBuilds: [], rootRemoved: false };
		throw err;
	}
	if (!rootStat.isDirectory() || rootStat.isSymbolicLink()) return { removedBuilds: [], rootRemoved: false };

	const entries = fs.readdirSync(root, { withFileTypes: true });
	const interrupted = new Set<string>();
	for (const entry of entries) {
		const match = /^\.download-(.+)\.zip$/.exec(entry.name);
		if (!match || !regularFile(path.join(root, entry.name))) continue;
		interrupted.add(match[1]!);
		try {
			fs.unlinkSync(path.join(root, entry.name));
		} catch (err) {
			if (!enoent(err)) throw err;
		}
	}

	const removedBuilds: string[] = [];
	for (const entry of entries) {
		if (!entry.isDirectory() || entry.isSymbolicLink()) continue;
		const dir = path.join(root, entry.name);
		if (!regularFile(path.join(dir, "agy_acp_server.par"))) {
			if (interrupted.has(entry.name)) {
				try {
					if (fs.readdirSync(dir).length === 0) fs.rmdirSync(dir);
				} catch (err) {
					if (!enoent(err)) throw err;
				}
			}
			continue;
		}
		const marked =
			regularFile(path.join(dir, "zip.sha256")) ||
			realDirectory(path.join(dir, "localharness_external")) ||
			interrupted.has(entry.name);
		if (!marked) continue;
		try {
			fs.rmSync(dir, { recursive: true, force: true });
			removedBuilds.push(entry.name);
		} catch (err) {
			if (!enoent(err)) throw err;
		}
	}

	const current = path.join(root, "current");
	try {
		if (fs.lstatSync(current).isSymbolicLink()) {
			const target = path.resolve(root, fs.readlinkSync(current));
			if (path.dirname(target) === root && removedBuilds.includes(path.basename(target))) fs.unlinkSync(current);
		}
	} catch (err) {
		if (!enoent(err)) throw err;
	}

	let rootRemoved = false;
	try {
		if (fs.readdirSync(root).length === 0) {
			fs.rmdirSync(root);
			rootRemoved = true;
		}
	} catch (err) {
		if (enoent(err)) rootRemoved = true;
		else throw err;
	}
	return { removedBuilds, rootRemoved };
}
