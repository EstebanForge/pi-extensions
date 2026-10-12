// Settings UI pure helpers: row completeness, current-value display, value
// parsing (the same clamps the loader applies), and the headless snapshot.
import { describe, expect, it } from "vitest";
import { DEFAULT_SETTINGS, type UnblockSettings } from "../src/settings.js";
import {
	EDITOR_IDS,
	buildSettingItems,
	parseSettingValue,
	settingsSnapshotText,
} from "../src/settings-ui.js";

const ALL_IDS: readonly (keyof UnblockSettings)[] = [
	"reviewer",
	"binary",
	"model",
	"effort",
	"claudeModel",
	"claudeEffort",
	"codexModel",
	"codexEffort",
	"agyModel",
	"agyEffort",
	"threshold",
	"cooldownSec",
	"timeoutSec",
	"maxAutoConsultsPerSession",
	"preprompt",
	"contextMaxTurns",
	"maxOutputCharsPerTurn",
	"autoUnblockOnFailure",
	"confirmOnPush",
	"ignoredCommands",
];

const settingsWith = (over: Partial<UnblockSettings>): UnblockSettings => ({
	...DEFAULT_SETTINGS,
	...over,
});

describe("buildSettingItems", () => {
	it("exposes exactly the settings surface — no unreachable knob, no phantom row", () => {
		const items = buildSettingItems(DEFAULT_SETTINGS);
		expect(items.map((i) => i.id)).toEqual([...ALL_IDS]);
	});

	it("renders every row editable: cycle values or an overlay editor slot", () => {
		const items = buildSettingItems(DEFAULT_SETTINGS);
		for (const item of items) {
			const editable = (item.values?.length ?? 0) > 0 || EDITOR_IDS.has(item.id);
			expect(editable, `row ${item.id} has no editor`).toBe(true);
		}
	});

	it("cycles the reviewer through the three supported peers only", () => {
		const item = buildSettingItems(DEFAULT_SETTINGS).find((i) => i.id === "reviewer");
		expect(item?.values).toEqual(["claude", "codex", "agy"]);
	});

	it("shows defaults as their human placeholders", () => {
		const byId = new Map(buildSettingItems(DEFAULT_SETTINGS).map((i) => [i.id, i.currentValue]));
		expect(byId.get("binary")).toBe("(default: PATH)");
		expect(byId.get("model")).toBe("(reviewer default)");
		expect(byId.get("effort")).toBe("(cli default)");
		expect(byId.get("claudeModel")).toBe("(global model)");
		expect(byId.get("claudeEffort")).toBe("(global effort)");
		expect(byId.get("codexModel")).toBe("(global model)");
		expect(byId.get("codexEffort")).toBe("(global effort)");
		expect(byId.get("agyModel")).toBe("(global model)");
		expect(byId.get("agyEffort")).toBe("(global effort)");
		expect(byId.get("preprompt")).toBe("(none)");
		expect(byId.get("ignoredCommands")).toBe("none");
		expect(byId.get("autoUnblockOnFailure")).toBe("on");
		expect(byId.get("confirmOnPush")).toBe("on");
		expect(byId.get("threshold")).toBe("3");
	});

	it("shows real values verbatim", () => {
		const s = settingsWith({
			binary: "/usr/local/bin/my-reviewer",
			model: "gpt-6.1-sol",
			effort: "high",
			codexEffort: "max",
			preprompt: "Attack the premise first.",
			ignoredCommands: ["ffmpeg", "cargo test"],
			confirmOnPush: false,
		});
		const byId = new Map(buildSettingItems(s).map((i) => [i.id, i.currentValue]));
		expect(byId.get("binary")).toBe("/usr/local/bin/my-reviewer");
		expect(byId.get("model")).toBe("gpt-6.1-sol");
		expect(byId.get("effort")).toBe("high");
		expect(byId.get("codexEffort")).toBe("max");
		expect(byId.get("preprompt")).toBe("Attack the premise first.");
		expect(byId.get("ignoredCommands")).toBe("ffmpeg, cargo test");
		expect(byId.get("confirmOnPush")).toBe("off");
	});
});

describe("parseSettingValue", () => {
	const ok = (id: Parameters<typeof parseSettingValue>[0], raw: string) =>
		parseSettingValue(id, raw as never);
	const bad = (id: Parameters<typeof parseSettingValue>[0], raw: string) =>
		!parseSettingValue(id, raw as never).ok;

	it("accepts the three supported reviewers and rejects the rest", () => {
		expect(ok("reviewer", "codex")).toEqual({ ok: true, value: "codex" });
		expect(bad("reviewer", "gpt-9000")).toBe(true);
	});

	it("maps an empty binary/model to null and trims the rest", () => {
		expect(ok("binary", "")).toEqual({ ok: true, value: null });
		expect(ok("binary", " /usr/bin/foo ")).toEqual({ ok: true, value: "/usr/bin/foo" });
		expect(ok("model", "")).toEqual({ ok: true, value: null });
		expect(ok("model", " gpt-6.1 ")).toEqual({ ok: true, value: "gpt-6.1" });
	});

	it("maps effort and per-reviewer model/effort like model: empty is null, rest trimmed", () => {
		expect(ok("effort", "high")).toEqual({ ok: true, value: "high" });
		expect(ok("effort", "")).toEqual({ ok: true, value: null });
		expect(ok("claudeModel", "opus")).toEqual({ ok: true, value: "opus" });
		expect(ok("claudeModel", "")).toEqual({ ok: true, value: null });
		expect(ok("claudeEffort", "xhigh")).toEqual({ ok: true, value: "xhigh" });
		expect(ok("claudeEffort", "")).toEqual({ ok: true, value: null });
		expect(ok("codexModel", "6.1 full")).toEqual({ ok: true, value: "6.1 full" });
		expect(ok("codexEffort", "")).toEqual({ ok: true, value: null });
		expect(ok("agyModel", "gemini-3.5-flash")).toEqual({ ok: true, value: "gemini-3.5-flash" });
		expect(ok("agyEffort", "medium")).toEqual({ ok: true, value: "medium" });
	});

	it("keeps the preprompt verbatim after trim (empty stays empty)", () => {
		expect(ok("preprompt", "  Attack first. ")).toEqual({ ok: true, value: "Attack first." });
		expect(ok("preprompt", "")).toEqual({ ok: true, value: "" });
	});

	it("requires integer thresholds at 2 or more", () => {
		expect(ok("threshold", "5")).toEqual({ ok: true, value: 5 });
		expect(bad("threshold", "1")).toBe(true);
		expect(bad("threshold", "3.5")).toBe(true);
		expect(bad("threshold", "abc")).toBe(true);
		expect(bad("threshold", "")).toBe(true);
	});

	it("allows a zero cooldown and rejects negatives", () => {
		expect(ok("cooldownSec", "0")).toEqual({ ok: true, value: 0 });
		expect(bad("cooldownSec", "-1")).toBe(true);
	});

	it("clamps the consult timeout to the setTimeout-safe window", () => {
		expect(ok("timeoutSec", "5")).toEqual({ ok: true, value: 5 });
		expect(ok("timeoutSec", "2147483")).toEqual({ ok: true, value: 2147483 });
		expect(bad("timeoutSec", "4")).toBe(true);
		expect(bad("timeoutSec", "2147484")).toBe(true);
	});

	it("requires positive counts for the auto budget and context turns", () => {
		expect(ok("maxAutoConsultsPerSession", "1")).toEqual({ ok: true, value: 1 });
		expect(bad("maxAutoConsultsPerSession", "0")).toBe(true);
		expect(ok("contextMaxTurns", "1")).toEqual({ ok: true, value: 1 });
		expect(bad("contextMaxTurns", "0")).toBe(true);
	});

	it("keeps the per-turn output cap at 200 chars or more", () => {
		expect(ok("maxOutputCharsPerTurn", "200")).toEqual({ ok: true, value: 200 });
		expect(bad("maxOutputCharsPerTurn", "199")).toBe(true);
	});

	it("maps on/off to booleans and rejects other spellings", () => {
		expect(ok("autoUnblockOnFailure", "on")).toEqual({ ok: true, value: true });
		expect(ok("autoUnblockOnFailure", "off")).toEqual({ ok: true, value: false });
		expect(bad("autoUnblockOnFailure", "true")).toBe(true);
		expect(ok("confirmOnPush", "off")).toEqual({ ok: true, value: false });
	});

	it("splits ignored commands on commas and drops empties", () => {
		expect(ok("ignoredCommands", "a, b ,, c")).toEqual({ ok: true, value: ["a", "b", "c"] });
		expect(ok("ignoredCommands", "")).toEqual({ ok: true, value: [] });
	});
});

describe("settingsSnapshotText", () => {
	it("prints every setting and the file it edits", () => {
		const text = settingsSnapshotText(DEFAULT_SETTINGS, "/proj/.pi/unblock-settings.json");
		for (const id of ALL_IDS) expect(text).toContain(id);
		expect(text).toContain("/proj/.pi/unblock-settings.json");
	});
});
