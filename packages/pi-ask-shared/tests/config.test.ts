import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { configPaths, loadLayeredRaw, saveLayeredConfig, tryReadJson } from "../src/config.js";

// Characterization suite for the layered config behavior the ask-* extensions
// ship today. Locks precedence, save routing, and file hygiene so the
// extraction from the three extensions cannot silently change semantics.

let root: string;
let globalDir: string;
let projectDir: string;
let paths: ReturnType<typeof configPaths>;

beforeEach(() => {
	root = fs.mkdtempSync(path.join(os.tmpdir(), "ask-shared-config-"));
	globalDir = path.join(root, "agent");
	projectDir = path.join(root, "project", ".pi");
	fs.mkdirSync(globalDir, { recursive: true });
	fs.mkdirSync(projectDir, { recursive: true });
	paths = configPaths({ globalDir, projectDir, fileName: "ask-test.json" });
});

afterEach(() => {
	fs.rmSync(root, { recursive: true, force: true });
});

function writeJson(file: string, value: unknown): void {
	fs.mkdirSync(path.dirname(file), { recursive: true });
	fs.writeFileSync(file, JSON.stringify(value, null, 2) + "\n");
}

describe("tryReadJson", () => {
	it("returns {} for a missing file", () => {
		expect(tryReadJson(path.join(root, "nope.json"))).toEqual({});
	});

	it("returns {} for an empty path", () => {
		expect(tryReadJson("")).toEqual({});
	});

	it("returns {} for invalid JSON", () => {
		const file = path.join(root, "bad.json");
		fs.writeFileSync(file, "{not json");
		expect(tryReadJson(file)).toEqual({});
	});

	it("returns {} for a directory path (read throws)", () => {
		expect(tryReadJson(globalDir)).toEqual({});
	});

	it("returns {} for scalar JSON (null, number, string)", () => {
		for (const raw of ["null", "42", '"str"']) {
			const file = path.join(root, `scalar-${raw.replace(/"/g, "")}.json`);
			fs.writeFileSync(file, raw);
			expect(tryReadJson(file)).toEqual({});
		}
	});

	it("preserves an object payload verbatim, unknown keys included", () => {
		const file = path.join(root, "ok.json");
		writeJson(file, { a: 1, legacy: { deep: true } });
		expect(tryReadJson(file)).toEqual({ a: 1, legacy: { deep: true } });
	});
});

describe("configPaths", () => {
	it("joins the file name under each dir", () => {
		expect(paths.globalPath).toBe(path.join(globalDir, "ask-test.json"));
		expect(paths.projectPath).toBe(path.join(projectDir, "ask-test.json"));
	});
});

describe("loadLayeredRaw", () => {
	it("lets project keys shadow global keys (shallow spread)", () => {
		writeJson(paths.globalPath, { key: "global", shared: "global" });
		writeJson(paths.projectPath, { shared: "project" });
		const { merged } = loadLayeredRaw(paths);
		expect(merged.key).toBe("global");
		expect(merged.shared).toBe("project");
	});

	it("surfaces unknown keys in merged", () => {
		writeJson(paths.globalPath, { legacyUnknown: "keep" });
		const { merged } = loadLayeredRaw(paths);
		expect(merged.legacyUnknown).toBe("keep");
	});

	it("returns empty merged when both files are missing", () => {
		expect(loadLayeredRaw(paths).merged).toEqual({});
	});
});

describe("saveLayeredConfig", () => {
	it("routes the WHOLE patch to project when any patched key is shadowed", () => {
		writeJson(paths.projectPath, { existing: "project" });
		const result = saveLayeredConfig(paths, { existing: "v2", fresh: "value" });
		expect(result.routedToProject).toBe(true);
		expect(result.path).toBe(paths.projectPath);
		// All-or-nothing: the fresh key is promoted into project scope too.
		expect(tryReadJson(paths.projectPath)).toEqual({ existing: "v2", fresh: "value" });
		expect(fs.existsSync(paths.globalPath)).toBe(false);
	});

	it("routes to global when no patched key is shadowed, even if project exists", () => {
		writeJson(paths.projectPath, { unrelated: "project" });
		const result = saveLayeredConfig(paths, { other: "value" });
		expect(result.routedToProject).toBe(false);
		expect(result.path).toBe(paths.globalPath);
		// Project file untouched by the global-routed save.
		expect(tryReadJson(paths.projectPath)).toEqual({ unrelated: "project" });
	});

	it("preserves unknown keys already in the target file", () => {
		writeJson(paths.globalPath, { legacy: "keepme", target: "old" });
		saveLayeredConfig(paths, { target: "new" });
		expect(tryReadJson(paths.globalPath)).toEqual({ legacy: "keepme", target: "new" });
	});

	it("writes 2-space JSON with a trailing newline", () => {
		saveLayeredConfig(paths, { a: 1 });
		const raw = fs.readFileSync(paths.globalPath, "utf-8");
		expect(raw).toBe('{\n  "a": 1\n}\n');
	});

	it("writes the target file with mode 0o600", () => {
		saveLayeredConfig(paths, { a: 1 });
		const mode = fs.statSync(paths.globalPath).mode & 0o777;
		expect(mode).toBe(0o600);
	});

	it("removes the temp file when the atomic rename fails", () => {
		// A directory at the target path makes renameSync throw (EISDIR).
		fs.mkdirSync(paths.globalPath);
		expect(() => saveLayeredConfig(paths, { a: 1 })).toThrow();
		const leftovers = fs.readdirSync(globalDir).filter((f) => f.includes(".tmp"));
		expect(leftovers).toEqual([]);
	});
});
