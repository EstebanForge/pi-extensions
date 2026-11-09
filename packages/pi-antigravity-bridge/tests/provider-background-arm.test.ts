// Background-arm tests: the provider fires onNativeBackground exactly on the
// settled OK end of a turn whose activities carried the WaitMsBeforeAsync
// shape, with the bound conversation id and the turn start timestamp.
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "vitest";
import type { Api, Model } from "@earendil-works/pi-ai";
import type { TranscriptContext } from "@earendil-works/pi-ai";
import { ToolRoundTrips, createStreamSimple, type DriverDeps } from "../src/provider.js";
import { SessionStore } from "../src/sessions.js";
import type { DriverActivity, DriverTurnRequest, TurnDriver, TurnHandle } from "../src/driver-types.js";

const model: Model<Api> = {
	id: "gemini-test",
	name: "gemini-test",
	api: "agy-bridge" as Api,
	provider: "antigravity",
	baseUrl: "agy-bridge://antigravity",
	reasoning: false,
	input: ["text"],
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
	contextWindow: 1000,
	maxTokens: 100,
};

function contextWith(prompt: string): TranscriptContext {
	return {
		systemPrompt: "",
		messages: [{ role: "user", content: prompt, timestamp: Date.now() }],
		tools: [],
	} as unknown as TranscriptContext;
}

function tmpStorePath(): string {
	return path.join(fs.mkdtempSync(path.join(os.tmpdir(), "agy-bgarm-")), "sessions.json");
}

/** Driver: emits scripted activities, settles OK with a bound conversation. */
function scriptedDriver(activities: DriverActivity[], conversationId: string | undefined, outcomeOverride?: Partial<{ aborted: boolean; status: "OK" | "ERROR" }>): TurnDriver {
	const handle: TurnHandle = {
		id: "fake-turn",
		next: async () => activities.shift() ?? null,
		outcome: Promise.resolve({
			status: outcomeOverride?.status ?? "OK",
			response: "ok",
			finished: true,
			aborted: outcomeOverride?.aborted ?? false,
			conversationId,
		}),
		pushExternal: () => {},
	};
	return {
		run: async (_opts: DriverTurnRequest) => handle,
	} as unknown as TurnDriver;
}

async function runTurn(driver: TurnDriver, arms: Array<{ conversationId: string; turnStartMs: number }>): Promise<void> {
	const deps: DriverDeps = {
		driver,
		roundTrips: new ToolRoundTrips(driver),
		engine: "acp",
		onNativeBackground: (info) => arms.push(info),
	};
	const streamSimple = createStreamSimple({ entries: [{ id: model.id, full: model.id }], store: new SessionStore(tmpStorePath()), driver, roundTrips: deps.roundTrips, engine: "acp", onNativeBackground: deps.onNativeBackground });
	const stream = streamSimple(model, contextWith("go"), { cwd: process.cwd() } as never);
	for await (const ev of stream) void ev;
	await new Promise((r) => setTimeout(r, 0));
}

test("a WaitMsBeforeAsync tool_start arms the watcher at settled turn end", async () => {
	const arms: Array<{ conversationId: string; turnStartMs: number }> = [];
	await runTurn(
		scriptedDriver([{ type: "tool_start", name: "run_command", args: { CommandLine: "release.sh", WaitMsBeforeAsync: 500 } }], "conv-abc"),
		arms,
	);
	assert.equal(arms.length, 1);
	assert.equal(arms[0]!.conversationId, "conv-abc");
	assert.equal(typeof arms[0]!.turnStartMs, "number");
});

test("foreground calls and aborted turns never arm", async () => {
	const arms: Array<{ conversationId: string; turnStartMs: number }> = [];
	await runTurn(scriptedDriver([{ type: "tool_start", name: "run_command", args: { CommandLine: "ls" } }], "conv-abc"), arms);
	await runTurn(scriptedDriver([{ type: "tool_start", name: "run_command", args: { WaitMsBeforeAsync: 500 } }], "conv-xyz", { aborted: true }), arms);
	await runTurn(scriptedDriver([{ type: "tool_start", name: "run_command", args: { WaitMsBeforeAsync: 500 } }], "conv-xyz", { status: "ERROR" }), arms);
	assert.deepEqual(arms, []);
});
