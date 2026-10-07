import { describe, expect, it, vi } from "vitest";
import { BackgroundRunRegistry } from "../src/registry.js";
import { createStopHandler } from "../src/stop.js";

const makeFixture = () => {
	let counter = 0;
	const registry = new BackgroundRunRegistry({
		toolName: "ask-test",
		makeRunId: () => `bg_${String(++counter).padStart(3, "0")}`,
	});
	const kill = vi.fn();
	const onStopped = vi.fn();
	const stop = createStopHandler(registry, { kill, onStopped });
	return { registry, kill, onStopped, stop };
};

describe("createStopHandler", () => {
	it("stops the only running run when no arg is given and reports it", async () => {
		const { registry, kill, onStopped, stop } = makeFixture();
		const run = registry.start("review foo");
		const message = await stop("");
		expect(kill).toHaveBeenCalledWith(run);
		expect(onStopped).toHaveBeenCalledWith(run);
		expect(registry.get(run.runId)?.status).toBe("failed");
		expect(registry.get(run.runId)?.error).toMatch(/stopped/);
		expect(message).toContain(run.runId);
	});

	it("stops by unique id prefix", async () => {
		const { registry, kill, stop } = makeFixture();
		const a = registry.start("one");
		registry.start("two");
		registry.settle(a.runId, { status: "done", output: "x" });
		const message = await stop(a.runId.slice(-3));
		expect(kill).not.toHaveBeenCalled(); // settled runs are not killed
		expect(message).toMatch(/not running|already settled|no running/i);
	});

	it("refuses an ambiguous prefix and lists the candidates", async () => {
		const { registry, kill, stop } = makeFixture();
		registry.start("one");
		registry.start("two");
		const message = await stop("bg");
		expect(kill).not.toHaveBeenCalled();
		expect(message).toContain("bg_001");
		expect(message).toContain("bg_002");
	});

	it("reports an unknown runId", async () => {
		const { kill, stop } = makeFixture();
		const message = await stop("bg_999");
		expect(kill).not.toHaveBeenCalled();
		expect(message).toMatch(/no (running )?(run|match)|not found/i);
	});

	it("says so when nothing is running", async () => {
		const { stop } = makeFixture();
		const message = await stop("");
		expect(message).toMatch(/no running/i);
	});

	it("lists running runIds when several are running and no arg is given", async () => {
		const { registry, kill, stop } = makeFixture();
		registry.start("one");
		registry.start("two");
		const message = await stop("");
		expect(kill).not.toHaveBeenCalled();
		expect(message).toContain("bg_");
		expect(message).toMatch(/bg_\d+[\s\S]*bg_\d+/);
	});
});
