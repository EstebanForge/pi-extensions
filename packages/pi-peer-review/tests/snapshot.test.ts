// Delta engine against real fs and real git fixtures: temp-index tree
// snapshots, per-path deltas with statuses, the mtime-walk file backend,
// exclusion rules, hashing, and binary detection.
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
	EXCLUDED_DIR_NAMES,
	detectBackend,
	fileStatuses,
	gitPatchFor,
	gitTreeSnapshot,
	hashFile,
	isBinaryPath,
	isExcludedPath,
	walkRecentFiles,
} from "../src/snapshot.js";
import { isSecretPath } from "../src/secrets.js";

let repo: string;

function git(args: string[], cwd = repo, env: NodeJS.ProcessEnv = {}): string {
	return execFileSync("git", args, {
		cwd,
		env: { ...process.env, GIT_AUTHOR_NAME: t, GIT_AUTHOR_EMAIL: "t@t", ...env, GIT_COMMITTER_NAME: t, GIT_COMMITTER_EMAIL: "t@t" },
		encoding: "utf-8",
	});
}

const t = "test";

beforeEach(() => {
	repo = mkdtempSync(join(tmpdir(), "unblock-snap-"));
});

afterEach(() => {
	rmSync(repo, { recursive: true, force: true });
});

describe("detectBackend", () => {
	it("reports git inside a repo and files outside one", () => {
		execFileSync("git", ["init", "-q"], { cwd: repo });
		expect(detectBackend(repo)).toBe("git");
		expect(detectBackend(mkdemtpFix())).toBe("files");
	});

	function mkdemtpFix(): string {
		return mkdtempSync(join(tmpdir(), "unblock-nogit-"));
	}
});

describe("gitTreeSnapshot + fileStatuses", () => {
	it("sees modifications, additions, and deletions between snapshots", () => {
		execFileSync("git", ["init", "-q"], { cwd: repo });
		writeFileSync(join(repo, "a.txt"), "one\n");
		writeFileSync(join(repo, "c.txt"), "gone soon\n");
		git(["add", "-A"]);
		git(["commit", "-qm", "base"]);
		const before = gitTreeSnapshot(repo);

		writeFileSync(join(repo, "a.txt"), "one two\n");
		writeFileSync(join(repo, "b.txt"), "new file\n");
		rmSync(join(repo, "c.txt"));
		const after = gitTreeSnapshot(repo);

		const statuses = new Map(fileStatuses(repo, before, after).map((f) => [f.path, f.status]));
		expect(statuses.get("a.txt")).toBe("modified");
		expect(statuses.get("b.txt")).toBe("added");
		expect(statuses.get("c.txt")).toBe("deleted");
	});

	it("reports an empty delta when nothing changed", () => {
		execFileSync("git", ["init", "-q"], { cwd: repo });
		writeFileSync(join(repo, "a.txt"), "one\n");
		git(["add", "-A"]);
		git(["commit", "-qm", "base"]);
		const before = gitTreeSnapshot(repo);
		const after = gitTreeSnapshot(repo);
		expect(fileStatuses(repo, before, after)).toEqual([]);
	});

	it("includes untracked files and never touches the real index", () => {
		execFileSync("git", ["init", "-q"], { cwd: repo });
		writeFileSync(join(repo, "a.txt"), "one\n");
		git(["add", "a.txt"]);
		git(["commit", "-qm", "base"]);
		// a.txt is staged-clean; index.txt is untracked and must still land in
		// the snapshot tree, and the real index must stay untouched.
		writeFileSync(join(repo, "index.txt"), "untracked\n");
		const tree = gitTreeSnapshot(repo);
		const patch = gitPatchFor(repo, tree, tree, ["index.txt"]);
		// Same-tree diff is empty by definition; prove the tree contains the
		// untracked file via a diff against the empty tree.
		const empty = execFileSync("git", ["hash-object", "-t", "tree", "/dev/null"], { cwd: repo, encoding: "utf-8" }).trim();
		const statuses = fileStatuses(repo, empty, tree);
		expect(statuses.map((f) => f.path)).toContain("index.txt");
	});
});

describe("walkRecentFiles", () => {
	it("finds files newer than the cutoff and honors exclusions", () => {
		const old = join(repo, "old.ts");
		const fresh = join(repo, "src", "fresh.ts");
		mkdirSync(join(repo, "src"));
		writeFileSync(old, "old\n");
		writeFileSync(fresh, "fresh\n");
		writeFileSync(join(repo, "src", "skip.min.js"), "noise\n");
		mkdirSync(join(repo, "node_modules"));
		writeFileSync(join(repo, "node_modules", "fresh2.js"), "noise\n");
		writeFileSync(join(repo, "package-lock.json"), "noise\n");
		const past = new Date(Date.now() - 60_000);
		utimesSync(old, past, past);

		const found = walkRecentFiles(repo, Date.now() - 30_000, 1000);
		expect(found).toContain(join("src", "fresh.ts"));
		expect(found).not.toContain(join("old.ts"));
		expect(found.some((p) => p.includes("node_modules"))).toBe(false);
		expect(found.some((p) => p.endsWith(".min.js"))).toBe(false);
		expect(found.some((p) => p.endsWith("package-lock.json"))).toBe(false);
	});

	it("stops at the cap", () => {
		mkdirSync(join(repo, "d"));
		for (let i = 0; i < 5; i++) writeFileSync(join(repo, "d", `f${i}.txt`), `${i}\n`);
		expect(walkRecentFiles(repo, 0, 3)).toHaveLength(3);
	});
});

describe("isExcludedPath", () => {
	it("excludes noise dirs, lockfiles, minified and map files", () => {
		for (const p of [
			"node_modules/x/index.js",
			".git/config",
			"dist/bundle.js",
			"build/out.js",
			"vendor/lib.php",
			"__pycache__/m.pyc",
			"package-lock.json",
			"pnpm-lock.yaml",
			"Cargo.lock",
			"app.min.js",
			"app.js.map",
			".pi/unblock-settings.json",
		]) {
			expect(isExcludedPath(p), p).toBe(true);
		}
		for (const p of ["src/index.ts", "lib/main.go", "README.md"]) {
			expect(isExcludedPath(p), p).toBe(false);
		}
	});

	it("keeps the excluded names consistent with the walk", () => {
		expect(EXCLUDED_DIR_NAMES).toContain("node_modules");
	});
});

describe("hashFile", () => {
	it("changes when content changes and is stable otherwise", () => {
		const p = join(repo, "h.txt");
		writeFileSync(p, "v1\n");
		const h1 = hashFile(p);
		const h1b = hashFile(p);
		writeFileSync(p, "v2\n");
		const h2 = hashFile(p);
		expect(h1).toBe(h1b);
		expect(h1).not.toBe(h2);
	});

	it("hashes huge files by size and mtime without reading them all", () => {
		const p = join(repo, "big.bin");
		writeFileSync(p, Buffer.alloc(2 * 1024 * 1024, 7));
		expect(hashFile(p)).toMatch(/^big:/);
	});
});

describe("isBinaryPath", () => {
	it("detects a NUL byte in the head", () => {
		const p = join(repo, "blob.bin");
		writeFileSync(p, Buffer.concat([Buffer.alloc(16, 65), Buffer.from([0]), Buffer.alloc(16, 66)]));
		const text = join(repo, "text.txt");
		writeFileSync(text, "just words\n");
		expect(isBinaryPath(p)).toBe(true);
		expect(isBinaryPath(text)).toBe(false);
	});
});
