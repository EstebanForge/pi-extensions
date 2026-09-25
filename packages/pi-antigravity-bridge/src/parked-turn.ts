// Parked-turn stall probe (stream-json engine only).
//
// The stall guard fails a turn after N minutes of stdout silence. But agy
// sometimes finishes its answer without streaming it (parked turn): the
// response only ever lands in the conversation's brain transcript. Before
// failing, this module reads the transcript tail and looks for a DONE,
// MODEL-sourced final-response step written DURING the turn. One found, the
// driver can settle the turn OK with the withheld answer instead of
// throwing away finished work.
//
// Live-verified format (agy 1.2.10, transcript_full.jsonl last line):
//   {"step_index":1,"source":"MODEL","type":"PLANNER_RESPONSE",
//    "status":"DONE","created_at":"2026-09-08T16:11:43Z","content":"..."}
// A corpus sweep (2026-09-24, 9205 response steps across all local
// transcripts) shows PLANNER_RESPONSE is the only *RESPONSE type agy
// writes, so the gate matches it exactly. A deeper sweep during the agy
// peer review (2026-09-25, 9547 steps) found 96.6% of PLANNER_RESPONSE
// steps carry tool_calls — they are intermediate plan-and-act steps whose
// content is status text ("Running test..."), NOT answers. The probe
// therefore requires the NEWEST step written during the turn to be a
// clean, tool-free response; any other newer step means the turn was
// still mid-flight. If a future agy renames the type, the probe degrades
// to the old stall-fail — the safe direction.
// The ACP engine writes no transcript under its brain tree (probed
// 2026-09-24) and reports turn completion itself, so this probe is
// deliberately stream-json-only.

import { open } from "node:fs/promises";
import { agyConversationDir } from "./agy-paths.js";

/** How much of the transcript tail to read. One final step is a few KiB;
 *  512KiB covers it plus slack for big tool-step lines above it. */
export const PARKED_PROBE_MAX_BYTES = 512 * 1024;

/** Clock tolerance for "written during the turn": transcript timestamps are
 *  second-precision and may come from a slightly skewed source. */
const CREATED_AT_TOLERANCE_MS = 2_000;

/** Pull the parked answer out of a transcript tail. Scans from the END;
 *  the FIRST step written during the turn decides: a clean, tool-free DONE
 *  MODEL response yields its content; any other step from the turn (tool
 *  output, error, plan step with tool_calls) means no answer landed and
 *  the probe returns undefined. Steps older than the turn (clock tolerance
 *  2s) end the scan. Malformed or foreign lines are skipped without
 *  deciding. Pure; exported for tests. */
export function extractParkedAnswer(
	tail: string,
	turnStartedMs: number,
): string | undefined {
	const lines = tail.split("\n");
	for (let i = lines.length - 1; i >= 0; i -= 1) {
		const line = lines[i]?.trim();
		if (!line) continue;
		let step: {
			source?: unknown;
			type?: unknown;
			status?: unknown;
			created_at?: unknown;
			content?: unknown;
			tool_calls?: unknown;
		};
		try {
			step = JSON.parse(line) as typeof step;
		} catch {
			continue;
		}
		if (typeof step.created_at !== "string") continue;
		const createdAtMs = Date.parse(step.created_at);
		if (Number.isNaN(createdAtMs)) continue;
		if (createdAtMs < turnStartedMs - CREATED_AT_TOLERANCE_MS) break;

		// The newest step written during this turn must be a completed MODEL
		// response without tool calls. Intermediate tool steps, errors, or
		// non-terminal responses mean the turn did not finish with a parked answer.
		if (step.source !== "MODEL" || step.status !== "DONE") return undefined;
		if (step.type !== "PLANNER_RESPONSE") return undefined;
		if (Array.isArray(step.tool_calls) && step.tool_calls.length > 0) return undefined;
		if (typeof step.content !== "string" || step.content.length === 0) return undefined;
		return step.content;
	}
	return undefined;
}

/** Read at most `maxBytes` from the end of a file. Empty string on any
 *  error (missing file, permission, ...) — the caller degrades to the old
 *  stall-fail behavior. */
export async function readTranscriptTail(filePath: string, maxBytes: number): Promise<string> {
	let handle;
	try {
		handle = await open(filePath, "r");
	} catch {
		return "";
	}
	try {
		const { size } = await handle.stat();
		const start = Math.max(0, size - maxBytes);
		const length = size - start;
		const buffer = Buffer.alloc(length);
		let read = 0;
		while (read < length) {
			const { bytesRead } = await handle.read(buffer, read, length - read, start + read);
			if (bytesRead === 0) break;
			read += bytesRead;
		}
		return buffer.subarray(0, read).toString("utf8");
	} catch {
		return "";
	} finally {
		await handle.close().catch(() => {});
	}
}

/** Probe one stream-json conversation's transcript for a parked answer.
 *  Undefined whenever nothing usable is found (missing transcript, no DONE
 *  step from this turn) — never throws; the stall guard must not fail. */
export async function parkedTurnAnswer(
	conversationId: string,
	turnStartedMs: number,
	home: string | undefined = undefined,
): Promise<string | undefined> {
	const transcript = `${agyConversationDir("stream-json", conversationId, home)}/.system_generated/logs/transcript_full.jsonl`;
	const tail = await readTranscriptTail(transcript, PARKED_PROBE_MAX_BYTES);
	if (tail === "") return undefined;
	return extractParkedAnswer(tail, turnStartedMs);
}
