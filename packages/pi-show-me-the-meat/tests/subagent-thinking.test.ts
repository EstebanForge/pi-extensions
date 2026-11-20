import { describe, it, expect, vi } from "vitest";

// The thinking-level default is a provider-compatibility contract: a forced
// "off" is rejected by models whose spec has no off level (GPT-6.2 on the
// openai/azure/openai-codex providers). The mock captures what abridgeViaSubagent
// hands to createAgentSession so the default and the forward path are both
// asserted against the real call site.

const createAgentSessionCalls: Array<Record<string, unknown>> = [];

vi.mock("@earendil-works/pi-coding-agent", () => ({
	createAgentSession: async (opts: Record<string, unknown>) => {
		createAgentSessionCalls.push(opts);
		const session = {
			subscribe: () => () => {},
			prompt: () => Promise.reject(new Error("stop")),
			isStreaming: false,
			waitForIdle: () => Promise.resolve(),
			abort: () => Promise.resolve(),
			dispose: () => {},
		};
		return { session };
	},
	SessionManager: { inMemory: () => ({}) },
}));

const { abridgeViaSubagent } = await import("../extensions/subagent.js");

const fakeModel = { id: "fake-model" } as never;

function meatOptions() {
	return {
		cwd: process.cwd(),
		rawDiff: "diff --git a/f b/f\n--- a/f\n+++ b/f\n@@ -1 +1 @@\n-a\n+b\n",
		numberedDiff: "1 -a\n2 +b\n",
		totalLines: 2,
		model: fakeModel,
	};
}

describe("abridgeViaSubagent thinking level", () => {
	it("does not force thinking off when the caller passes no level", async () => {
		await expect(abridgeViaSubagent(meatOptions())).rejects.toThrow(/failed to start/);
		expect(createAgentSessionCalls).toHaveLength(1);
		expect(createAgentSessionCalls[0]?.thinkingLevel).toBeUndefined();
	});

	it("forwards an explicit thinking level unchanged", async () => {
		await expect(
			abridgeViaSubagent({ ...meatOptions(), thinkingLevel: "high" as never }),
		).rejects.toThrow(/failed to start/);
		expect(createAgentSessionCalls[1]?.thinkingLevel).toBe("high");
	});

	it("keeps the tool allowlist intact alongside the thinking default", async () => {
		await expect(abridgeViaSubagent(meatOptions())).rejects.toThrow(/failed to start/);
		expect(createAgentSessionCalls[2]?.tools).toEqual(["read", "grep", "submit"]);
	});
});
