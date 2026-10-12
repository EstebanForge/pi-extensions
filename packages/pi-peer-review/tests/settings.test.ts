// Settings characterization: project-file config over defaults, defensive
// coercion, reviewer validation. Real fs via mkdtemp.
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
	DEFAULT_SETTINGS,
	loadUnblockSettings,
	resolveCliFor,
	resolveReviewerCall,
	saveUnblockSettings,
} from "../src/settings.js";

let dir: string | null = null;

function withConfig(json: string): string {
	dir = mkdtempSync(join(tmpdir(), "unblock-cfg-"));
	mkdirSync(join(dir, ".pi"));
	writeFileSync(join(dir, ".pi", "unblock-settings.json"), json);
	return dir;
}

afterEach(() => {
	dir = null;
});

describe("loadUnblockSettings", () => {
	it("returns defaults when no config file exists", () => {
		const empty = mkdtempSync(join(tmpdir(), "unblock-cfg-"));
		expect(loadUnblockSettings(empty)).toEqual(DEFAULT_SETTINGS);
	});

	it("overrides known keys and keeps defaults for the rest", () => {
		const cwd = withConfig(JSON.stringify({ reviewer: "codex", threshold: 2, preprompt: "Be terse." }));
		const s = loadUnblockSettings(cwd);
		expect(s.reviewer).toBe("codex");
		expect(s.threshold).toBe(2);
		expect(s.preprompt).toBe("Be terse.");
		expect(s.cooldownSec).toBe(DEFAULT_SETTINGS.cooldownSec);
	});

	it("falls back to defaults on invalid JSON and an unknown reviewer", () => {
		expect(loadUnblockSettings(withConfig("{not json"))).toEqual(DEFAULT_SETTINGS);
		const cwd = withConfig(JSON.stringify({ reviewer: "gpt-9000" }));
		expect(loadUnblockSettings(cwd).reviewer).toBe(DEFAULT_SETTINGS.reviewer);
	});

	it("coerces bad scalar types back to defaults", () => {
		const cwd = withConfig(
			JSON.stringify({ threshold: "three", timeoutSec: null, confirmOnPush: "yes" }),
		);
		const s = loadUnblockSettings(cwd);
		expect(s.threshold).toBe(DEFAULT_SETTINGS.threshold);
		expect(s.timeoutSec).toBe(DEFAULT_SETTINGS.timeoutSec);
		expect(s.confirmOnPush).toBe(DEFAULT_SETTINGS.confirmOnPush);
	});

	it("clamps timeoutSec to setTimeout's 32-bit ceiling", () => {
		const cwd = withConfig(JSON.stringify({ timeoutSec: 99_999_999 }));
		expect(loadUnblockSettings(cwd).timeoutSec).toBe(Math.floor(2_147_483_647 / 1000));
	});

	it("coerces mistyped model and effort keys to null", () => {
		const cwd = withConfig(
			JSON.stringify({ effort: 3, claudeModel: true, codexEffort: [], agyModel: "gemini-3.5-flash" }),
		);
		const s = loadUnblockSettings(cwd);
		expect(s.effort).toBeNull();
		expect(s.claudeModel).toBeNull();
		expect(s.codexEffort).toBeNull();
		expect(s.agyModel).toBe("gemini-3.5-flash");
	});

	it("resolves a reviewer call: per-reviewer keys beat global, global beats null", () => {
		const both = resolveReviewerCall(
			{ ...DEFAULT_SETTINGS, model: "g", effort: "e", claudeModel: "c", claudeEffort: "ce" },
			"claude",
		);
		expect(both.model).toBe("c");
		expect(both.effort).toBe("ce");
		const globalOnly = resolveReviewerCall({ ...DEFAULT_SETTINGS, model: "g", effort: "e" }, "claude");
		expect(globalOnly.model).toBe("g");
		expect(globalOnly.effort).toBe("e");
		const none = resolveReviewerCall(DEFAULT_SETTINGS, "codex");
		expect(none.model).toBeNull();
		expect(none.effort).toBeNull();
	});

	it("merges ignoredCommands as an array of strings", () => {
		const cwd = withConfig(JSON.stringify({ ignoredCommands: ["ffmpeg", 3] }));
		expect(loadUnblockSettings(cwd).ignoredCommands).toEqual(["ffmpeg"]);
	});
});

describe("saveUnblockSettings", () => {
	it("merges the patch over existing keys without dropping unmanaged keys", () => {
		const cwd = withConfig(JSON.stringify({ reviewer: "codex", futureKey: 1 }));
		saveUnblockSettings(cwd, { threshold: 5 });
		const raw = JSON.parse(readFileSync(join(cwd, ".pi", "unblock-settings.json"), "utf-8"));
		expect(raw).toEqual({ reviewer: "codex", futureKey: 1, threshold: 5 });
	});

	it("creates .pi and the settings file when neither exists", () => {
		const cwd = mkdtempSync(join(tmpdir(), "unblock-cfg-"));
		saveUnblockSettings(cwd, { cooldownSec: 30 });
		expect(loadUnblockSettings(cwd).cooldownSec).toBe(30);
	});

	it("saves values that load back untouched through the defensive loader", () => {
		const cwd = mkdtempSync(join(tmpdir(), "unblock-cfg-"));
		saveUnblockSettings(cwd, {
			reviewer: "agy",
			binary: "/usr/local/bin/my-reviewer",
			threshold: 4,
			autoUnblockOnFailure: false,
			ignoredCommands: ["ffmpeg", "cargo test"],
		});
		const s = loadUnblockSettings(cwd);
		expect(s.reviewer).toBe("agy");
		expect(s.binary).toBe("/usr/local/bin/my-reviewer");
		expect(s.threshold).toBe(4);
		expect(s.autoUnblockOnFailure).toBe(false);
		expect(s.ignoredCommands).toEqual(["ffmpeg", "cargo test"]);
	});
});

describe("resolveCliFor", () => {
	it("resolves the stock CLIs by name", () => {
		expect(resolveCliFor("claude", null)).toEqual({ binary: "claude", args: [] });
		expect(resolveCliFor("codex", null)).toEqual({ binary: "codex", args: [] });
		expect(resolveCliFor("agy", null)).toEqual({ binary: "agy", args: [] });
	});

	it("honors a binary override (stub CLIs in tests, wrappers in prod)", () => {
		expect(resolveCliFor("claude", "/usr/local/bin/my-reviewer")).toEqual({
			binary: "/usr/local/bin/my-reviewer",
			args: [],
		});
	});
});
