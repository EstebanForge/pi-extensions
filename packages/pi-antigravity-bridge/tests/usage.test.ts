// Unit tests for the quota view (src/usage.ts).
//
// The fixture is the live-captured `agy --print /usage --output-format json`
// payload (agy 1.2.10, zero tokens spent), pinned as an object and
// stringified so structural drift in agy's payload fails these tests. Parse
// tolerance (envelope, aliases, clamping), render (bar, reset label, 5h
// before weekly), and the fetch degrade contract are all covered.
// Run: npm test

import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "vitest";
import {
	fetchAgyQuota,
	formatAgyQuotaReport,
	parseAgyUsageJson,
	quotaBar,
	resetLabel,
} from "../src/usage.js";

/** Live-verified payload shape (probe 2026-09-24, agy 1.2.10). */
const REAL_PAYLOAD = JSON.stringify({
	conversation_id: "",
	status: "SUCCESS",
	response: "Gemini Models\tWeekly Limit Remaining\t90%\t2026-09-30T23:20:40Z\n",
	duration_seconds: 0,
	num_turns: 0,
	usage: { input_tokens: 0, output_tokens: 0, total_tokens: 0 },
	command: {
		name: "usage",
		data: {
			description: "Within each group, models share a weekly limit and a 5-hour limit.",
			groups: [
				{
					name: "Gemini Models",
					description: "Models within this group: Gemini Flash, Gemini Pro",
					buckets: [
						{
							id: "gemini-weekly",
							name: "Weekly Limit Remaining",
							window: "weekly",
							remaining_fraction: 0.8991343975067139,
							reset_time: "2026-09-30T23:20:40Z",
						},
						{ id: "gemini-5h", name: "Five Hour Limit Remaining", window: "5h", remaining_fraction: 1, reset_time: "2026-09-25T01:36:24Z" },
					],
				},
				{
					name: "Claude and GPT models",
					buckets: [
						{ id: "3p-weekly", name: "Weekly Limit Remaining", window: "weekly", remaining_fraction: 1, reset_time: "2026-10-01T20:36:24Z" },
						{ id: "3p-5h", name: "Five Hour Limit Remaining", window: "5h", remaining_fraction: 1, reset_time: "2026-09-25T01:36:24Z" },
					],
				},
			],
		},
	},
});

function makeFakeBinary(output: string): string {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), "agy-usage-fake-"));
	const bin = path.join(dir, "agy");
	// Byte-exact cat (not printf %b): the JSON payload is full of backslash
	// escapes that %b would rewrite into invalid JSON.
	fs.writeFileSync(path.join(dir, "out.txt"), output);
	fs.writeFileSync(bin, `#!/bin/sh\ncat ${JSON.stringify(path.join(dir, "out.txt"))}\n`, { mode: 0o755 });
	return bin;
}

// --- parseAgyUsageJson -------------------------------------------------------

test("parseAgyUsageJson: the live payload parses fully", () => {
	const report = parseAgyUsageJson(REAL_PAYLOAD);
	assert.equal(report.groups.length, 2);
	const [gemini] = report.groups;
	assert.equal(gemini.name, "Gemini Models");
	assert.equal(gemini.buckets.length, 2);
	const weekly = gemini.buckets.find((b) => b.window === "weekly");
	assert.equal(weekly?.remainingFraction, 0.8991343975067139);
	assert.equal(weekly?.resetTime, "2026-09-30T23:20:40Z");
});

test("parseAgyUsageJson: stream-json result envelope unwrapped", () => {
	const wrapped = JSON.stringify({ event: "result", result: JSON.parse(REAL_PAYLOAD) });
	const report = parseAgyUsageJson(wrapped);
	assert.equal(report.groups.length, 2);
});

test("parseAgyUsageJson: camelCase aliases accepted", () => {
	const payload = JSON.stringify({
		status: "OK",
		command: {
			name: "usage",
			data: {
				groups: [
					{
						name: "G",
						buckets: [{ name: "B", window: "weekly", remainingFraction: 0.5, resetTime: "2026-10-01T00:00:00Z" }],
					},
				],
			},
		},
	});
	const report = parseAgyUsageJson(payload);
	assert.equal(report.groups[0]?.buckets[0]?.remainingFraction, 0.5);
	assert.equal(report.groups[0]?.buckets[0]?.resetTime, "2026-10-01T00:00:00Z");
});

test("parseAgyUsageJson: fractions clamp into [0,1]", () => {
	const payload = JSON.stringify({
		status: "SUCCESS",
		command: { name: "usage", data: { groups: [{ name: "G", buckets: [{ name: "B", window: "5h", remaining_fraction: 1.5 }] }] } },
	});
	assert.equal(parseAgyUsageJson(payload).groups[0]?.buckets[0]?.remainingFraction, 1);
});

test("parseAgyUsageJson: structural failures throw short reasons", () => {
	assert.throws(() => parseAgyUsageJson("not json"), /not JSON/);
	assert.throws(() => parseAgyUsageJson('{"status":"FAILED"}'), /FAILED/);
	assert.throws(() => parseAgyUsageJson('{"status":"SUCCESS","command":{"name":"models"}}'), /not a \/usage/);
	assert.throws(
		() => parseAgyUsageJson('{"status":"SUCCESS","command":{"name":"usage","data":{"groups":[]}}}'),
		/no quota groups/,
	);
});

// --- quotaBar / resetLabel ---------------------------------------------------

test("quotaBar: 20 segments, filled proportionally", () => {
	assert.equal(quotaBar(1), "█".repeat(20));
	assert.equal(quotaBar(0), "░".repeat(20));
	assert.equal(quotaBar(0.5), `${"█".repeat(10)}${"░".repeat(10)}`);
	assert.equal(quotaBar(0.8991343975067139).length, 20);
});

test("resetLabel: same-day clock, other-day date, invalid empty", () => {
	// 2026-09-24 is a Thursday; both instants are local-time formatted.
	const now = new Date(2026, 8, 24, 15, 0);
	assert.equal(resetLabel(new Date(2026, 8, 24, 19, 53).toISOString(), now), "resets 19:53");
	assert.equal(resetLabel(new Date(2026, 8, 30, 9, 10).toISOString(), now), "resets 09:10 on 30 Sep");
	assert.equal(resetLabel("garbage", now), "");
});

// --- formatAgyQuotaReport ----------------------------------------------------

test("formatAgyQuotaReport: 5h before weekly, percent and reset rendered", () => {
	const report = parseAgyUsageJson(REAL_PAYLOAD);
	const out = formatAgyQuotaReport(report, new Date(2026, 8, 24, 15, 0));
	assert.match(out, /Antigravity quota/);
	// Within each group the 5h line must precede the weekly line.
	for (const groupLine of out.split("\n").filter((l) => l && !l.startsWith(" "))) {
		const start = out.indexOf(groupLine);
		const five = out.indexOf("Five Hour", start);
		const weekly = out.indexOf("Weekly Limit", start);
		if (five !== -1 && weekly !== -1) assert.ok(five < weekly);
	}
	assert.match(out, /90%/);
});

// --- fetchAgyQuota -----------------------------------------------------------

test("fetchAgyQuota: fake binary end-to-end", async () => {
	const bin = makeFakeBinary(REAL_PAYLOAD);
	const report = await fetchAgyQuota(bin);
	assert.equal(report?.groups.length, 2);
});

test("fetchAgyQuota: missing binary or junk degrades to undefined", async () => {
	const missing = path.join(os.tmpdir(), `agy-missing-${process.pid}-${Math.random()}`);
	assert.equal(await fetchAgyQuota(missing), undefined);
	const junk = makeFakeBinary("welcome to agy! enter your password:");
	assert.equal(await fetchAgyQuota(junk), undefined);
});
