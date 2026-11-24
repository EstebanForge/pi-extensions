import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import type { Message } from "@earendil-works/pi-ai";
import {
	EMPTY_HISTORY_HASH,
	historyCheckpoint,
	historyInput,
	matchesCheckpoint,
	projectHistory,
	serializeHistory,
} from "../src/history-projection.js";

const sha = (text: string) => createHash("sha256").update(text).digest("hex");

const user = (text: string, ts = 1000): Message => ({ role: "user", content: text, timestamp: ts });
const assistant = (text: string, ts = 2000, stopReason = "stop"): Message => ({
	role: "assistant",
	content: [{ type: "text", text }],
	api: "agy-bridge" as never,
	provider: "antigravity" as never,
	model: "m",
	usage: {} as never,
	stopReason: stopReason as never,
	timestamp: ts,
});

describe("projectHistory", () => {
	it("projects text, merges adjacent text blocks, and skips empty ones", () => {
		const m: Message = { role: "user", content: [{ type: "text", text: "a" }, { type: "text", text: "b" }, { type: "text", text: "" }], timestamp: 1 };
		const { entries } = projectHistory([m]);
		expect(entries[0]!.content).toEqual([{ type: "text", text: "ab" }]);
	});

	it("excludes system messages and preserves sourceIndex gaps", () => {
		const { entries } = projectHistory([user("a", 1), { role: "system", content: "sys", timestamp: 2 } as Message, user("b", 3)]);
		expect(entries).toHaveLength(2);
		expect(entries[0]!.sourceIndex).toBe(0);
		expect(entries[1]!.sourceIndex).toBe(2);
	});

	it("hashes images over decoded bytes, not base64 text", () => {
		// "hi" and its re-encoded padded form hash identically as bytes.
		const data = Buffer.from("hi").toString("base64");
		const m: Message = { role: "user", content: [{ type: "image", data, mimeType: "image/png" }], timestamp: 1 };
		const { entries } = projectHistory([m]);
		expect(entries[0]!.content[0]).toMatchObject({ type: "image", mimeType: "image/png", sha256: sha("hi") });
		expect(entries[0]!.images[0]).toMatchObject({ data, mimeType: "image/png", sha256: sha("hi"), entryId: entries[0]!.id });
	});

	it("sorts toolCall argument keys so key order is not meaning", () => {
	const mk = (args: { a: number; b: number }): Message => ({
			role: "assistant",
			content: [{ type: "toolCall", id: "t1", name: "read", arguments: args }],
			api: "agy-bridge" as never,
			provider: "antigravity" as never,
			model: "m",
			usage: {} as never,
			stopReason: "stop",
			timestamp: 1,
		});
		const a = projectHistory([mk({ b: 1, a: 2 })]).entries[0]!.hash;
		const b = projectHistory([mk({ a: 2, b: 1 })]).entries[0]!.hash;
		expect(a).toBe(b);
	});

	it("marks assistant aborted/error status and carries toolResult fields", () => {
		const aborted = { ...assistant("x", 1), stopReason: "aborted" } as Message;
		const failed = { ...assistant("y", 2), stopReason: "error", errorMessage: "boom" } as Message;
		const tr: Message = { role: "toolResult", toolCallId: "t1", toolName: "read", isError: true, content: [{ type: "text", text: "nope" }], timestamp: 3 };
		const { entries } = projectHistory([aborted, failed, tr]);
		expect(entries[0]!.status).toBe("interrupted");
		expect(entries[1]!.status).toBe("error");
		expect(entries[1]!.errorMessage).toBe("boom");
		expect(entries[2]).toMatchObject({ toolCallId: "t1", toolName: "read", isError: true });
	});

	it("builds a rolling prefix chain and position-sensitive ids", () => {
		const p1 = projectHistory([user("a", 1), user("b", 2)]);
		const p2 = projectHistory([user("b", 2), user("a", 1)]);
		expect(p1.prefixes[0]).toBe(EMPTY_HISTORY_HASH);
		expect(p1.prefixes).toHaveLength(3);
		expect(p1.prefixes[2]).not.toBe(p2.prefixes[2]);
		// identical content at different positions gets different ids
		expect(p1.entries[1]!.id).not.toBe(p2.entries[1]!.id);
		// deterministic across runs
		expect(projectHistory([user("a", 1), user("b", 2)]).prefixes).toEqual(p1.prefixes);
	});
});

describe("checkpoints", () => {
	it("round-trips historyCheckpoint/matchesCheckpoint", () => {
		const projection = projectHistory([user("a", 1), user("b", 2)]);
		const cp = historyCheckpoint(projection, 1);
		expect(matchesCheckpoint(projection, cp)).toBe(true);
		expect(matchesCheckpoint(projection, historyCheckpoint(projection))).toBe(true);
	});

	it("fails on count drift, entryId mismatch, and out-of-range counts", () => {
		const projection = projectHistory([user("a", 1), user("b", 2)]);
		expect(matchesCheckpoint(projection, { entryCount: 1, hash: "nope" })).toBe(false);
		expect(matchesCheckpoint(projection, { ...historyCheckpoint(projection, 1), entryId: "m0-other" })).toBe(false);
		expect(matchesCheckpoint(projection, undefined)).toBe(false);
		expect(() => historyCheckpoint(projection, 3)).toThrow(RangeError);
	});
});

describe("historyInput and serializeHistory", () => {
	it("flattens text and collects images", () => {
		const data = Buffer.from("hi").toString("base64");
		const image: Message = { role: "user", content: [{ type: "image", data, mimeType: "image/png" }], timestamp: 1 };
		const projection = projectHistory([user("one", 1), user("two", 2), image]);
		const input = historyInput(projection.entries);
		expect(input.text).toBe("one\n\ntwo");
		expect(input.images).toHaveLength(1);
	});

	it("serializes with the three framing lines and returns undefined when empty", () => {
		expect(serializeHistory([])).toBeUndefined();
		const out = serializeHistory(projectHistory([user("a", 1)]).entries)!;
		const lines = out.split("\n");
		expect(lines).toHaveLength(4);
		expect(lines[0]).toContain("reference data");
		expect(lines[1]).toContain("Do not re-execute");
		expect(lines[2]).toContain("sha256");
		expect(JSON.parse(lines[3])).toMatchObject({ role: "user" });
	});
});
