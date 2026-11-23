import fs from "node:fs";
import path from "node:path";

export interface AtomicJsonWriteOptions {
	/** File mode for the written file. Default 0600: these files carry secrets. */
	mode?: number;
	/** Mode for directories created on the way to the file. Default: process umask. */
	dirMode?: number;
}

/** Atomic JSON write (temp + rename) for every shared config file. The
 *  rename goes through the symlink-resolved target so a dotfiles-managed
 *  link survives: an existing file resolves to its real path, a dangling
 *  link resolves one hop (the missing target is created through the link),
 *  a vanished non-link falls back to the raw path (fresh install), and any
 *  other resolution error (EACCES, a link loop) throws instead of silently
 *  replacing a link. The temp file lives in the target's directory so the
 *  rename never crosses devices. */
export function writeJsonAtomic(file: string, value: unknown, opts: AtomicJsonWriteOptions = {}): void {
	let target = file;
	try {
		target = fs.realpathSync(file);
	} catch (err) {
		if ((err as NodeJS.ErrnoException).code !== "ENOENT") throw err;
		const st = fs.lstatSync(file, { throwIfNoEntry: false });
		if (st?.isSymbolicLink()) target = path.resolve(path.dirname(file), fs.readlinkSync(file));
	}
	fs.mkdirSync(path.dirname(target), { recursive: true, mode: opts.dirMode });
	const tmp = `${target}.${process.pid}.tmp`;
	try {
		fs.writeFileSync(tmp, JSON.stringify(value, null, 2) + "\n", { mode: opts.mode ?? 0o600 });
		fs.renameSync(tmp, target);
	} catch (err) {
		try {
			fs.unlinkSync(tmp);
		} catch {
			/* nothing to clean */
		}
		throw err;
	}
}
