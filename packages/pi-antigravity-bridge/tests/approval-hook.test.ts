// Pins for approval-gate hooks.json staging (docs/TODO.md 2.8) and the
// legacy workspace sweep (issue #5 isolation).
//
// Since the isolation fix, the gate group stages into the session-private
// per-pid bridge dir (the extra --add-dir only this session's agy gets).
// The private file is ours alone: plain atomic replace, no merge. The
// sweep removes gate groups 1.6.x left in SHARED workspace files when
// their owning session is dead; live and foreign groups stay.
//
// Run: npm test

import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "vitest";
import {
	buildGateGroup,
	gateGroupKey,
	gateHooksStaged,
	hookScriptSource,
	removeGateHooks,
	stagedTimeoutSeconds,
	stageGateHooks,
	sweepWorkspaceGateGroups,
} from "../src/approval-hook.js";

function tmpDir() {
	return fs.mkdtempSync(path.join(os.tmpdir(), "agy-stage-"));
}
const opts = {
	port: 47881,
	token: "secret-token",
	scriptPath: "/data/dir/approval-hook.mjs",
	parkBudgetMs: 480_000,
};

function hooksFile(dir: string): string {
	return path.join(dir, ".agents", "hooks.json");
}

function readJson(file: string): Record<string, unknown> {
	return JSON.parse(fs.readFileSync(file, "utf8")) as Record<string, unknown>;
}

test("stages into the private dir: group shape, matcher, generous timeout", () => {
	const dir = tmpDir();
	const res = stageGateHooks(dir, opts);
	assert.equal(res.wrote, true);
	assert.equal(gateHooksStaged(dir), true);
	const parsed = readJson(hooksFile(dir));
	const group = parsed[gateGroupKey()] as {
		enabled: boolean;
		PreToolUse: Array<{ matcher: string; hooks: Array<{ command: string; timeout: number }> }>;
	};
	assert.equal(group.enabled, true);
	const handler = group.PreToolUse[0].hooks[0];
	assert.match(group.PreToolUse[0].matcher, /create_file/);
	assert.match(group.PreToolUse[0].matcher, /run_command/);
	assert.equal(handler.command, 'node "/data/dir/approval-hook.mjs"');
	// V3: timeout must exceed the park budget (soft-pass on timeout)
	assert.ok(handler.timeout >= opts.parkBudgetMs / 1000);
	fs.rmSync(dir, { recursive: true, force: true });
});

test("staging owns the private file: stale content is replaced wholesale", () => {
	const dir = tmpDir();
	fs.mkdirSync(path.join(dir, ".agents"), { recursive: true });
	fs.writeFileSync(hooksFile(dir), JSON.stringify({ "stale-leftover": { enabled: true } }));
	const res = stageGateHooks(dir, opts);
	assert.equal(res.wrote, true);
	const parsed = readJson(hooksFile(dir));
	assert.deepEqual(Object.keys(parsed), [gateGroupKey()], "only our group remains");
	fs.rmSync(dir, { recursive: true, force: true });
});

test("idempotent restage: no write", () => {
	const dir = tmpDir();
	stageGateHooks(dir, opts);
	const before = fs.readFileSync(hooksFile(dir), "utf8");
	const res = stageGateHooks(dir, opts);
	assert.equal(res.wrote, false);
	assert.equal(res.reason, "already staged");
	assert.equal(fs.readFileSync(hooksFile(dir), "utf8"), before);
	fs.rmSync(dir, { recursive: true, force: true });
});

test("removeGateHooks deletes the private file and reports absence", () => {
	const dir = tmpDir();
	assert.equal(removeGateHooks(dir).reason, "no hooks.json");
	stageGateHooks(dir, opts);
	const res = removeGateHooks(dir);
	assert.equal(res.wrote, true);
	assert.equal(fs.existsSync(hooksFile(dir)), false);
	assert.equal(gateHooksStaged(dir), false);
	assert.equal(removeGateHooks(dir).reason, "no hooks.json");
	fs.rmSync(dir, { recursive: true, force: true });
});

// --- legacy workspace sweep (issue #5): 1.6.x staged gate groups into the
// SHARED workspace hooks.json, where standalone sessions load them --------

const foreignOpts = { ...opts, scriptPath: "/data/dir/approval-hook-1.js" };
const deadOpts = { ...opts, scriptPath: "/data/dir/approval-hook-4194000.js" };

function seedGroup(ws: string, key: string, groupOpts: typeof opts): void {
	const file = hooksFile(ws);
	fs.mkdirSync(path.dirname(file), { recursive: true });
	const current = fs.existsSync(file) ? readJson(file) : {};
	current[key] = buildGateGroup(groupOpts);
	fs.writeFileSync(file, JSON.stringify(current, null, 2) + "\n");
}

function readKeys(ws: string): string[] {
	return Object.keys(readJson(hooksFile(ws)));
}

test("sweep removes dead sessions' groups, keeps live ones", () => {
	const ws = tmpDir();
	seedGroup(ws, gateGroupKey(4194000), deadOpts); // pid dead -> sweep
	seedGroup(ws, gateGroupKey(1), foreignOpts); // pid 1 (init) alive -> keep
	seedGroup(ws, "user-linter", {
		...opts,
		scriptPath: "/data/dir/approval-hook-4194000.js",
	}); // foreign group, dead-looking -> never touched
	const swept = sweepWorkspaceGateGroups(ws);
	assert.equal(swept, 1);
	const keys = readKeys(ws);
	assert.equal(keys.includes(gateGroupKey(4194000)), false, "dead group swept");
	assert.ok(keys.includes(gateGroupKey(1)), "live group kept");
	assert.ok(keys.includes("user-linter"), "foreign group kept");
	fs.rmSync(ws, { recursive: true, force: true });
});

test("sweep keeps unattributable gate groups (foreign format)", () => {
	const ws = tmpDir();
	// gate-prefixed keys whose group carries no approval-hook-<pid>.js path
	// cannot be attributed to a session: never touched.
	fs.mkdirSync(path.join(ws, ".agents"), { recursive: true });
	fs.writeFileSync(
		hooksFile(ws),
		JSON.stringify({
			"pi-bridge-gate-weird": buildGateGroup({ ...opts, scriptPath: "/data/dir/approval-hook.mjs" }),
			"pi-bridge-gate-broken": { enabled: true },
		}),
	);
	const swept = sweepWorkspaceGateGroups(ws);
	assert.equal(swept, 0);
	assert.ok(readKeys(ws).includes("pi-bridge-gate-weird"), "unattributable group preserved");
	assert.ok(readKeys(ws).includes("pi-bridge-gate-broken"), "shapeless gate group preserved");
	fs.rmSync(ws, { recursive: true, force: true });
});

test("sweep never touches unparseable or missing files", () => {
	const ws = tmpDir();
	assert.equal(sweepWorkspaceGateGroups(ws), 0, "missing file is a no-op");
	fs.mkdirSync(path.join(ws, ".agents"), { recursive: true });
	fs.writeFileSync(hooksFile(ws), "{broken");
	assert.equal(sweepWorkspaceGateGroups(ws), 0);
	assert.equal(fs.readFileSync(hooksFile(ws), "utf8"), "{broken");
	fs.rmSync(ws, { recursive: true, force: true });
});

test("sweep with nothing to remove writes nothing", () => {
	const ws = tmpDir();
	seedGroup(ws, gateGroupKey(1), foreignOpts);
	seedGroup(ws, "user-linter", opts);
	const before = fs.readFileSync(hooksFile(ws), "utf8");
	assert.equal(sweepWorkspaceGateGroups(ws), 0);
	assert.equal(fs.readFileSync(hooksFile(ws), "utf8"), before);
	fs.rmSync(ws, { recursive: true, force: true });
});

// --- generated script + group shape (unchanged by the isolation fix) ------

test("hook script source: posts, polls, fails closed on deadline", () => {
	const src = hookScriptSource({ port: 47881, token: "secret-token", deadlineMs: 540_000 });
	assert.match(src, /\/approval/);
	assert.match(src, /x-bridge-token/);
	assert.equal(src.includes("secret-token"), true);
	assert.match(src, /decision: "deny", reason: "approval gate deadline exceeded"/);
	assert.match(src, /decision: "deny", reason: "approval gate unreachable/);
});

test("stagedTimeoutSeconds floors at 60s and adds margin", () => {
	assert.equal(stagedTimeoutSeconds(480_000), 540);
	assert.equal(stagedTimeoutSeconds(0), 60, "floor at 60s");
	assert.equal(stagedTimeoutSeconds(1_000), 61, "margin dominates above the floor");
});

test("buildGateGroup carries port/token only through the script path", () => {
	const group = buildGateGroup(opts);
	const handler = (group as { PreToolUse: Array<{ hooks: Array<{ command: string }> }> }).PreToolUse[0].hooks[0];
	assert.equal(handler.command, 'node "/data/dir/approval-hook.mjs"');
	assert.equal(handler.command.includes("secret-token"), false, "token stays in the script file, not hooks.json");
});
