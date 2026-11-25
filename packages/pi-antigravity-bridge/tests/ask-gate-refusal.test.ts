// AskAntigravity gate parity, refusal half: when a gate is wanted but was
// never staged (listener failure here), the delegated spawn must refuse like
// provider turns do, not run ungated.
import { test, vi } from "vitest";
import assert from "node:assert/strict";
import { startSession } from "./helpers/gate-session.js";

vi.mock("../src/mcp-server.js", async (importOriginal) => {
	const actual = await importOriginal<typeof import("../src/mcp-server.js")>();
	return { ...actual, startMcpServer: async () => ({ ok: false as const, reason: "forced listener failure in test" }) };
});

const gateOn = { engine: "stream-json", askTool: true, approvals: { gateMode: "shadow", mode: "allow" } };

test("ask gate: an unstaged required gate refuses the consult", { timeout: 30000 }, async () => {
	const session = await startSession(gateOn, {});
	try {
		const ask = session.tools.get("AskAntigravity");
		assert.ok(ask, "askTool on must register AskAntigravity");
		const result = await ask.execute(
			"t1",
			{ prompt: "gate probe" },
			undefined,
			undefined,
			{ cwd: session.cwd, model: undefined } as never,
		);
		const text = result.content
			.map((c: { type: string; text?: string }) => (c.type === "text" ? c.text : ""))
			.join("\n");
		assert.ok(
			text.includes("approval gate is required but not staged"),
			`an unstaged required gate must refuse the consult, got: ${text.slice(0, 200)}`,
		);
	} finally {
		await session.shutdown();
	}
});
