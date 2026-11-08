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
