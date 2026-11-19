// Delivery of the approval gate into staged ACP homes (issue #18). The ACP
// server honors PreToolUse hooks from <stagedHome>/config/hooks.json (probed
// live on agy 1.5.12 with a workspace positive control; see
// scripts/probe-acp-hooks.mjs), so the gate rides the same private-per-pid
// staging the stream-json engine uses: the connection merges the session's
// gate group into the staged home at spawn. Tests cover the merge semantics
// and the wiring; the hook FIRING inside a real agy turn is probe evidence,
// not a unit test. All staging happens under tmp roots, never the real home.
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, test } from "vitest";
import { buildGateGroup, gateGroupKey, mergeGateGroupIntoAcpHome, stageGateHooks } from "../src/approval-hook.js";

const tempDirs: string[] = [];
afterAll(() => {
	for (const d of tempDirs) fs.rmSync(d, { recursive: true, force: true });
});

function tmpRoot(): string {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), "gate-acp-delivery-"));
	tempDirs.push(dir);
	return dir;
}

const stageOpts = { port: 1, token: "t", scriptPath: "/tmp/approval-hook-1.js", parkBudgetMs: 60_000 };

test("merge delivers the session's gate group into the staged home's config/hooks.json", () => {
	const root = tmpRoot();
	const bridgeDir = path.join(root, "bridge");
	fs.mkdirSync(bridgeDir, { recursive: true });
	stageGateHooks(bridgeDir, stageOpts);
	const stagedHome = path.join(root, "home");
	fs.mkdirSync(path.join(stagedHome, "config"), { recursive: true });

	const result = mergeGateGroupIntoAcpHome(stagedHome, bridgeDir);
	assert.equal(result.wrote, true);
	const written = JSON.parse(fs.readFileSync(path.join(stagedHome, "config", "hooks.json"), "utf8")) as Record<
		string,
		unknown
	>;
	assert.deepEqual(written[gateGroupKey()], buildGateGroup(stageOpts));
});

test("merge preserves foreign groups (the user's global hooks copied in by stageAgyHome)", () => {
	const root = tmpRoot();
	const bridgeDir = path.join(root, "bridge");
	fs.mkdirSync(bridgeDir, { recursive: true });
	stageGateHooks(bridgeDir, stageOpts);
	const stagedHome = path.join(root, "home");
	fs.mkdirSync(path.join(stagedHome, "config"), { recursive: true });
	fs.writeFileSync(
		path.join(stagedHome, "config", "hooks.json"),
		JSON.stringify({ herdr: { PreInvocation: [{ command: "bash x.sh", timeout: 10, type: "command" }] } }),
	);

	mergeGateGroupIntoAcpHome(stagedHome, bridgeDir);
	const written = JSON.parse(fs.readFileSync(path.join(stagedHome, "config", "hooks.json"), "utf8")) as Record<
		string,
		Record<string, unknown>
	>;
	assert.ok(written.herdr, "foreign group must survive");
	assert.ok(written[gateGroupKey()], "gate group must land");
});

test("merge overwrites an unparsable existing file gate-only", () => {
	const root = tmpRoot();
	const bridgeDir = path.join(root, "bridge");
	fs.mkdirSync(bridgeDir, { recursive: true });
	stageGateHooks(bridgeDir, stageOpts);
	const stagedHome = path.join(root, "home");
	fs.mkdirSync(path.join(stagedHome, "config"), { recursive: true });
	fs.writeFileSync(path.join(stagedHome, "config", "hooks.json"), "{ not json");

	const result = mergeGateGroupIntoAcpHome(stagedHome, bridgeDir);
	assert.equal(result.wrote, true);
	const written = JSON.parse(fs.readFileSync(path.join(stagedHome, "config", "hooks.json"), "utf8")) as Record<
		string,
		unknown
	>;
	assert.deepEqual(Object.keys(written), [gateGroupKey()]);
});

test("merge throws on a corrupt staged gate file instead of failing open", () => {
	const root = tmpRoot();
	const bridgeDir = path.join(root, "bridge");
	fs.mkdirSync(path.join(bridgeDir, ".agents"), { recursive: true });
	fs.writeFileSync(path.join(bridgeDir, ".agents", "hooks.json"), "{ corrupt");
	const stagedHome = path.join(root, "home");
	fs.mkdirSync(path.join(stagedHome, "config"), { recursive: true });

	// Gate on + undeliverable must fail closed (the connection start throws),
	// never silently run ACP ungated.
	assert.throws(() => mergeGateGroupIntoAcpHome(stagedHome, bridgeDir));
	assert.equal(fs.existsSync(path.join(stagedHome, "config", "hooks.json")), false);
});

test("merge is a no-op when this session never staged a gate", () => {
	const root = tmpRoot();
	const bridgeDir = path.join(root, "bridge");
	fs.mkdirSync(bridgeDir, { recursive: true });
	const stagedHome = path.join(root, "home");
	fs.mkdirSync(path.join(stagedHome, "config"), { recursive: true });

	const result = mergeGateGroupIntoAcpHome(stagedHome, bridgeDir);
	assert.equal(result.wrote, false);
	assert.match(result.reason ?? "", /no staged gate/);
	assert.equal(fs.existsSync(path.join(stagedHome, "config", "hooks.json")), false, "no file created for an unused gate");
});

test("merge is idempotent: re-merging keeps one gate group", () => {
	const root = tmpRoot();
	const bridgeDir = path.join(root, "bridge");
	fs.mkdirSync(bridgeDir, { recursive: true });
	stageGateHooks(bridgeDir, stageOpts);
	const stagedHome = path.join(root, "home");
	fs.mkdirSync(path.join(stagedHome, "config"), { recursive: true });

	mergeGateGroupIntoAcpHome(stagedHome, bridgeDir);
	mergeGateGroupIntoAcpHome(stagedHome, bridgeDir);
	const written = JSON.parse(fs.readFileSync(path.join(stagedHome, "config", "hooks.json"), "utf8")) as Record<
		string,
		unknown
	>;
	assert.deepEqual(Object.keys(written), [gateGroupKey()]);
});
