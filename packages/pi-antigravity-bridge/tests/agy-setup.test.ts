import assert from "node:assert/strict";
import { test } from "vitest";
import { createAgySetupOffer } from "../src/agy-setup.js";

function ui(overrides: { confirm?: () => Promise<boolean> } = {}) {
	const notifications: string[] = [];
	return {
		notifications,
		confirm: overrides.confirm ?? (async () => false),
		notify: (message: string) => notifications.push(message),
		setStatus: () => {},
	};
}

test("declining the installer is remembered for the process", async () => {
	let confirms = 0;
	const view = ui({ confirm: async () => { confirms += 1; return false; } });
	const offer = createAgySetupOffer({
		ui: view,
		install: async () => ({ ok: true, output: "" }),
		missingMessage: () => "install manually",
		log: () => {},
	});
	await offer();
	await offer();
	assert.equal(confirms, 1);
	assert.deepEqual(view.notifications, ["install manually"]);
});

test("concurrent callers share setup failures without a rejected promise", async () => {
	let confirms = 0;
	let release!: () => void;
	const gate = new Promise<void>((resolve) => { release = resolve; });
	const view = ui({ confirm: async () => { confirms += 1; await gate; return true; } });
	const offer = createAgySetupOffer({
		ui: view,
		install: async () => { throw new Error("spawn failed"); },
		missingMessage: () => "install manually",
		log: () => {},
	});
	const first = offer();
	const second = offer();
	release();
	await Promise.all([first, second]);
	await offer();
	assert.equal(confirms, 1);
	assert.ok(view.notifications.some((message) => message.includes("spawn failed")));
});

test("an installer failure toast carries the error's own guidance, not the missing-CLI copy", async () => {
	const view = ui({ confirm: async () => true });
	const logCalls: Array<[string, string]> = [];
	const offer = createAgySetupOffer({
		ui: view,
		install: async () => ({ ok: false, error: "installer finished, but agy is not available in this pi process; set AGY_BIN to the binary path or add its directory to PATH, then restart pi" }),
		missingMessage: () => "The `agy` CLI is not installed. Install it from https://antigravity.google/product/antigravity-cli.",
		log: (event, data, level) => logCalls.push([level, String((data as { error?: string })?.error)]),
	});
	await offer();
	assert.equal(view.notifications.length, 1);
	assert.match(view.notifications[0], /Antigravity CLI installation failed/);
	assert.match(view.notifications[0], /set AGY_BIN/);
	assert.doesNotMatch(view.notifications[0], /not installed\. Install it from/);
	// Error tier: the default daily log keeps only errors, so the full
	// installer output must land on disk (issue #19).
	assert.deepEqual(logCalls, [["error", "installer finished, but agy is not available in this pi process; set AGY_BIN to the binary path or add its directory to PATH, then restart pi"]]);
});

test("a toast-sized installer failure shows only the tail of bounded output", async () => {
	const view = ui({ confirm: async () => true });
	const lines = Array.from({ length: 20 }, (_, i) => `noise line ${i + 1}`);
	const offer = createAgySetupOffer({
		ui: view,
		install: async () => ({ ok: false, error: [...lines, "actionable last line"].join("\n") }),
		missingMessage: () => "install manually",
		log: () => {},
	});
	await offer();
	assert.doesNotMatch(view.notifications[0], /noise line 1\b/);
	assert.match(view.notifications[0], /actionable last line/);
});

test("an explicit AGY_BIN override gets correction instructions, not a useless install", async () => {
	let confirms = 0;
	let installs = 0;
	const view = ui({ confirm: async () => { confirms += 1; return true; } });
	const offer = createAgySetupOffer({
		ui: view,
		binaryOverride: "/missing/agy",
		install: async () => { installs += 1; return { ok: true, output: "" }; },
		missingMessage: () => "install manually",
		log: () => {},
	});
	await offer();
	assert.equal(confirms, 0);
	assert.equal(installs, 0);
	assert.match(view.notifications[0] ?? "", /AGY_BIN/);
	assert.match(view.notifications[0] ?? "", /\/missing\/agy/);
});
