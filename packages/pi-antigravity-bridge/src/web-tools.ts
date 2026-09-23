// Web tools for Pi: agy_web_search + agy_read_url, backed by one-shot
// search-only `agy` runs. Off by default (config.webTools); their audience is
// sessions driven by NON-Antigravity providers - inside agy sessions the model
// already has search_web/read_url_content natively (live-probed 2026-09-23 on
// both engines).
//
// Each call spawns `agy --agent <temporary> --print <query> --mode plan
// --output-format stream-json` with a temporary agent restricted to
// search_web + read_url_content (bridge MCP inheritance off), then gates the
// answer on an observed allowed-tool step. Gate accepts both status spellings
// the CLI has shipped (driver.ts: "SUCCESS" live, "OK" older builds).
//
// Temp agent dirs live in the user-global ~/.gemini/config/agents (the only
// location agy 1.2.9 discovers; no --agent-dir flag exists). Normal cleanup is
// the `finally`; SIGKILL can orphan, so sweepStaleWebAgents() removes leftovers
// at registration - same hygiene doctrine as mcp-registration's pid sweep.

import { spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import { mkdirSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { Type } from "typebox";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

export const WEB_AGENT_PREFIX = "pi-bridge-web-";

const DEADLINE_MS = 120_000;
const MAX_OUTPUT_BYTES = 2 * 1024 * 1024;
const MAX_QUERY_CHARS = 2000;
const ALLOWED_TOOLS = new Set(["search_web", "read_url_content"]);
const ORPHAN_GRACE_MS = 24 * 60 * 60 * 1000;

/** ~/.gemini/config/agents - the directory agy scans for named agents. */
export function webAgentsRoot(): string {
	return path.join(os.homedir(), ".gemini", "config", "agents");
}

/** Remove leftover pi-bridge-web-* agent dirs: dead-pid markers always, and
 *  marker-less dirs only after a grace period (a live sibling process may be
 *  between mkdir and its pid write). Never touches foreign agent dirs. */
export function sweepStaleWebAgents(root: string = webAgentsRoot(), now = Date.now()): void {
	let entries: string[];
	try {
		entries = readdirSync(root);
	} catch {
		return; // no agents dir yet: nothing to sweep
	}
	for (const entry of entries) {
		if (!entry.startsWith(WEB_AGENT_PREFIX)) continue;
		try {
			if (isStaleWebAgentDir(path.join(root, entry), now)) {
				rmSync(path.join(root, entry), { recursive: true, force: true });
			}
		} catch {
			// vanished mid-sweep: nothing to remove
		}
	}
}

/** Stale = a dead-pid marker, or no marker at all and older than the grace
 *  period (a live sibling may sit between mkdir and its pid write). */
function isStaleWebAgentDir(dir: string, now: number): boolean {
	let raw = "";
	try {
		raw = readFileSync(path.join(dir, ".pid"), "utf8").trim();
	} catch {
		raw = ""; // no marker yet: decide by age
	}
	const pid = Number.parseInt(raw, 10);
	if (Number.isInteger(pid) && pid > 0) return !pidAlive(pid);
	try {
		return now - statSync(dir).mtimeMs > ORPHAN_GRACE_MS;
	} catch {
		return true; // dir vanished mid-sweep
	}
}

/** Best effort: a signal-able pid proves *a* live process, not the original
 *  owner; pid reuse can mask an orphan until the 24h age bound. Same residual
 *  as mcp-registration's sweep. */
function pidAlive(pid: number): boolean {
	try {
		process.kill(pid, 0);
		return true;
	} catch {
		return false;
	}
}

export type WebRunResult =
	| { ok: true; response: string }
	| { ok: false; error: string };

export interface WebRunOptions {
	/** Query (agy_web_search) or URL-reading instruction (agy_read_url). */
	prompt: string;
	/** The single allowed tool whose DONE step the answer is gated on. */
	gatedTool: "search_web" | "read_url_content";
	/** Server binary; defaults to AGY_BIN or PATH, matching ask-tool. */
	bin?: string;
	/** Agents root override (tests); defaults to the user-global agy dir. */
	agentsRoot?: string;
	/** Working directory handed to agy. */
	cwd?: string;
	timeoutMs?: number;
	signal?: AbortSignal;
	log?: (event: string, data?: unknown, level?: "info" | "warn" | "error") => void;
}

/** One gated one-shot web run. Creates a unique restricted agent, streams the
 *  NDJSON frames, refuses answers with no observed allowed-tool step, and
 *  always removes the agent dir. */
export async function runWebAgent(opts: WebRunOptions): Promise<WebRunResult> {
	const root = opts.agentsRoot ?? webAgentsRoot();
	mkdirSync(root, { recursive: true });
	// Nonce: two parallel tool calls in one process can share a millisecond;
	// a shared dir would let one call's finally delete the other's agent.
	const agentName = `${WEB_AGENT_PREFIX}${process.pid}-${Date.now().toString(36)}-${randomBytes(4).toString("hex")}`;
	const agentDir = path.join(root, agentName);
	mkdirSync(agentDir, { recursive: true, mode: 0o700 });
	// commandExecutionPolicy stays at the fork-validated "auto": the template's
	// tools list has no command tool and plan mode blocks edits; an unvalidated
	// stricter enum risks agent discovery failing outright.
	writeFileSync(
		path.join(agentDir, "agent.md"),
		`---\nname: ${agentName}\ndescription: Temporary Pi web delegate\nmainAgent: true\nsubagent: false\nmodel: inherit\nexcludeDefaultComponents: true\ninheritCustomizations: false\ninheritMcp: false\ncommandExecutionPolicy: auto\ntools:\n  - search_web\n  - read_url_content\nskills: []\nrules: []\nagents: []\nmcpServers: []\n---\n\nAnswer the user's query using search_web (and read_url_content when a page must be opened). Cite sources. Use no other tools.\n`,
		{ mode: 0o600 },
	);
	writeFileSync(path.join(agentDir, ".pid"), `${process.pid}\n`, { mode: 0o600 });

	const bin = opts.bin ?? process.env.AGY_BIN ?? "agy";
	const args = [
		"--agent", agentName,
		"--print", opts.prompt,
		"--mode", "plan",
		"--output-format", "stream-json",
		"--disable-slash-commands",
	];
	opts.log?.("web-run-start", { agent: agentName, gatedTool: opts.gatedTool });

	const child = spawn(bin, args, { cwd: opts.cwd ?? process.cwd(), stdio: ["ignore", "pipe", "pipe"], windowsHide: true });
	const stop = () => {
		if (!child.killed) child.kill();
	};
	const onAbort = () => stop();
	opts.signal?.addEventListener("abort", onAbort, { once: true });
	const timer = setTimeout(stop, opts.timeoutMs ?? DEADLINE_MS);

	let buffer = "";
	let bytes = 0;
	let stderrTail = "";
	let failed = "";
	let allowedToolUsed = false;
	let response = "";

	try {
		child.stdout?.on("data", (chunk: Buffer) => {
			bytes += chunk.length;
			if (bytes > MAX_OUTPUT_BYTES && !failed) {
				failed = "Antigravity web run output exceeded the 2 MiB limit";
				stop();
				return;
			}
			buffer += chunk.toString("utf8");
			let newline = buffer.indexOf("\n");
			while (newline !== -1 && !failed) {
				handleFrame(buffer.slice(0, newline));
				buffer = buffer.slice(newline + 1);
				newline = buffer.indexOf("\n");
			}
		});
		child.stderr?.on("data", (chunk: Buffer) => {
			stderrTail = (stderrTail + chunk.toString("utf8")).slice(-1000);
		});
		const code = await new Promise<number | null>((resolve, reject) => {
			child.once("error", reject);
			child.once("close", resolve);
		});
		if (!failed && opts.signal?.aborted) failed = "web run aborted";
		if (!failed && code !== 0) failed = `agy exited with code ${code}${stderrTail ? `: ${stderrTail.trim().slice(-300)}` : ""}`;
		if (!failed && !allowedToolUsed) failed = `Antigravity returned an answer without an observed ${opts.gatedTool} step; refusing it as unverified`;
		if (!failed && response === "") failed = "Antigravity web run produced no answer";
		if (failed) {
			opts.log?.("web-run-failed", { agent: agentName, error: failed }, "warn");
			return { ok: false, error: failed };
		}
		opts.log?.("web-run-ok", { agent: agentName });
		return { ok: true, response };
	} catch (error) {
		const message = error instanceof Error ? error.message : String(error);
		opts.log?.("web-run-failed", { agent: agentName, error: message }, "warn");
		return { ok: false, error: message };
	} finally {
		clearTimeout(timer);
		opts.signal?.removeEventListener("abort", onAbort);
		stop();
		rmSync(agentDir, { recursive: true, force: true });
	}

	function handleFrame(line: string): void {
		if (failed || !line.startsWith("{")) return;
		let frame: unknown;
		try {
			frame = JSON.parse(line);
		} catch {
			return; // non-JSON chatter: ignore, matching the driver's line loop
		}
		if (typeof frame !== "object" || frame === null) return;
		const record = frame as Record<string, unknown>;
		if (record.event === "step_update" && typeof record.step_update === "object" && record.step_update !== null) {
			const step = record.step_update as Record<string, unknown>;
			if (step.step_type !== "tool" || typeof step.tool_name !== "string") return;
			if (ALLOWED_TOOLS.has(step.tool_name)) {
				// Drift tolerance: DONE today, OK on older builds (driver.ts:507).
				if (step.state === "DONE" || step.state === "OK") allowedToolUsed = true;
			} else if (step.state === "ACTIVE" || step.state === "DONE") {
				failed = `Antigravity web agent used a disallowed tool: ${step.tool_name}`;
				stop();
			}
			return;
		}
		if (record.event === "result" && typeof record.result === "object" && record.result !== null) {
			const result = record.result as Record<string, unknown>;
			if (result.status !== "SUCCESS" && result.status !== "OK") {
				failed = `Antigravity web run reported status ${String(result.status)}`;
				stop();
				return;
			}
			if (typeof result.response === "string") response = result.response;
		}
	}
}

const QUOTA_NOTE =
	"Each call spawns a one-shot Antigravity CLI process and consumes your Antigravity quota.";

const toolText = (text: string) => ({ content: [{ type: "text" as const, text }], details: {} });
const toolError = (text: string) => ({ content: [{ type: "text" as const, text }], isError: true as const, details: {} });

/** Register agy_web_search + agy_read_url. Call only when config.webTools is
 *  on - registration is the opt-in. */
export function registerWebTools(
	pi: ExtensionAPI,
	opts: { bin?: string; cwd?: string; timeoutMs?: number; log?: WebRunOptions["log"] } = {},
): void {
	sweepStaleWebAgents();

	pi.registerTool({
		name: "agy_web_search",
		label: "Antigravity Web Search",
		description: `Search the live web via Google Antigravity. Returns a short cited answer, not raw results. Use when the question needs current information. ${QUOTA_NOTE}`,
		parameters: Type.Object({
			query: Type.String({
				description: `What to search for. Max ${MAX_QUERY_CHARS} characters.`,
			}),
		}),
		async execute(_toolCallId, params, signal) {
			const query = typeof params.query === "string" ? params.query.trim() : "";
			if (query === "") return toolError("query must be a non-empty string");
			if (query.length > MAX_QUERY_CHARS) return toolError(`query exceeds ${MAX_QUERY_CHARS} characters`);
			const run = await runWebAgent({
				prompt: query,
				gatedTool: "search_web",
				bin: opts.bin,
				cwd: opts.cwd,
				timeoutMs: opts.timeoutMs,
				signal,
				log: opts.log,
			});
			if (!run.ok) return toolError(`Web search failed: ${run.error}`);
			return toolText(run.response);
		},
	});

	pi.registerTool({
		name: "agy_read_url",
		label: "Antigravity Read URL",
		description: `Fetch the content of a public http(s) URL via Google Antigravity and get its main content back as text. Use for pages you need to read. ${QUOTA_NOTE}`,
		parameters: Type.Object({
			url: Type.String({
				description: "Absolute http(s) URL to read.",
			}),
		}),
		async execute(_toolCallId, params, signal) {
			const raw = typeof params.url === "string" ? params.url.trim() : "";
			let url: URL;
			try {
				url = new URL(raw);
			} catch {
				return toolError("url must be an absolute http(s) URL");
			}
			// Allowlist: a URL parameter is untrusted input, and schemes like
			// file: or javascript: must never reach the delegate.
			if (url.protocol !== "http:" && url.protocol !== "https:") {
				return toolError("only http and https URLs are supported");
			}
			const run = await runWebAgent({
				prompt: `Read the content of ${url.toString()} with read_url_content and return its main content as plain text. Keep the structure (headings, lists) but drop navigation and ads.`,
				gatedTool: "read_url_content",
				bin: opts.bin,
				cwd: opts.cwd,
				timeoutMs: opts.timeoutMs,
				signal,
				log: opts.log,
			});
			if (!run.ok) return toolError(`URL read failed: ${run.error}`);
			return toolText(run.response);
		},
	});
}
