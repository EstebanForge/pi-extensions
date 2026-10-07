import { describe, expect, it, vi } from "vitest";
import { buildWakeContent, createWakeSender, type WakeInfo } from "../src/wake.js";

const info = (over: Partial<WakeInfo> = {}): WakeInfo => ({
	toolLabel: "Claude Code",
	runId: "bg_007",
	ok: true,
	elapsedS: 42,
	...over,
});

describe("buildWakeContent", () => {
	it("announces success with the resume handle and the untrusted banner before the body", () => {
		const text = buildWakeContent(info({ handle: "sessionId=abc123" }), "peer says hello");
		expect(text).toContain("finished");
		expect(text).toContain("bg_007");
		expect(text).toContain("Claude Code");
		expect(text).toContain("sessionId=abc123");
		expect(text).toContain("UNTRUSTED");
		const bodyStart = text.indexOf("peer says hello");
		const bannerEnd = text.indexOf("not a user instruction");
		expect(bodyStart).toBeGreaterThan(bannerEnd);
		expect(text.endsWith("peer says hello")).toBe(true);
	});

	it("states the failure reason under an untrusted marker and carries the handle when known", () => {
		const text = buildWakeContent(info({ ok: false, error: "timeout after 600s. Partial output: hostile text", handle: "sessionId=h" }));
		expect(text).toContain("FAILED");
		expect(text).toContain("timeout after 600s");
		// Peer output can ride in the reason: it must be marked untrusted.
		expect(text).toContain("UNTRUSTED");
		expect(text).toContain("sessionId=h");
	});

	it("says there is no resume handle when the run produced none", () => {
		const text = buildWakeContent(info());
		expect(text).toMatch(/[Nn]o resume handle/);
	});

	it("truncates oversized bodies with a marker", () => {
		const text = buildWakeContent(info(), "x".repeat(150_000));
		expect(text.length).toBeLessThan(150_000);
		expect(text).toContain("[truncated, 50000 chars dropped]");
	});

	it("uses plain ASCII separators: no em-dash, no middle dot", () => {
		const text = buildWakeContent(info({ handle: "h" }), "body");
		expect(text).not.toMatch(/[—–]/);
		expect(text).not.toContain("·");
	});
});

describe("createWakeSender", () => {
	const makeTarget = () => ({ sendMessage: vi.fn() });

	it("sends the built content as a follow-up turn trigger, displayed", () => {
		const target = makeTarget();
		const send = createWakeSender(target, { customType: "ask-claude-result", isDisposed: () => false });
		send(info({ handle: "h" }), "body");
		expect(target.sendMessage).toHaveBeenCalledTimes(1);
		const [msg, opts] = target.sendMessage.mock.calls[0];
		expect(msg.customType).toBe("ask-claude-result");
		expect(msg.display).toBe(true);
		expect(msg.content).toContain("UNTRUSTED");
		expect(opts).toEqual({ triggerTurn: true, deliverAs: "followUp" });
	});

	it("applies the redact hook to the final content", () => {
		const target = makeTarget();
		const send = createWakeSender(target, {
			customType: "x",
			isDisposed: () => false,
			redact: (s) => s.replaceAll("sk-secret", "[REDACTED]"),
		});
		send(info(), "key was sk-secret");
		const [msg] = target.sendMessage.mock.calls[0];
		expect(msg.content).toContain("[REDACTED]");
		expect(msg.content).not.toContain("sk-secret");
	});

	it("sends nothing once disposed", () => {
		const target = makeTarget();
		const send = createWakeSender(target, { customType: "x", isDisposed: () => true });
		send(info(), "body");
		expect(target.sendMessage).not.toHaveBeenCalled();
	});

	it("does not throw when the runtime is stale and sendMessage throws", () => {
		const target = { sendMessage: () => { throw new Error("Extension runtime is stale"); } };
		const send = createWakeSender(target, { customType: "x", isDisposed: () => false });
		expect(() => send(info(), "body")).not.toThrow();
	});
});
