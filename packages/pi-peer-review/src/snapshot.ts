// Delta engine primitives: which files changed since a pointer, under two
// backends. Git repo: content-addressed tree snapshots via a TEMP index
// (write-tree), so the user's real index is never touched and untracked
// files are included. No repo: a bounded mtime walk plus content hashes.
// Zero pi imports; the engine (review-engine.ts) owns pointers and policy.
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import {
	closeSync,
	openSync,
	readSync,
	readdirSync,
	rmSync,
	statSync,
	type Dirent,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, relative, sep } from "node:path";

export type Backend = "git" | "files";

export interface ChangeFile {
	path: string;
	status: "added" | "modified" | "deleted";
}

/** Directories never walked and never reviewed: dependency and build noise. */
export const EXCLUDED_DIR_NAMES: ReadonlySet<string> = new Set([
	"node_modules",
	".git",
	"dist",
	"build",
	"vendor",
	"__pycache__",
	".venv",
	"target",
	".next",
	".cache",
	".idea",
	".vscode",
]);

/** File patterns excluded from review material: lockfiles, bundles, maps,
 *  pi-unblock's own state. Matched against the repo-relative path. */
const EXCLUDED_FILE_PATTERNS: RegExp[] = [
	/(^|\/)(?:package-lock\.json|pnpm-lock\.yaml|yarn\.lock|Cargo\.lock|poetry\.lock|composer\.lock|go\.sum|Gemfile\.lock)$/,
	/(^|\/)\.pi\//,
	/\.min\.[cm]?js$/,
	/\.map$/,
];

export function isExcludedPath(relPath: string): boolean {
	const normalized = relPath.split(sep).join("/");
	if (normalized.split("/").some((seg) => EXCLUDED_DIR_NAMES.has(seg))) return true;
	return EXCLUDED_FILE_PATTERNS.some((re) => re.test(normalized));
}

// Secret paths are owned by secrets.ts; the walk re-uses the same guard.

/** Repo present? Cheap, cached by the caller per review. */
export function detectBackend(cwd: string): Backend {
	try {
		execFileSync("git", ["rev-parse", "--is-inside-work-tree"], { cwd, stdio: "ignore" });
		return "git";
	} catch {
		return "files";
	}
}

function git(cwd: string, args: string[], env: NodeJS.ProcessEnv = {}): string {
	// GIT_LITERAL_PATHSPECS: file paths from the delta are exact paths, never
	// globs. 64 MiB maxBuffer: a big worktree diff must not kill the review.
	return execFileSync("git", args, {
		cwd,
		env: { ...process.env, GIT_LITERAL_PATHSPECS: "1", ...env },
		encoding: "utf-8",
		maxBuffer: 64 * 1024 * 1024,
	});
}

/** The universal empty tree id: diff target for a null pointer (backend
 *  flip, repo with no commits) so the first audit sees everything. */
export const EMPTY_TREE = "4b825dc642cb6eb9a060e54bf8d69288fbee4904";

/** Content-addressed snapshot of the worktree (tracked + untracked, minus
 *  gitignored and .pi) via a throwaway index in the OS temp dir. Returns a
 *  tree id usable as a pointer. Fails closed: a broken repo throws and the
 *  caller degrades. .pi is dropped from the temp index AFTER add (a pathspec
 *  exclude would error when .pi is gitignored). */
export function gitTreeSnapshot(cwd: string): string {
	const tmpIndex = join(tmpdir(), `unblock-index-${process.pid}-${Date.now()}`);
	try {
		git(cwd, ["read-tree", "--empty"], { GIT_INDEX_FILE: tmpIndex });
		git(cwd, ["add", "-A"], { GIT_INDEX_FILE: tmpIndex });
		git(cwd, ["reset", "-q", "--", ".pi"], { GIT_INDEX_FILE: tmpIndex });
		return git(cwd, ["write-tree"], { GIT_INDEX_FILE: tmpIndex }).trim();
	} finally {
		rmSync(tmpIndex, { force: true });
	}
}

/** Added/modified/deleted paths between two trees. With -z, git NUL-points
 *  status and path separately (`M\0path\0...`); git quotes unusual paths
 *  without -z, which would break the per-file patch lookups downstream. */
export function fileStatuses(cwd: string, fromTree: string, toTree: string): ChangeFile[] {
	if (fromTree === toTree) return [];
	const out = git(cwd, ["diff-tree", "-r", "--name-status", "--no-renames", "-z", fromTree, toTree]);
	const entries = out.split("\0").filter(Boolean);
	const statuses: ChangeFile[] = [];
	for (let i = 0; i + 1 < entries.length; i += 2) {
		const code = entries[i]!;
		const path = entries[i + 1]!;
		statuses.push({
			path,
			status: code === "A" ? ("added" as const) : code === "D" ? ("deleted" as const) : ("modified" as const),
		});
	}
	return statuses.filter((f) => !isExcludedPath(f.path));
}

/** `git diff --stat` between two trees (human summary for the frame). */
export function gitDiffStat(cwd: string, fromTree: string, toTree: string): string {
	if (fromTree === toTree) return "";
	return git(cwd, ["diff", "--stat", fromTree, toTree]).trim();
}

/** Unified diff for specific paths between two trees. Flags stop user git
 *  config (external diffs, color, textconv) from corrupting the patch. */
export function gitPatchFor(cwd: string, fromTree: string, toTree: string, paths: string[]): string {
	if (fromTree === toTree || paths.length === 0) return "";
	return git(cwd, ["diff", "-U3", "--no-ext-diff", "--no-color", "--no-textconv", fromTree, toTree, "--", ...paths]);
}

/** Whole file content at a tree (`git show tree:path`); null when absent. */
export function gitFileAt(cwd: string, tree: string, path: string): string | null {
	try {
		return git(cwd, ["show", `${tree}:${path}`]);
	} catch {
		return null;
	}
}

// --- files backend ----------------------------------------------------------

/** Recent files under cwd (relative, repo-slash paths), newest mtime first,
 *  honoring the exclusion rules. The whole tree is scanned (depth-bounded),
 *  then sorted and cut: an early stop would cut in readdir order, not by
 *  recency. Dotfiles are scanned too (.github matters); the secret guard and
 *  the exclude list filter the noise. */
export function walkRecentFiles(cwd: string, sinceMs: number, limit: number): string[] {
	const found: { path: string; mtime: number }[] = [];
	const walk = (dir: string, depth: number): void => {
		if (depth > 12) return;
		let entries: Dirent[];
		try {
			entries = readdirSync(dir, { withFileTypes: true });
		} catch {
			return;
		}
		for (const e of entries) {
			const full = join(dir, e.name);
			if (e.isDirectory()) {
				if (EXCLUDED_DIR_NAMES.has(e.name)) continue;
				walk(full, depth + 1);
				continue;
			}
			if (!e.isFile()) continue;
			const rel = relative(cwd, full);
			if (isExcludedPath(rel)) continue;
			try {
				const mtime = statSync(full).mtimeMs;
				if (mtime >= sinceMs) found.push({ path: rel.split(sep).join("/"), mtime });
			} catch {
				// raced deletion; not material anymore
			}
		}
	};
	walk(cwd, 0);
	return found
		.sort((a, b) => b.mtime - a.mtime)
		.slice(0, limit)
		.map((f) => f.path);
}

/** Streamed content hash; large files collapse to a size+mtime stamp so a
 *  multi-MB artifact never blocks a review. */
const BIG_FILE_BYTES = 1024 * 1024;

export function hashFile(path: string): string {
	const st = statSync(path);
	if (st.size > BIG_FILE_BYTES) return `big:${st.size}:${Math.round(st.mtimeMs)}`;
	const h = createHash("sha256");
	const fd = openSync(path, "r");
	try {
		const buf = Buffer.alloc(64 * 1024);
		for (;;) {
			const n = readSync(fd, buf, 0, buf.length, null);
			if (n === 0) break;
			h.update(buf.subarray(0, n));
		}
	} finally {
		try {
			closeSync(fd);
		} catch {}
	}
	return h.digest("hex");
}

/** Hash a bounded path list into a pointer map (files backend). */
export function hashSnapshot(cwd: string, relPaths: string[]): Map<string, string> {
	const map = new Map<string, string>();
	for (const rel of relPaths) {
		try {
			map.set(rel, hashFile(join(cwd, rel)));
		} catch {
			// vanished between walk and hash; not material
		}
	}
	return map;
}

/** NUL byte anywhere in the first 8 KB: binary, list it, never inline it. */
export function isBinaryPath(path: string): boolean {
	const fd = openSync(path, "r");
	try {
		const buf = Buffer.alloc(8192);
		const n = readSync(fd, buf, 0, buf.length, null);
		return buf.subarray(0, n).includes(0);
	} finally {
		try {
			closeSync(fd);
		} catch {}
	}
}
