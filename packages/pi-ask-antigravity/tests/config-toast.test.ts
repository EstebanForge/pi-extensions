// The startup config warning for ask-antigravity (issue #23): a hand editor
// never opens /agy, so parse fallbacks must surface where they happen. Runs
// the real factory's session_start handlers against a temp HOME and a
// capture ui; the ctx Proxy absorbs whatever else the startup path touches.

import { test } from "vitest";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import factory from "../extensions/index.js";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

type Handler = (event: unknown, ctx: unknown) => void | Promise<void>;

function nooped<T extends object>(base: T): T {
	return new Proxy(base, {
		get(target, prop, receiver) {
			if (prop in target) return Reflect.get(target, prop, receiver);
			return () => {};
		},
	}) as T;
}

function tempHome(withConfig: Record<string, unknown> | null): string {
	const home = fs.mkdtempSync(path.join(os.tmpdir(), "agy-ask-toast-"));
	if (withConfig) {
		fs.mkdirSync(path.join(home, ".pi", "agent"), { recursive: true });
		fs.writeFileSync(
			path.join(home, ".pi", "agent", "ask-antigravity.json"),
			JSON.stringify(withConfig),
		);
	}
	return home;
}

async function startupNotes(home: string): Promise<string[]> {
	const prevHome = process.env.HOME;
	const prevEnv = process.env.AGY_SKIP_PERMISSIONS;
	process.env.HOME = home;
	delete process.env.AGY_SKIP_PERMISSIONS;
	const notes: string[] = [];
	const handlers: Record<string, Handler[]> = {};
	const pi = nooped({
		registerTool: () => {},
		on: (name: string, handler: Handler) => {
			(handlers[name] ??= []).push(handler);
		},
	}) as unknown as ExtensionAPI;
	try {
		await factory(pi);
		const ctx = nooped({
			hasUI: true,
			mode: "tui",
			ui: nooped({ notify: (message: string) => notes.push(message) }),
		});
		for (const h of handlers["session_start"] ?? []) await h({ reason: "startup" }, ctx);
	} finally {
		if (prevHome === undefined) delete process.env.HOME;
		else process.env.HOME = prevHome;
		if (prevEnv === undefined) delete process.env.AGY_SKIP_PERMISSIONS;
		else process.env.AGY_SKIP_PERMISSIONS = prevEnv;
		fs.rmSync(home, { recursive: true, force: true });
	}
	return notes;
}

test("toast: junk skipPermissions warns on startup", { timeout: 15000 }, async () => {
	const notes = await startupNotes(tempHome({ skipPermissions: "banana" }));
	assert.ok(
		notes.some((n) => /ask-antigravity config/.test(n) && /unparseable/.test(n)),
		`expected a config warning, got: ${JSON.stringify(notes)}`,
	);
});

test("toast: a clean config emits no warning", { timeout: 15000 }, async () => {
	const notes = await startupNotes(tempHome({}));
	assert.ok(
		!notes.some((n) => /unparseable/.test(n)),
		`clean config must not warn, got: ${JSON.stringify(notes)}`,
	);
});
