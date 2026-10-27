// Observational memory background worker short-circuit guard:
// When pi-observational-memory triggers consolidation (observer, reflector, dropper)
// on a session where an Antigravity model is active, it runs agentLoop with
// caller-private tools (record_observations, record_reflections, drop_observations).
// Antigravity models run in a closed loop on the backend process and cannot execute
// caller-scoped tools. Dispatching to agy causes the model to perceive missing tools
// and autonomously run runaway disk-search loops (find, grep, sed).
//
// streamSimple must detect these worker tools via getCurrentTools(context.messages),
// log a warning, and finalize immediately with "stop" without driving any backend turns.
//
// Run: npx vitest run packages/pi-antigravity-bridge/tests/provider-observational-memory.test.ts

import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { beforeEach, describe, it } from "vitest";
import {
	normalizeContext,
	type Api,
	type Model,
	type TranscriptContext,
} from "@earendil-works/pi-ai";
import {
	ToolRoundTrips,
	createStreamSimple,
	isObservationalMemoryContext,
	_resetObservationalMemoryWarnedForTesting,
} from "../src/provider.js";
import { SessionStore } from "../src/sessions.js";
import type { DriverActivity, DriverTurnRequest } from "../src/driver.js";

const model: Model<Api> = {
	id: "gemini-flash",
	name: "Gemini 3.8 Flash",
	api: "agy-bridge" as Api,
	provider: "antigravity",
	baseUrl: "agy-bridge://antigravity",
	reasoning: false,
	input: ["text"],
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
	contextWindow: 1_000_000,
	maxTokens: 65_536,
};

function tmpStorePath(): string {
	return path.join(fs.mkdtempSync(path.join(os.tmpdir(), "agy-om-")), "sessions.json");
}

function fakeDriver(seen: { calls: number }) {
	const fakeHandle = {
		id: "fake-turn",
		outcome: Promise.resolve({ status: "OK" as const, response: "ok", finished: true, aborted: false }),
		next: async (): Promise<DriverActivity | null> => null,
		pushExternal: (_a: DriverActivity) => {},
	};
	return {
		get activeHandle() {
			return fakeHandle;
		},
		run: async (_req: DriverTurnRequest) => {
			seen.calls++;
			return fakeHandle;
		},
	};
}

describe("Observational Memory short-circuit guard", () => {
	beforeEach(() => {
		_resetObservationalMemoryWarnedForTesting();
	});

	it("identifies contexts declaring record_observations, record_reflections, or drop_observations", () => {
		const omContext: TranscriptContext = normalizeContext({
			messages: [
				{
					role: "system",
					content: "You are the observer.",
					timestamp: Date.now(),
					toolsAdded: [
						{
							name: "record_observations",
							description: "Record new durable observations",
							parameters: { type: "object" },
						},
					],
				},
				{
					role: "user",
					content: "Compress the conversation chunk into observations.",
					timestamp: Date.now(),
				},
			],
		});

		assert.equal(isObservationalMemoryContext(omContext), true);

		const normalContext: TranscriptContext = normalizeContext({
			messages: [
				{
					role: "system",
					content: "You are a coding assistant.",
					timestamp: Date.now(),
					toolsAdded: [
						{
							name: "read",
							description: "Read file",
							parameters: { type: "object" },
						},
					],
				},
				{
					role: "user",
					content: "Help me debug this issue.",
					timestamp: Date.now(),
				},
			],
		});

		assert.equal(isObservationalMemoryContext(normalContext), false);
	});

	it("short-circuits streamSimple without invoking driver when OM tools are declared", async () => {
		const store = new SessionStore(tmpStorePath());
		const seen = { calls: 0 };
		const logged: Array<{ level: string; msg: string; data?: unknown }> = [];
		const driver = fakeDriver(seen);

		const streamSimple = createStreamSimple({
			entries: [],
			store,
			driver: driver as any,
			roundTrips: new ToolRoundTrips(driver as any),
			log: (msg, data, level) => {
				logged.push({ level: level ?? "info", msg, data });
			},
		});

		const omContext: TranscriptContext = normalizeContext({
			messages: [
				{
					role: "system",
					content: "System prompt",
					timestamp: Date.now(),
					toolsAdded: [
						{
							name: "record_observations",
							description: "Record observations",
							parameters: { type: "object" },
						},
					],
				},
				{
					role: "user",
					content: "Please extract observations.",
					timestamp: Date.now(),
				},
			],
		});

		const stream = streamSimple(model, omContext);
		const result = await stream.result();

		// Never called the underlying driver
		assert.equal(seen.calls, 0, "Driver must not be called for OM worker turns");

		// Stream completed cleanly with stop reason "stop"
		assert.equal(result.stopReason, "stop");
		assert.equal(result.content.length, 0);

		// Warning was logged
		const warnEntry = logged.find((l) => l.level === "warn" && l.msg === "turn-warning");
		assert.ok(warnEntry, "A warning should be logged for OM mismatch");
		assert.equal((warnEntry.data as any)?.reason, "observational-memory-unsupported");
	});

	it("warns only once across multiple short-circuited turns in the same process", async () => {
		const store = new SessionStore(tmpStorePath());
		const seen = { calls: 0 };
		const logged: Array<{ level: string; msg: string }> = [];
		const driver = fakeDriver(seen);

		const streamSimple = createStreamSimple({
			entries: [],
			store,
			driver: driver as any,
			roundTrips: new ToolRoundTrips(driver as any),
			log: (msg, _data, level) => {
				logged.push({ level: level ?? "info", msg });
			},
		});

		const omContext: TranscriptContext = normalizeContext({
			messages: [
				{
					role: "system",
					content: "System prompt",
					timestamp: Date.now(),
					toolsAdded: [
						{
							name: "record_reflections",
							description: "Record reflections",
							parameters: { type: "object" },
						},
					],
				},
				{
					role: "user",
					content: "Please extract reflections.",
					timestamp: Date.now(),
				},
			],
		});

		// Call 1
		const res1 = await streamSimple(model, omContext).result();
		assert.equal(res1.stopReason, "stop");

		// Call 2
		const res2 = await streamSimple(model, omContext).result();
		assert.equal(res2.stopReason, "stop");

		assert.equal(seen.calls, 0);

		// Exactly one warning logged across both calls
		const warnings = logged.filter((l) => l.level === "warn" && l.msg === "turn-warning");
		assert.equal(warnings.length, 1, "Warning must be emitted only once per process");
	});
});
