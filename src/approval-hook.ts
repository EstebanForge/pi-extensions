// Staging for the approval-gate hooks.json (docs/TODO.md 2.5).
//
// The agy CLI discovers `.agents/hooks.json` in its --add-dir directories
// (live-probed 2026-09-22: stream-json and interactive sessions load and
// execute PreToolUse hooks from any add-dir; print mode reads only the
// global config) and fires them before a gated tool runs (V2: deny
// honored, reason reaches the model; V3: hook TIMEOUT = soft-pass, agy
// proceeds ungated). Therefore:
//   - the staged handler timeout must exceed the whole park budget with
//     margin (never rely on timeout as a deny), and
//   - the staged command delegates to the bundled poll script, which
//     early-acks and polls the bridge for the terminal decision.
//
// ISOLATION (issue #5): the gate group is staged into the session-private
// per-pid bridge dir (bridgeMcpConfigDir()), NOT the shared workspace. Only
// this session's agy gets that dir as an extra --add-dir (driver.ts), so
// standalone IDE/CLI sessions in the workspace can never load the gate -
// neither denying their tools while pi is idle nor parking their calls
// into a live pi turn. The private file is ours alone: no merge, no
// foreign-file backup dance.
//
// Legacy: 1.6.x staged into the shared workspace `.agents/hooks.json`.
// sweepWorkspaceGateGroups() removes gate groups left there by sessions
// whose pid is dead; groups of live sessions and foreign groups are never
// touched.
//
// Run: npm test

import fs from "node:fs";
import path from "node:path";
import { bridgeMcpConfigDir } from "./mcp-server.js";

export const HOOK_GROUP = "pi-bridge-gate";

/** Group-key namespace. Each session's group is keyed per-pid
 *  (`pi-bridge-gate-<pid>`): the key doubles as the ownership proof for the
 *  legacy workspace sweep, which may only remove groups whose owning
 *  session is dead (a stale shared key must never strip a live session's
 *  gate - audit 2026-09-07). */
export const GATE_GROUP_PREFIX = "pi-bridge-gate";

/** This session's group key. */
export function gateGroupKey(pid: number = process.pid): string {
	return `${GATE_GROUP_PREFIX}-${pid}`;
}

/** True if the process is running (EPERM counts: alive but not ours). */
function pidAlive(pid: number): boolean {
	if (!Number.isInteger(pid) || pid <= 0) return false;
	try {
		process.kill(pid, 0);
		return true;
	} catch (e) {
		return (e as NodeJS.ErrnoException).code === "EPERM";
	}
}

/** Which session a gate group belongs to, parsed from the script path its
 *  command embeds (`.../approval-hook-<pid>.js`). The pid is the ownership
 *  proof: the script is per-pid (0600, written by that session). Returns
 *  null for groups we cannot attribute (foreign/future formats - never
 *  touched). */
function gateGroupPid(group: unknown): number | null {
	const m = /approval-hook-(\d+)\.js/.exec(JSON.stringify(group));
	return m ? Number(m[1]) : null;
}

/** agy native tools worth gating: everything that mutates the machine. */
export const GATED_AGY_TOOLS =
	"create_file|write_to_file|replace_file_content|multi_replace_file_content|edit_file|run_command";

/** The same list as a set, for the bridge's POST /approval validation: a
 *  payload for anything else is answered with a direct deny (defense in
 *  depth - the hooks matcher should never let one through). */
export const GATED_AGY_TOOL_SET: ReadonlySet<string> = new Set(GATED_AGY_TOOLS.split("|"));

export interface StageOptions {
	/** Bridge HTTP port (the approval endpoints live on the bridge server). */
	port: number;
	/** Bridge shared secret (x-bridge-token). */
	token: string;
	/** Path to the bundled poll script (written by the caller). */
	scriptPath: string;
	/** Full park budget in ms; the staged hook timeout exceeds it. */
	parkBudgetMs: number;
}

/** Source of the staged poll script. Written to disk by the caller (data
 *  dir), referenced by absolute path from the staged hooks.json. Early-acks
 *  via POST /approval, then polls GET /approval/<ticket> until a terminal
 *  decision or the deadline. Terminal: prints the JSON decision on stdout.
 *  Deadline hit: prints {"decision":"deny", ...} (fail closed) - agy may
 *  still soft-pass a timed-out hook, but a printed deny is honored (V2). */
export function hookScriptSource(opts: { port: number; token: string; deadlineMs: number }): string {
	return `#!/usr/bin/env node
// Bridge approval hook (generated; do not edit). Polls the pi-antigravity-bridge.
const PORT = ${opts.port};
const TOKEN = ${JSON.stringify(opts.token)};
const DEADLINE = Date.now() + ${opts.deadlineMs};
// Per-fetch abort: a hung fetch must never outlive the park deadline. A hook
// killed by agy's staged timeout soft-passes (V3), so the script itself must
// always reach a printed deny.
const POST_TIMEOUT_MS = Math.min(10_000, ${opts.deadlineMs});
let body = "";
process.stdin.setEncoding("utf8");
for await (const chunk of process.stdin) body += chunk;
let ticket = "";
try {
	const res = await fetch(\`http://127.0.0.1:\${PORT}/approval\`, {
		method: "POST",
		headers: { "content-type": "application/json", "x-bridge-token": TOKEN },
		body,
		signal: AbortSignal.timeout(POST_TIMEOUT_MS),
	});
	const json = await res.json();
	// Ungated payloads get a terminal decision right on the POST (no park).
	if (json && typeof json === "object" && typeof json.decision === "string") {
		console.log(JSON.stringify(json));
		process.exit(0);
	}
	ticket = json?.ticket ?? "";
} catch {}
if (!ticket) {
	console.log(JSON.stringify({ decision: "deny", reason: "approval gate unreachable (bridge down?)" }));
	process.exit(0);
}
while (Date.now() < DEADLINE) {
	await new Promise((r) => setTimeout(r, 500));
	try {
		const res = await fetch(\`http://127.0.0.1:\${PORT}/approval/\${encodeURIComponent(ticket)}\`, {
			headers: { "x-bridge-token": TOKEN },
			// Bounded by the remaining park budget: an aborted poll falls through
			// to the loop condition and lands on the deadline deny.
			signal: AbortSignal.timeout(Math.max(1, DEADLINE - Date.now())),
		});
		const json = await res.json();
		if (json?.status !== "pending") {
			if (json && typeof json === "object" && typeof json.decision === "string") {
				console.log(JSON.stringify(json));
			} else {
				console.log(JSON.stringify({ decision: "deny", reason: "gate returned no decision" }));
			}
			process.exit(0);
		}
	} catch {}
}
console.log(JSON.stringify({ decision: "deny", reason: "approval gate deadline exceeded" }));
`;
}

/** Hook timeout (seconds) staged for a given park budget: the budget plus a
 *  60s margin, minimum 60s. V3: a timed-out hook soft-passes, so this must
 *  never be smaller than the human can plausibly need. */
export function stagedTimeoutSeconds(parkBudgetMs: number): number {
	return Math.max(60, Math.ceil(parkBudgetMs / 1000) + 60);
}

/** Build our hooks.json group for private-dir staging. */
export function buildGateGroup(opts: StageOptions): Record<string, unknown> {
	const command = `node ${JSON.stringify(opts.scriptPath)}`;
	return {
		enabled: true,
		PreToolUse: [
			{
				matcher: GATED_AGY_TOOLS,
				hooks: [
					{
						type: "command",
						command,
						timeout: stagedTimeoutSeconds(opts.parkBudgetMs),
					},
				],
			},
		],
	};
}

export interface StageResult {
	wrote: boolean;
	/** Why nothing was written (already current, ...). */
	reason?: string;
}

/** The session-private hooks.json for gate staging (beside the bridge's
 *  mcp_config.json in the per-pid add-dir). */
function gateHooksFile(dir: string = bridgeMcpConfigDir()): string {
	return path.join(dir, ".agents", "hooks.json");
}

/** True if this session's gate hooks are currently staged in the private
 *  add-dir. The driver uses this to decide whether to pass the extra
 *  --add-dir even when the MCP config is absent. */
export function gateHooksStaged(dir: string = bridgeMcpConfigDir()): boolean {
	return fs.existsSync(gateHooksFile(dir));
}

/** Stage the gate group into the session-private per-pid dir:
 *  <bridgeMcpConfigDir()>/.agents/hooks.json. The dir (and everything in
 *  it) belongs to this pid alone, so the write is a plain atomic replace -
 *  no merge, no foreign-file guards. */
export function stageGateHooks(dir: string, opts: StageOptions): StageResult {
	const file = gateHooksFile(dir);
	const next = JSON.stringify({ [gateGroupKey()]: buildGateGroup(opts) }, null, 2) + "\n";
	try {
		if (fs.readFileSync(file, "utf8") === next) return { wrote: false, reason: "already staged" };
	} catch {
		/* absent or unreadable: write */
	}
	fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
	const tmp = `${file}.${process.pid}.tmp`;
	try {
		fs.writeFileSync(tmp, next, { mode: 0o600 });
		fs.renameSync(tmp, file);
	} catch (err) {
		try {
			fs.unlinkSync(tmp);
		} catch {
			/* nothing */
		}
		throw err;
	}
	return { wrote: true };
}

/** Remove the private gate hooks file. The rest of the per-pid dir (the MCP
 *  config) is managed by the bridge server lifecycle and stays until close. */
export function removeGateHooks(dir: string = bridgeMcpConfigDir()): StageResult {
	const file = gateHooksFile(dir);
	if (!fs.existsSync(file)) return { wrote: false, reason: "no hooks.json" };
	try {
		fs.rmSync(file, { force: true });
		return { wrote: true };
	} catch {
		return { wrote: false, reason: "remove failed" };
	}
}

/** Legacy cleanup (issue #5): remove gate groups that 1.6.x staged into the
 *  SHARED workspace `.agents/hooks.json` when their owning session is dead
 *  (its bridge is gone; the hook would fail closed forever). Live sessions'
 *  groups and groups we cannot attribute are never touched; foreign groups
 *  and foreign files are never touched. Returns the number of swept groups. */
export function sweepWorkspaceGateGroups(workspaceDir: string): number {
	const file = path.join(workspaceDir, ".agents", "hooks.json");
	let current: Record<string, unknown>;
	try {
		if (fs.lstatSync(file).isSymbolicLink()) return 0;
		const parsed: unknown = JSON.parse(fs.readFileSync(file, "utf8"));
		if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return 0;
		current = parsed as Record<string, unknown>;
	} catch {
		return 0;
	}
	let swept = 0;
	for (const key of Object.keys(current)) {
		const isGateGroup = key === GATE_GROUP_PREFIX || key.startsWith(`${GATE_GROUP_PREFIX}-`);
		if (!isGateGroup) continue;
		const pid = gateGroupPid(current[key]);
		if (pid === null || pidAlive(pid)) continue;
		delete current[key];
		swept += 1;
	}
	if (swept === 0) return 0;
	try {
		fs.writeFileSync(file, JSON.stringify(current, null, 2) + "\n");
	} catch {
		return 0;
	}
	return swept;
}
