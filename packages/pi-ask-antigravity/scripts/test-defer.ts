// Verifies the bridge-defer guard in pi-ask-antigravity across BOTH detection
// paths:
//   1. In-process Symbol.for flag (bridge loaded earlier this session).
//   2. Bridge package.json on disk at pi's install locations (order-independent).
//
// Pi loads each package with a separate module root (docs/packages.md), so the
// old require.resolve approach was unreliable; this tests the real mechanism.
//
// Usage: npx tsx scripts/test-defer.ts

import fs from "node:fs";
import os from "node:os";
import path from "node:path";

interface Captured {
	provider?: boolean;
	command?: boolean;
	tool?: boolean;
}

function mockApi(c: Captured) {
	return {
		registerProvider: () => {
			c.provider = true;
		},
		registerCommand: () => {
			c.command = true;
		},
		registerTool: () => {
			c.tool = true;
		},
	};
}

let failures = 0;
const check = (label: string, cond: boolean) => {
	if (!cond) failures++;
	console.log(`  ${cond ? "PASS" : "FAIL"}  ${label}`);
};

const FLAG = Symbol.for("pi-antigravity-bridge:active");
// Realistic on-disk path the guard checks (global npm layout).
const bridgePkgPath = path.join(
	os.homedir(),
	".pi",
	"agent",
	"npm",
	"node_modules",
	"@estebanforge",
	"pi-antigravity-bridge",
	"package.json",
);

const ext = (await import("../extensions/index.js")).default;

// --- Scenario 1: bridge absent (no flag, no disk) -> tool registers ---------
console.log("defer test: bridge ABSENT");
delete (globalThis as Record<symbol, unknown>)[FLAG];
const c1: Captured = {};
await ext(mockApi(c1) as never);
check("registers AskAntigravity tool", c1.tool === true);
check("registers /agy command", c1.command === true);

// --- Scenario 2: in-process flag set (bridge loaded first) -> defer ---------
console.log("defer test: bridge ACTIVE via in-process flag");
(globalThis as Record<symbol, unknown>)[FLAG] = true;
try {
	const c2: Captured = {};
	await ext(mockApi(c2) as never);
	check("flag: registers NOTHING (no tool)", c2.tool === undefined);
	check("flag: registers NOTHING (no provider)", c2.provider === undefined);
	check("flag: registers NOTHING (no command)", c2.command === undefined);
} finally {
	delete (globalThis as Record<symbol, unknown>)[FLAG];
}

// --- Scenario 3: bridge package.json on disk (order-independent) -> defer ---
console.log("defer test: bridge PRESENT on disk (npm install path)");
fs.mkdirSync(path.dirname(bridgePkgPath), { recursive: true });
fs.writeFileSync(bridgePkgPath, JSON.stringify({ name: "@estebanforge/pi-antigravity-bridge", version: "1.0.0" }));
try {
	const c3: Captured = {};
	await ext(mockApi(c3) as never);
	check("disk: registers NOTHING (no tool)", c3.tool === undefined);
	check("disk: registers NOTHING (no provider)", c3.provider === undefined);
	check("disk: registers NOTHING (no command)", c3.command === undefined);
} finally {
	fs.rmSync(bridgePkgPath, { force: true });
	try {
		fs.rmdirSync(path.dirname(bridgePkgPath));
	} catch {
		/* @estebanforge dir may have other contents */
	}
}

console.log("");
console.log(failures === 0 ? "ALL PASS" : `${failures} FAILURE(S)`);
process.exit(failures === 0 ? 0 : 1);
