// Unit tests for the parked-turn stall probe (src/parked-turn.ts).
// The line fixture is the LIVE format captured from agy 1.2.10
// (transcript_full.jsonl last line, 2026-09-08). Run: npm test

import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "vitest";
import {
	extractParkedAnswer,
	parkedTurnAnswer,
	readTranscriptTail,
	PARKED_PROBE_MAX_BYTES,
} from "../src/parked-turn.js";

/** Live format: DONE MODEL response step. */
function doneStep(content: string, createdAtIso: string): string {
	return JSON.stringify({
		step_index: 1,
		source: "MODEL",
		type: "PLANNER_RESPONSE",
		status: "DONE",
		created_at: createdAtIso,
		content,
	});
}

const START = Date.parse("2026-09-08T16:11:40Z");

// --- extractParkedAnswer -----------------------------------------------------

test("extractParkedAnswer: live-format DONE step newer than the turn start", () => {
	const tail = `${doneStep("Ready. What are we building?", "2026-09-08T16:11:43Z")}\n`;
	assert.equal(extractParkedAnswer(tail, START), "Ready. What are we building?");
});

test("extractParkedAnswer: steps from before the turn are ignored (beyond tolerance)", () => {
	const tail = `${doneStep("old answer", "2026-09-08T16:10:00Z")}\n`;
	assert.equal(extractParkedAnswer(tail, START), undefined);
});

test("extractParkedAnswer: two-second clock tolerance accepts a just-before step", () => {
	// 1.5s before turn start: second-precision timestamps skew; accept.
	const tail = `${doneStep("fresh answer", "2026-09-08T16:11:38.5Z")}\n`;
	assert.equal(extractParkedAnswer(tail, START), "fresh answer");
});

test("extractParkedAnswer: non-DONE, non-MODEL, non-response and empty steps ignored", () => {
	const lines = [
		JSON.stringify({ source: "MODEL", type: "PLANNER_RESPONSE", status: "RUN", created_at: "2026-09-08T16:11:43Z", content: "x" }),
		JSON.stringify({ source: "USER", type: "PLANNER_RESPONSE", status: "DONE", created_at: "2026-09-08T16:11:43Z", content: "x" }),
		JSON.stringify({ source: "MODEL", type: "TOOL_EXECUTION", status: "DONE", created_at: "2026-09-08T16:11:43Z", content: "x" }),
		JSON.stringify({ source: "MODEL", type: "PLANNER_RESPONSE", status: "DONE", created_at: "2026-09-08T16:11:43Z", content: "" }),
	];
	assert.equal(extractParkedAnswer(lines.join("\n"), START), undefined);
});

test("extractParkedAnswer: newest matching step wins, junk lines skipped", () => {
	const lines = [
		doneStep("first", "2026-09-08T16:11:42Z"),
		"{not json",
		"",
		doneStep("second", "2026-09-08T16:11:44Z"),
	];
	assert.equal(extractParkedAnswer(lines.join("\n"), START), "second");
});

test("extractParkedAnswer: missing or unparseable created_at is skipped", () => {
	const lines = [
		JSON.stringify({ source: "MODEL", type: "PLANNER_RESPONSE", status: "DONE", content: "no stamp" }),
		JSON.stringify({ source: "MODEL", type: "PLANNER_RESPONSE", status: "DONE", created_at: "not-a-date", content: "bad stamp" }),
	];
	assert.equal(extractParkedAnswer(lines.join("\n"), START), undefined);
});

test("extractParkedAnswer: tail of pure junk returns undefined", () => {
	assert.equal(extractParkedAnswer("{broken\nnot json at all\n\n", START), undefined);
});

test("extractParkedAnswer: escaped newlines and unicode in content survive", () => {
	// A well-formed JSONL writer escapes \n inside values; the answer must
	// come back with the real newline and unicode intact.
	const tail = `${doneStep("line1\nline2 — café ✓", "2026-09-08T16:11:43Z")}\n`;
	assert.equal(extractParkedAnswer(tail, START), "line1\nline2 — café ✓");
});

test("extractParkedAnswer: steps with tool_calls are rejected as non-terminal", () => {
	const stepWithTools = JSON.stringify({
		source: "MODEL",
		type: "PLANNER_RESPONSE",
		status: "DONE",
		created_at: "2026-09-08T16:11:43Z",
		content: "Running test in background...",
		tool_calls: [{ name: "run_command", args: {} }],
	});
	assert.equal(extractParkedAnswer(`${stepWithTools}\n`, START), undefined);
});

test("extractParkedAnswer: trailing step in the same turn invalidates earlier response", () => {
	const earlierResponse = doneStep("Earlier text", "2026-09-08T16:11:42Z");
	const laterToolStep = JSON.stringify({
		source: "MODEL",
		type: "GENERIC",
		status: "ERROR",
		created_at: "2026-09-08T16:11:44Z",
		content: "Tool execution failed",
	});
	const tail = `${earlierResponse}\n${laterToolStep}\n`;
	assert.equal(extractParkedAnswer(tail, START), undefined);
});

// --- readTranscriptTail ------------------------------------------------------

test("readTranscriptTail: small file returns whole content, missing returns empty", async () => {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), "agy-parked-"));
	try {
		const file = path.join(dir, "t.jsonl");
		fs.writeFileSync(file, "a\nb\n");
		assert.equal(await readTranscriptTail(file, 100), "a\nb\n");
		assert.equal(await readTranscriptTail(path.join(dir, "nope"), 100), "");
	} finally {
		fs.rmSync(dir, { recursive: true, force: true });
	}
});

test("readTranscriptTail: large file returns only the last maxBytes", async () => {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), "agy-parked-"));
	try {
		const file = path.join(dir, "big.jsonl");
		fs.writeFileSync(file, "x".repeat(1000) + "TAIL\n");
		const tail = await readTranscriptTail(file, 5);
		assert.equal(tail, "TAIL\n");
	} finally {
		fs.rmSync(dir, { recursive: true, force: true });
	}
});

// --- parkedTurnAnswer --------------------------------------------------------

test("parkedTurnAnswer: end-to-end against a real brain-dir layout", async () => {
	const home = fs.mkdtempSync(path.join(os.tmpdir(), "agy-home-"));
	try {
		const logDir = path.join(
			home,
			".gemini",
			"antigravity-cli",
			"brain",
			"conv-1",
			".system_generated",
			"logs",
		);
		fs.mkdirSync(logDir, { recursive: true });
		fs.writeFileSync(path.join(logDir, "transcript_full.jsonl"), `${doneStep("parked!", "2026-09-08T16:11:43Z")}\n`);
		assert.equal(await parkedTurnAnswer("conv-1", START, home), "parked!");
		// No transcript -> undefined.
		assert.equal(await parkedTurnAnswer("conv-missing", START, home), undefined);
	} finally {
		fs.rmSync(home, { recursive: true, force: true });
	}
});

test("PARKED_PROBE_MAX_BYTES covers a final step with slack", () => {
	assert.ok(PARKED_PROBE_MAX_BYTES >= 512 * 1024);
});
