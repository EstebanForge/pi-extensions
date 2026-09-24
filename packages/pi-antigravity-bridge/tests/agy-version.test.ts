// Unit tests for the agy CLI version gate (src/agy-version.ts).
//
// Covers triple parsing (bare, prefixed, banner, missing), numeric compare,
// the verdict classifier for every status, and the memoized subprocess check
// against fake binaries (ok / unsupported / development / invalid /
// unavailable / memoization). No real agy needed.
// Run: npm test

import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "vitest";
import {
	agyVersionVerdict,
	checkAgyCliVersion,
	compareVersionTuples,
	describeAgyVersionCheck,
	MIN_AGY_VERSION,
	parseAgyVersionTriple,
	resetAgyVersionCache,
} from "../src/agy-version.js";

/** A fake binary printing `output` to stdout and exiting 0. */
function makeFakeBinary(output: string): string {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), "agy-ver-fake-"));
	const bin = path.join(dir, "agy");
	fs.writeFileSync(bin, `#!/bin/sh\nprintf '%s' ${JSON.stringify(output)}\n`, {
		mode: 0o755,
	});
	return bin;
}

// --- parseAgyVersionTriple ---------------------------------------------------

test("parseAgyVersionTriple: bare, prefixed, banner, missing", () => {
	assert.equal(parseAgyVersionTriple("1.2.10"), "1.2.10");
	assert.equal(parseAgyVersionTriple("agy_acp_server_1.1.1"), "1.1.1");
	assert.equal(parseAgyVersionTriple("agy version 1.1.22 (build abc)"), "1.1.22");
	assert.equal(parseAgyVersionTriple("dev"), undefined);
	assert.equal(parseAgyVersionTriple(""), undefined);
	assert.equal(parseAgyVersionTriple("version one.two.three"), undefined);
});

// --- compareVersionTuples ----------------------------------------------------

test("compareVersionTuples: numeric, not lexicographic", () => {
	assert.equal(compareVersionTuples("1.1.22", "1.1.22"), 0);
	assert.equal(compareVersionTuples("1.2.10", "1.1.22"), 1);
	assert.equal(compareVersionTuples("1.1.21", "1.1.22"), -1);
	assert.equal(compareVersionTuples("1.10.0", "1.9.9"), 1);
	assert.equal(compareVersionTuples("2.0.0", "1.99.99"), 1);
});

// --- agyVersionVerdict -------------------------------------------------------

test("agyVersionVerdict: ok at and above the floor", () => {
	assert.equal(agyVersionVerdict("1.1.22").status, "ok");
	assert.equal(agyVersionVerdict("1.2.10").status, "ok");
	assert.equal(agyVersionVerdict("1.1.22").version, "1.1.22");
});

test("agyVersionVerdict: unsupported below the floor", () => {
	const v = agyVersionVerdict("1.1.21");
	assert.equal(v.status, "unsupported");
	assert.equal(v.version, "1.1.21");
});

test("agyVersionVerdict: development builds never gate", () => {
	assert.equal(agyVersionVerdict("dev").status, "development");
	assert.equal(agyVersionVerdict("HEAD-12345").status, "development");
	assert.equal(agyVersionVerdict("development build 1.0.0").status, "development");
	// A dev token plus an old triple still reads as development.
	assert.equal(agyVersionVerdict("1.0.0-dev").status, "development");
});

test("agyVersionVerdict: invalid when no triple", () => {
	assert.equal(agyVersionVerdict("").status, "invalid");
	assert.equal(agyVersionVerdict("hello world").status, "invalid");
});

test("agyVersionVerdict: custom floor", () => {
	assert.equal(agyVersionVerdict("1.2.10", "1.3.0").status, "unsupported");
	assert.equal(agyVersionVerdict("1.3.0", "1.3.0").status, "ok");
	assert.equal(MIN_AGY_VERSION, "1.1.22");
});

// --- checkAgyCliVersion (fake binaries) --------------------------------------

test("checkAgyCliVersion: ok, unsupported, development, invalid", async () => {
	assert.equal((await checkAgyCliVersion(makeFakeBinary("1.2.10"))).status, "ok");
	assert.equal((await checkAgyCliVersion(makeFakeBinary("1.0.9"))).status, "unsupported");
	assert.equal((await checkAgyCliVersion(makeFakeBinary("dev build"))).status, "development");
	assert.equal((await checkAgyCliVersion(makeFakeBinary("nonsense"))).status, "invalid");
});

test("checkAgyCliVersion: unavailable for missing binary", async () => {
	const missing = path.join(os.tmpdir(), `agy-missing-${process.pid}-${Math.random()}`);
	assert.equal((await checkAgyCliVersion(missing)).status, "unavailable");
});

test("checkAgyCliVersion: memoized per binary until reset", async () => {
	resetAgyVersionCache();
	const bin = makeFakeBinary("1.2.10");
	const first = await checkAgyCliVersion(bin);
	const second = await checkAgyCliVersion(bin);
	assert.equal(first, second);
	resetAgyVersionCache();
	const third = await checkAgyCliVersion(bin);
	assert.notEqual(first, third);
	assert.equal(third.status, "ok");
});

// --- describeAgyVersionCheck -------------------------------------------------

test("describeAgyVersionCheck: every status renders", () => {
	assert.equal(describeAgyVersionCheck({ status: "ok", version: "1.2.10", raw: "" }), "1.2.10");
	assert.equal(
		describeAgyVersionCheck({ status: "unsupported", version: "1.0.9", raw: "" }),
		"1.0.9 TOO OLD",
	);
	assert.equal(describeAgyVersionCheck({ status: "development", raw: "" }), "development build");
	assert.equal(describeAgyVersionCheck({ status: "invalid", raw: "" }), "unreadable version output");
	assert.equal(describeAgyVersionCheck({ status: "unavailable", raw: "" }), "could not run --version");
});
