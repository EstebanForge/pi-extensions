import { describe, expect, it } from "vitest";
import { BackgroundRunRegistry } from "../src/registry.js";

// Fresh id counter per registry so tests never depend on execution order.
const makeIds = () => {
	let counter = 0;
	return () => `bg_${String(++counter).padStart(3, "0")}`;
};

const makeRegistry = (overrides: Partial<ConstructorParameters<typeof BackgroundRunRegistry>[0]> = {}) =>
	new BackgroundRunRegistry({ toolName: "ask-test", makeRunId: makeIds(), ...overrides });

describe("BackgroundRunRegistry.start", () => {
	it("registers a running run with a unique id and a summary", () => {
		const reg = makeRegistry();
		const run = reg.start("review src/foo.ts");
		expect(run.runId).toBe("bg_001");
		expect(run.status).toBe("running");
		expect(run.summary).toBe("review src/foo.ts");
		expect(reg.get("bg_001")).toBe(run);
	});

	it("generates unique ids across runs", () => {
		const reg = makeRegistry();
		const a = reg.start("one");
		const b = reg.start("two");
		expect(a.runId).not.toBe(b.runId);
	});

	it("throws RangeError at the concurrency cap and frees the slot on settle", () => {
		const reg = makeRegistry({ maxConcurrent: 2 });
		reg.start("one");
		reg.start("two");
		expect(() => reg.start("three")).toThrow(RangeError);
		expect(reg.settle("bg_001", { status: "done", output: "x" })).toBe(true);
		const third = reg.start("three");
		expect(third.runId).toBe("bg_003");
	});
});

describe("BackgroundRunRegistry.settle", () => {
	it("settles exactly once: later settles are rejected and keep the first result", () => {
		const reg = makeRegistry();
		reg.start("one");
		expect(reg.settle("bg_001", { status: "done", output: "first", handle: "h1" })).toBe(true);
		expect(reg.settle("bg_001", { status: "failed", error: "late failure" })).toBe(false);
		const run = reg.get("bg_001");
		expect(run?.status).toBe("done");
		expect(run?.output).toBe("first");
		expect(run?.error).toBeUndefined();
	});

	it("rejects an unknown runId", () => {
		const reg = makeRegistry();
		expect(reg.settle("nope", { status: "done", output: "x" })).toBe(false);
	});

	it("records settledAt and the handle for done runs", () => {
		const reg = makeRegistry();
		reg.start("one");
		expect(reg.settle("bg_001", { status: "done", output: "out", handle: "sessionId=abc" })).toBe(true);
		const run = reg.get("bg_001");
		expect(run?.settledAt).toBeGreaterThan(0);
		expect(run?.handle).toBe("sessionId=abc");
	});
});

describe("BackgroundRunRegistry.sweep", () => {
	it("drops settled runs past the TTL and keeps fresh ones and running runs", () => {
		const ttlMs = 60 * 60 * 1000;
		const reg = makeRegistry({ ttlMs });
		reg.start("old done");
		reg.start("old running");
		reg.start("fresh done");
		reg.settle("bg_001", { status: "done", output: "old" });
		reg.settle("bg_003", { status: "done", output: "fresh" });
		const now = Date.now();
		// Inject ages directly: bg_001 is past the TTL, bg_003 settled just now.
		// bg_002 is still running and must survive regardless of age: its own
		// timeout owns the running lifecycle, the registry TTL owns settled state.
		const dropped = reg.sweep(now, (run) => (run.runId === "bg_001" ? now - ttlMs - 1 : now));
		expect(dropped).toEqual(["bg_001"]);
		expect(reg.get("bg_001")).toBeUndefined();
		expect(reg.get("bg_002")).toBeDefined();
		expect(reg.get("bg_003")).toBeDefined();
	});

	it("default age uses the run's own settledAt", () => {
		const ttlMs = 1000;
		const reg = makeRegistry({ ttlMs });
		reg.start("one");
		const t0 = Date.now();
		reg.settle("bg_001", { status: "done", output: "x" });
		const run = reg.get("bg_001");
		expect(run?.settledAt).toBeGreaterThanOrEqual(t0);
		expect(reg.sweep(Date.now() + ttlMs + 1)).toEqual(["bg_001"]);
	});
});

describe("BackgroundRunRegistry.find", () => {
	it("matches a unique id prefix and refuses an ambiguous one", () => {
		const reg = makeRegistry();
		reg.start("one");
		reg.start("two");
		expect(reg.find("bg_0")?.runId).toBeUndefined(); // matches both -> undefined
		expect(reg.find("001")?.runId).toBe("bg_001");
		expect(reg.find("zzz")).toBeUndefined();
	});
});

describe("BackgroundRunRegistry.dispose", () => {
	it("latches, returns still-running runs, and keeps get/settle readable", () => {
		const reg = makeRegistry();
		reg.start("one");
		reg.start("two");
		reg.settle("bg_001", { status: "done", output: "x" });
		const running = reg.dispose();
		expect(running.map((r) => r.runId)).toEqual(["bg_002"]);
		expect(reg.isDisposed()).toBe(true);
		expect(reg.get("bg_002")).toBeDefined();
		expect(reg.settle("bg_002", { status: "failed", error: "killed" })).toBe(true);
	});
});
