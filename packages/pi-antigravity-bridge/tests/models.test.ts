// Unit tests for the models catalog cache (src/models.ts).
//
// Covers read/writeModelsCache round-trip + validation, and the three
// loadModelCatalogRaw branches (fresh -> no spawn, no-cache -> spawn + persist,
// stale -> serve cached + background refresh). Spawning uses a temp fake `agy`
// binary so no real agy is needed.
// Run: npm test

import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "vitest";
import {
	entriesFromRaw,
	loadModelCatalogRaw,
	MODELS_CACHE_TTL_MS,
	MODELS_OUTPUT_CAP_BYTES,
	refreshModelsInBackground,
	spawnAgyModelsRaw,
	toPiModel,
} from "../src/models.js";

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

/** Temp cache path unique per test (avoids touching the real user cache). */
function tempCachePath(): string {
	return path.join(fs.mkdtempSync(path.join(os.tmpdir(), "agy-models-cache-")), "models-cache.json");
}

/** A fake `agy` binary that prints `output` (ignoring args), executable. */
function makeFakeAgy(output: string): string {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), "agy-fake-"));
	const bin = path.join(dir, "agy");
	// printf so embedded newlines/quotes survive; no trailing newline (the
	// cache logic under test is newline-agnostic; entriesFromRaw trims anyway).
	fs.writeFileSync(bin, `#!/bin/sh\nprintf '%s' ${JSON.stringify(output)}\n`, {
		mode: 0o755,
	});
	return bin;
}

/** Read raw field from a cache file, or null if missing/unparseable. */
function readCacheRaw(cachePath: string): string | null {
	try {
		return (JSON.parse(fs.readFileSync(cachePath, "utf8")) as { raw?: string }).raw ?? null;
	} catch {
		return null;
	}
}

/** Poll a cache file until its raw matches `expected`, or fail after timeout. */
async function waitForCacheRaw(cachePath: string, expected: string, timeoutMs = 2000): Promise<void> {
	const deadline = Date.now() + timeoutMs;
	while (Date.now() < deadline) {
		if (readCacheRaw(cachePath) === expected) return;
		await sleep(20);
	}
	assert.fail(`cache did not update to ${JSON.stringify(expected)} (got ${JSON.stringify(readCacheRaw(cachePath))})`);
}

// --- TTL constant -----------------------------------------------------------

test("MODELS_CACHE_TTL_MS is 5 minutes", () => {
	assert.equal(MODELS_CACHE_TTL_MS, 5 * 60_000);
});

// --- loadModelCatalogRaw: fresh cache -> no spawn ---------------------------

test("loadModelCatalogRaw: fresh cache is returned without spawning agy", async () => {
	const cachePath = tempCachePath();
	// Seed a fresh cache whose raw differs from what the fake binary prints, so a
	// spawn would be detectable as a changed return value.
	fs.writeFileSync(cachePath, JSON.stringify({ raw: "CACHED", savedAt: Date.now() }));
	const bin = makeFakeAgy("FRESH");

	const raw = await loadModelCatalogRaw(bin, cachePath);
	assert.equal(raw, "CACHED"); // served from cache, spawn did not run
});

// --- loadModelCatalogRaw: no cache -> spawn + persist -----------------------

test("loadModelCatalogRaw: no cache spawns agy and persists the result", async () => {
	const cachePath = tempCachePath();
	const bin = makeFakeAgy("Gemini 3.6 Flash (Medium)");

	const raw = await loadModelCatalogRaw(bin, cachePath);
	assert.equal(raw, "Gemini 3.6 Flash (Medium)");
	assert.equal(readCacheRaw(cachePath), "Gemini 3.6 Flash (Medium)"); // persisted
});

// --- loadModelCatalogRaw: stale cache -> serve + background refresh ---------

test("loadModelCatalogRaw: stale cache is served instantly, then refreshed in background", async () => {
	const cachePath = tempCachePath();
	// Stale: savedAt well past the TTL.
	const staleSavedAt = Date.now() - MODELS_CACHE_TTL_MS - 60_000;
	fs.writeFileSync(cachePath, JSON.stringify({ raw: "OLD", savedAt: staleSavedAt }));
	const bin = makeFakeAgy("NEW");

	const raw = await loadModelCatalogRaw(bin, cachePath);
	assert.equal(raw, "OLD"); // returned the stale cache without waiting

	// The background refresh updates the cache for the next load.
	await waitForCacheRaw(cachePath, "NEW");
});

// --- refreshModelsInBackground: writes the cache on success -----------------

test("refreshModelsInBackground: persists agy output to the cache", async () => {
	const cachePath = tempCachePath();
	const bin = makeFakeAgy("BG-RESULT");
	refreshModelsInBackground(bin, cachePath);
	await waitForCacheRaw(cachePath, "BG-RESULT");
});

// --- corrupt / missing cache -----------------------------------------------

test("loadModelCatalogRaw: corrupt cache is treated as no cache (spawns fresh)", async () => {
	const cachePath = tempCachePath();
	fs.writeFileSync(cachePath, "{not valid json");
	const bin = makeFakeAgy("RECOVERED");

	const raw = await loadModelCatalogRaw(bin, cachePath);
	assert.equal(raw, "RECOVERED");
	assert.equal(readCacheRaw(cachePath), "RECOVERED");
});

// --- entriesFromRaw: collapses effort-driven bases, keeps fixed models -------

// Gemini and Claude bases with >= 2 tier variants collapse to one BASE-slug
// entry whose `efforts` lists exactly what agy accepts (Pro keeps only
// low/high; Claude 5.5 ships low/medium/high). Models with 0 or 1 tier
// variants keep agy's exact qualified slug: fixed thinking, where --effort is
// unsupported.
test("entriesFromRaw: collapses Gemini and Claude bases, keeps fixed models", () => {
	const raw = [
		"gemini-3.8-flash-high",
		"gemini-3.8-flash-medium",
		"gemini-3.8-flash-low",
		"gemini-3.6-flash-high",
		"gemini-3.6-flash-medium",
		"gemini-3.6-flash-low",
		"gemini-3.1-pro-high",
		"gemini-3.1-pro-low",
		"claude-sonnet-5-5-low",
		"claude-sonnet-5-5-medium",
		"claude-sonnet-5-5-high",
		"claude-opus-5-5-low",
		"claude-opus-5-5-medium",
		"claude-opus-5-5-high",
		"gpt-oss-120b-medium",
	].join("\n");
	const summary = entriesFromRaw(raw).map((e) =>
		e.efforts ? `${e.id}[${e.efforts.join("/")}]` : e.id,
	);
	assert.deepEqual(summary, [
		"gemini-3-8-flash[low/medium/high]",
		"gemini-3-6-flash[low/medium/high]",
		"gemini-3-1-pro[low/high]",
		"claude-sonnet-5-5[low/medium/high]",
		"claude-opus-5-5[low/medium/high]",
		"gpt-oss-120b-medium",
	]);
});

test("entriesFromRaw: trims and drops blank lines, keeps order", () => {
	const ids = entriesFromRaw("\n  claude-sonnet-5-5-high  \n\n").map((e) => e.id);
	assert.deepEqual(ids, ["claude-sonnet-5-5-high"]);
});

// Banner/auth lines and leading-dash tokens must never become models (the
// latter would reach agy's flag parser as --model -high). Non-gemini families
// with >= 2 tier variants stay qualified: only verified effort-capable
// families collapse, so an unknown or fixed-thinking family degrades safely.
test("entriesFromRaw: drops noise/leading-dash lines; non-gemini families stay qualified", () => {
	const raw = [
		"Available models:",
		"-high",
		"gemini-3.6-flash-high",
		"gemini-3.6-flash-low",
		"futuremodel-x-low",
		"futuremodel-x-high",
	].join("\n");
	const summary = entriesFromRaw(raw).map((e) =>
		e.efforts ? `${e.id}[${e.efforts.join("/")}]` : e.id,
	);
	assert.deepEqual(summary, [
		"gemini-3-6-flash[low/high]",
		"futuremodel-x-low",
		"futuremodel-x-high",
	]);
});

// agy prints TWO columns: "<slug>  <display label>". --model takes only the
// slug (col 1); the label is display-only and must never reach --model. This
// is the REAL `agy models` stdout shape (verified live), distinct from the
// bare-slug fixtures above, which document format tolerance (a line with no
// whitespace splits to col1 = itself, so bare slugs still parse).
test("entriesFromRaw: splits slug from label in agy's real two-column output", () => {
	const raw = [
		"gemini-3.8-flash-high     Gemini 3.8 Flash (High)",
		"gemini-3.8-flash-medium   Gemini 3.8 Flash (Medium)",
		"gemini-3.8-flash-low      Gemini 3.8 Flash (Low)",
		"gemini-3.1-pro-high       Gemini 3.1 Pro (High)",
		"gemini-3.1-pro-low        Gemini 3.1 Pro (Low)",
		"claude-opus-5-5-low       Claude Opus 5.5 (Low)",
		"claude-opus-5-5-medium    Claude Opus 5.5 (Medium)",
		"claude-opus-5-5-high      Claude Opus 5.5 (High)",
		"claude-sonnet-5-5-low     Claude Sonnet 5.5 (Low)",
		"claude-sonnet-5-5-medium  Claude Sonnet 5.5 (Medium)",
		"claude-sonnet-5-5-high    Claude Sonnet 5.5 (High)",
		"gpt-oss-120b-medium       GPT-OSS 120B (Medium)",
	].join("\n");
	const summary = entriesFromRaw(raw).map((e) =>
		e.efforts ? `${e.id}[${e.efforts.join("/")}]` : e.id,
	);
	assert.deepEqual(summary, [
		"gemini-3-8-flash[low/medium/high]",
		"gemini-3-1-pro[low/high]",
		"claude-opus-5-5[low/medium/high]",
		"claude-sonnet-5-5[low/medium/high]",
		"gpt-oss-120b-medium",
	]);
});

// A banner word split from its line (col1 = "Available") is NOT a model slug.
// Real agy slugs always contain a hyphen (family-version-name); requiring one
// keeps prose banners out once we split columns (the old whole-line space
// rejection no longer applies after the col1 split).
test("entriesFromRaw: two-column output drops banner tokens lacking a hyphen", () => {
	const raw = [
		"Available models:",
		"gemini-3.6-flash-high   Gemini 3.6 Flash (High)",
		"gemini-3.6-flash-low    Gemini 3.6 Flash (Low)",
	].join("\n");
	const summary = entriesFromRaw(raw).map((e) => e.id);
	assert.deepEqual(summary, ["gemini-3-6-flash"]);
});

// --- toPiModel: toggle + level restriction follow the base's tiers -----------

test("toPiModel: effort-driven base shows toggle restricted to its tiers", () => {
	const flash = toPiModel({
		full: "gemini-3.6-flash",
		id: "gemini-3-6-flash",
		efforts: ["low", "medium", "high"],
	});
	const pro = toPiModel({
		full: "gemini-3.1-pro",
		id: "gemini-3-1-pro",
		efforts: ["low", "high"],
	});
	const claude = toPiModel({
		full: "claude-sonnet-5-5",
		id: "claude-sonnet-5-5",
		efforts: ["low", "medium", "high"],
	});
	const gptoss = toPiModel({ full: "gpt-oss-120b-medium", id: "gpt-oss-120b-medium" });

	assert.equal(flash.reasoning, true);
	assert.equal(pro.reasoning, true);
	assert.equal(claude.reasoning, true);
	assert.equal(gptoss.reasoning, false);

	// off/minimal always hidden (agy has no no-thinking); Pro also hides medium.
	assert.deepEqual(flash.thinkingLevelMap, { off: null, minimal: null });
	assert.deepEqual(pro.thinkingLevelMap, { off: null, minimal: null, medium: null });
	assert.deepEqual(claude.thinkingLevelMap, { off: null, minimal: null });
	assert.equal(gptoss.thinkingLevelMap, undefined);
});

// --- spawnAgyModelsRaw stdout cap -------------------------------------------

/** Fake `agy` that streams `chunks` x 64KiB of 'x' to stdout in 64KiB writes,
 *  then exits 0. Chunked (not one printf) so the cap fires while the process
 *  is still alive and the kill path is exercised, not a natural exit. */
function makeStreamingFakeAgy(chunks: number): string {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), "agy-fake-"));
	const bin = path.join(dir, "agy");
	fs.writeFileSync(
		bin,
		"#!/bin/sh\n" +
			"i=0\n" +
			`while [ $i -lt ${chunks} ]; do\n` +
			"  head -c 65536 /dev/zero | tr '\\0' x\n" +
			"  i=$((i+1))\n" +
			"done\n",
		{ mode: 0o755 },
	);
	return bin;
}

test("spawnAgyModelsRaw kills a runaway stream past the cap and fails closed", async () => {
	// 40 chunks = 2.5MiB, well past MODELS_OUTPUT_CAP_BYTES.
	const bin = makeStreamingFakeAgy(40);
	const raw = await spawnAgyModelsRaw(bin);
	assert.equal(raw, "");
});

test("spawnAgyModelsRaw keeps output at exactly the cap (strict > boundary)", async () => {
	// 16 chunks = 1MiB exactly: must pass through untouched, exit 0.
	const bin = makeStreamingFakeAgy(16);
	const raw = await spawnAgyModelsRaw(bin);
	assert.equal(raw.length, MODELS_OUTPUT_CAP_BYTES);
	assert.match(raw, /^x+$/);
});
