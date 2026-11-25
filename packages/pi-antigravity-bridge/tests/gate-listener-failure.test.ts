// Factory-level proof of the listener-failure branch: with a gate wanted and
// startMcpServer forced to report failure, session_start takes the disabled
// branch, no shadows register, and the provider refuses turns with the
// gate-unavailable error until a restart stages the gate.
import { test, vi } from "vitest";
import assert from "node:assert/strict";
import { normalizeContext, type SimpleStreamOptions } from "@earendil-works/pi-ai";
import { probeModel, startSession } from "./helpers/gate-session.js";

vi.mock("../src/mcp-server.js", async (importOriginal) => {
	const actual = await importOriginal<typeof import("../src/mcp-server.js")>();
	return { ...actual, startMcpServer: async () => ({ ok: false as const, reason: "forced listener failure in test" }) };
});

const gateOn = { engine: "stream-json", approvals: { gateMode: "shadow", mode: "allow" } };

test("gate startup: a failed listener leaves the gate refusing turns", { timeout: 30000 }, async () => {
	const session = await startSession(gateOn, {});
	try {
		for (const name of ["bash", "write", "edit"]) {
			assert.ok(!session.tools.has(name), `no ${name} shadow without a listener`);
		}
		assert.ok(session.providerDef?.streamSimple, "session_start must register the provider");
		const stream = session.providerDef.streamSimple(
			{ ...probeModel },
			normalizeContext({
				systemPrompt: undefined,
				messages: [{ role: "user", content: "gate probe", timestamp: Date.now() }],
			}),
			{ cwd: process.cwd() } as unknown as SimpleStreamOptions,
		);
		const events: unknown[] = [];
		for await (const ev of stream) events.push(ev);
		const texts = events.map((e) => JSON.stringify(e));
		assert.ok(
			texts.some((t) => t.includes("approval gate is required but not active")),
			"an unstaged required gate must refuse turns",
		);
		assert.ok(
			texts.some((t) => t.includes("forced listener failure in test")),
			"the refusal must carry the listener-failure reason, not the stale pending one",
		);
	} finally {
		await session.shutdown();
	}
});
