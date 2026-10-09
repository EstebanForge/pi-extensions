import { mkdtempSync, writeFileSync } from "node:fs";
import os from "node:os";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
	buildAgyArgs,
	buildFinalPrompt,
	CONV_ID_RE,
	filterHiddenModels,
	levelToTier,
	mergeCatalog,
	newConversationId,
	parseModelLine,
	procTreeOpenDbResolver,
	resolveAgyModel,
	snapshotConversations,
	type ModelEntry,
} from "../src/peers/antigravity.js";

// Characterization suite for the Antigravity (agy) peer adapter, ported from
// pi-ask-antigravity before its extension refactored onto this module. Pins:
// the `agy models` line grammar, tiered alias resolution, the plan-mode
// prompt guards, the argv contract (--print-timeout, plan-run flag filter),
// and the SQLite conversation-id discovery technique.

const entry = (full: string, tier: ModelEntry["tier"] = null): ModelEntry => {
	const lower = full.toLowerCase();
	const versionMatch = lower.match(/(\d+\.\d+)/);
	return {
		full,
		family: lower.includes("flash") ? "flash" : lower.includes("pro") ? "pro" : "other",
		version: versionMatch ? versionMatch[1] : null,
		tier,
	};
};

describe("parseModelLine", () => {
	it("parses the two-column `agy models` shape, keeping only the slug", () => {
		expect(parseModelLine("gemini-3.6-flash-medium  Gemini 3.6 Flash (Medium)")).toEqual({
			full: "gemini-3.6-flash-medium",
			family: "flash",
			version: "3.6",
			tier: "medium",
		});
		// Bare-slug line (no label column) splits to itself.
		expect(parseModelLine("claude-opus-5-5-high")).toEqual({
			full: "claude-opus-5-5-high",
			family: "other",
			version: null,
			tier: "high",
		});
		expect(parseModelLine("   ")).toBeNull();
	});
});

describe("catalog helpers", () => {
	it("drops hidden families (gpt-oss-*) outright", () => {
		expect(filterHiddenModels([entry("gpt-oss-120b"), entry("gemini-3.6-flash-low")])).toEqual([
			entry("gemini-3.6-flash-low"),
		]);
	});

	it("merges the static overlay; live entries win per exact slug, others fill in", () => {
		const merged = mergeCatalog([entry("CLAUDE-SONNET-5-5-LOW")]);
		// The live entry suppresses ONLY its exact overlay twin (case-insensitive);
		// the other tier variants and opus still come from the overlay.
		const low = merged.filter((e) => e.full.toLowerCase() === "claude-sonnet-5-5-low");
		expect(low.length).toBe(1);
		expect(low[0]!.full).toBe("CLAUDE-SONNET-5-5-LOW"); // live casing kept
		expect(merged.some((e) => e.full === "claude-sonnet-5-5-medium")).toBe(true);
		expect(merged.some((e) => e.full === "claude-opus-5-5-low")).toBe(true);
	});
});

describe("levelToTier", () => {
	it("clamps the pi vocabulary onto agy's three tiers", () => {
		expect(levelToTier("minimal")).toBe("low");
		expect(levelToTier("low")).toBe("low");
		expect(levelToTier("medium")).toBe("medium");
		expect(levelToTier("xhigh")).toBe("high");
		expect(levelToTier("max")).toBe("high");
		expect(levelToTier("nonsense")).toBe("low");
	});
});

describe("resolveModel", () => {
	const catalog = [
		entry("gemini-3.5-flash-low", "low"),
		entry("gemini-3.5-flash-medium", "medium"),
		entry("gemini-3.6-flash-low", "low"),
		entry("gemini-3.6-flash-medium", "medium"),
		entry("gemini-3.6-flash-high", "high"),
		entry("gemini-3.6-pro-low", "low"),
		entry("gemini-3.6-pro-high", "high"),
	];

	it("exact full-string match wins and splits the tier for gemini bases", () => {
		expect(resolveAgyModel("gemini-3.6-flash-high", catalog, "medium")).toEqual({
			model: "gemini-3.6-flash",
			effort: "high",
		});
	});

	it("family alias picks the highest version, then the tier ladder", () => {
		expect(resolveAgyModel("flash", catalog, "medium")).toEqual({
			model: "gemini-3.6-flash",
			effort: "medium",
		});
		// Pro has no medium: family default (high) applies, not nearest-medium.
		expect(resolveAgyModel("pro", catalog, "medium")).toEqual({
			model: "gemini-3.6-pro",
			effort: "high",
		});
	});

	it("explicit tier beats embedded tier and config default", () => {
		expect(resolveAgyModel("flash", catalog, "medium", "low")).toEqual({
			model: "gemini-3.6-flash",
			effort: "low",
		});
		// An embedded tier the family lacks is CLAMPED to the nearest real
		// tier (3.5 flash ships low/medium only; high clamps to medium).
		expect(resolveAgyModel("3.5 flash high", catalog, "medium")).toEqual({
			model: "gemini-3.5-flash",
			effort: "medium",
		});
	});

	it("gemini/default/empty fall to the flash family", () => {
		expect(resolveAgyModel("gemini", catalog, "medium")?.model).toBe("gemini-3.6-flash");
		expect(resolveAgyModel("default", catalog, "medium")?.model).toBe("gemini-3.6-flash");
	});

	it("short aliases resolve via the static overlay tiered base", () => {
		const r = resolveAgyModel("sonnet", mergeCatalog([]), "medium");
		expect(r?.model).toBe("claude-sonnet-5-5");
		expect(r?.effort).toBe("medium");
	});

	it("bare tiered bases the provider advertises resolve to the nearest variant", () => {
		const r = resolveAgyModel("claude-sonnet-5-5", mergeCatalog([]), "high");
		expect(r?.model).toBe("claude-sonnet-5-5");
		expect(r?.effort).toBe("high");
	});

	it("unknown families return null (caller passes raw input to agy)", () => {
		expect(resolveAgyModel("mystery-model", catalog, "medium")).toBeNull();
	});
});

describe("buildFinalPrompt", () => {
	it("accept-edits runs keep their tools and never get a guard", () => {
		expect(buildFinalPrompt("do X", "accept-edits", false)).toBe("do X");
		expect(buildFinalPrompt("do X", "accept-edits", true)).toBe(
			"(Use compact digests, not full file contents.)\ndo X",
		);
	});

	it("plan runs get the headless guard last (max recency position)", () => {
		const out = buildFinalPrompt("review this", "plan", false);
		expect(out.startsWith("review this")).toBe(true);
		expect(out).toContain("--- Headless session constraints ---");
		expect(out).toContain("Do not run shell commands.");
	});

	it("plan runs with the reviewer-agent damper get the review guard instead", () => {
		const out = buildFinalPrompt("review this", "plan", false, true);
		expect(out).toContain("--- Review constraints ---");
		expect(out).toContain("Read-only review.");
		expect(out).not.toContain("Headless session constraints");
	});
});

describe("buildAgyArgs", () => {
	const base = {
		cwd: "/workspace",
		resolved: { model: "gemini-3.6-flash", effort: "medium" as const },
		mode: "accept-edits" as const,
		skipPermissions: true,
		timeoutMinutes: 10,
		extraArgs: [] as string[],
		prompt: "do the thing",
	};

	it("base shape: add-dir, model/effort, mode, print-timeout, prompt last", () => {
		const args = buildAgyArgs({ ...base });
		expect(args.slice(0, 2)).toEqual(["--add-dir", "/workspace"]);
		expect(args[args.indexOf("--model") + 1]).toBe("gemini-3.6-flash");
		expect(args[args.indexOf("--effort") + 1]).toBe("medium");
		expect(args[args.indexOf("--mode") + 1]).toBe("accept-edits");
		expect(args[args.indexOf("--print-timeout") + 1]).toBe("10m");
		expect(args[args.indexOf("-p") + 1]).toBe("do the thing");
		expect(args[args.length - 2]).toBe("-p");
	});

	it("skip-permissions flag lands only when enabled AND mode is not plan", () => {
		expect(buildAgyArgs({ ...base })).toContain("--dangerously-skip-permissions");
		expect(buildAgyArgs({ ...base, skipPermissions: false })).not.toContain(
			"--dangerously-skip-permissions",
		);
		// Plan NEVER gets the flag, even when enabled: upstream writes are not
		// gated under plan mode, so an auto-approved plan run is write-capable.
		expect(buildAgyArgs({ ...base, mode: "plan" })).not.toContain("--dangerously-skip-permissions");
	});

	it("filters env-injected skip flags out of plan runs (fail-closed)", () => {
		const args = buildAgyArgs({
			...base,
			mode: "plan",
			extraArgs: ["--sandbox", "--dangerously-skip-permissions"],
		});
		expect(args).toContain("--sandbox");
		expect(args).not.toContain("--dangerously-skip-permissions");
		// accept-edits passes env extras through unfiltered.
		const plain = buildAgyArgs({ ...base, extraArgs: ["--sandbox"] });
		expect(plain).toContain("--sandbox");
	});

	it("threads the reviewer agent, continuation id, and extra add-dirs", () => {
		const args = buildAgyArgs({
			...base,
			reviewerAgentName: "pi-bridge-ask-123",
			conversationId: "9e6fdc2f-f9f9-4096-95fc-7852528b50cc",
			addDirs: ["/ctx/dir"],
		});
		expect(args[args.indexOf("--agent") + 1]).toBe("pi-bridge-ask-123");
		expect(args[args.indexOf("--conversation") + 1]).toBe("9e6fdc2f-f9f9-4096-95fc-7852528b50cc");
		expect(args[args.indexOf("--add-dir", args.indexOf("/workspace") + 1) + 1]).toBe("/ctx/dir");
	});

	it("omits --model/--effort when the resolution passes raw input through", () => {
		const args = buildAgyArgs({ ...base, resolved: { model: "" } });
		expect(args).not.toContain("--model");
		expect(args).not.toContain("--effort");
	});
});

describe("CONV_ID_RE", () => {
	it("accepts UUID stems, rejects leading-dash injection", () => {
		expect(CONV_ID_RE.test("9e6fdc2f-f9f9-4096-95fc-7852528b50cc")).toBe(true);
		expect(CONV_ID_RE.test("--dangerous")).toBe(false);
		expect(CONV_ID_RE.test("")).toBe(false);
	});
});

describe("conversation discovery", () => {
	it("snapshots .db stems and finds the single new one", () => {
		const dir = mkdtempSync(join(tmpdir(), "agy-conv-"));
		writeFileSync(join(dir, "old.db"), "");
		const before = snapshotConversations(dir);
		expect(before.has("old")).toBe(true);

		writeFileSync(join(dir, "new.db"), "");
		expect(newConversationId(dir, before)).toBe("new");
	});

	it("refuses to guess when several new ids appear and no resolver disambiguates", () => {
		const dir = mkdtempSync(join(tmpdir(), "agy-conv-"));
		const before = snapshotConversations(dir);
		writeFileSync(join(dir, "a.db"), "");
		writeFileSync(join(dir, "b.db"), "");
		expect(newConversationId(dir, before)).toBeNull();
		// With a resolver that positively identifies one AND the spawned pid
		// (the resolver only engages alongside a pid), the pick is exact.
		expect(newConversationId(dir, before, { pid: 1, resolveOpenDb: () => "b" })).toBe("b");
		// A resolver naming an id outside the candidate set fails safe.
		expect(newConversationId(dir, before, { pid: 1, resolveOpenDb: () => "old" })).toBeNull();
	});

	it("returns null when nothing new appeared", () => {
		const dir = mkdtempSync(join(tmpdir(), "agy-conv-"));
		writeFileSync(join(dir, "old.db"), "");
		const before = snapshotConversations(dir);
		expect(newConversationId(dir, before)).toBeNull();
	});

	it("signals onAmbiguous only when ids appeared but the bind stayed unresolved", () => {
		// pi-antigravity-bridge's tested hook: callers bound their retry budget
		// to the genuinely-ambiguous case, not to the ordinary not-yet case.
		const dir = mkdtempSync(join(tmpdir(), "agy-conv-"));
		const before = snapshotConversations(dir);
		let calls = 0;
		const count = () => calls++;

		// Nothing new yet: not ambiguous.
		newConversationId(dir, before, { onAmbiguous: count });
		expect(calls).toBe(0);

		// Exactly one new id binds cleanly: not ambiguous.
		writeFileSync(join(dir, "ours.db"), "");
		expect(newConversationId(dir, before, { onAmbiguous: count })).toBe("ours");
		expect(calls).toBe(0);

		// Several new ids, resolver empty: ambiguous and unresolved.
		writeFileSync(join(dir, "a.db"), "");
		writeFileSync(join(dir, "b.db"), "");
		expect(
			newConversationId(dir, before, { pid: 1, resolveOpenDb: () => null, onAmbiguous: count }),
		).toBeNull();
		expect(calls).toBe(1);

		// Resolver succeeds: resolved, not ambiguous.
		expect(
			newConversationId(dir, before, { pid: 1, resolveOpenDb: () => "b", onAmbiguous: count }),
		).toBe("b");
		expect(calls).toBe(1);
	});

	it("procTreeOpenDbResolver refuses to guess outside its contract", () => {
		// <=1 candidate: nothing to disambiguate.
		expect(procTreeOpenDbResolver(1, os.tmpdir(), new Set())).toBeNull();
		expect(procTreeOpenDbResolver(1, os.tmpdir(), new Set(["only"]))).toBeNull();
	});
});
