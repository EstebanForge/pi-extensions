// ACP connection: owns the agy acp process, the JSON-RPC session over its
// stdio, and the protocol methods the driver needs.
//
// Verified live against agy 1.5.3:
//   - initialize: {protocolVersion:1, clientCapabilities{fs:false,terminal:false}}
//   - model and thought_level are separate session config options
//   - session/cancel is a notification; the prompt settles with stopReason cancelled
//   - session/request_permission: skipPermissions turns answer the first
//     allow option synchronously; otherwise a wired human handler PARKS the
//     request (the JSON-RPC reply waits for the decision), and everything
//     else fail-closes to the first reject option
//   - session/load replays history as notifications BEFORE its response; the
//     driver suppresses updates while the load is in flight
//   - mcpServers entries: {name, type:"http", url, headers:[]} — headers is a
//     LIST; a dead URL is accepted at session time (lazy connect)

import { spawn, type ChildProcess } from "node:child_process";
import { frameCarriesUsage } from "./events.js";
import type { AgyUsage } from "../driver-types.js";
import { redactText } from "../redact.js";
import { JsonRpcResponseError, JsonRpcSession } from "./jsonrpc.js";
import { removeStagedAgyHome, stageAgyHome } from "./home.js";

export interface AcpMcpServer {
	name: string;
	type: "http" | "sse";
	url: string;
	headers: Array<{ name: string; value: string }>;
}

export interface AcpSessionInfo {
	sessionId: string;
}

/** Auth failed (-32000 family). Message carries the remediation the server
 *  provided plus the /agy auth-manual pointer. */
export class AcpAuthError extends Error {
	constructor(message: string) {
		super(message);
		this.name = "AcpAuthError";
	}
}

export interface AcpConnectionOptions {
	/** Process working directory for the spawned server. */
	cwd: string;
	/** Resolved server binary (or node executable when binArgs carries the
	 *  fake-server script for tests). */
	bin: string;
	binArgs?: string[];
	/** Native agy only: filter per-pid bridges out of inherited global MCP. */
	isolateHome?: boolean | { geminiHome?: string; parentDir?: string };
	extraEnv?: Record<string, string>;
	log: (msg: string, data?: unknown) => void;
	/** Verified `session/update` payloads (post-suppression). */
	onUpdate: (sessionId: string | null, update: unknown) => void;	/** Process exit. Fires exactly once. */
	onExit: (info: { code: number | null; signal: string | null; stderrTail: string }) => void;
	/** mcpServers entries for session/new AND session/load (run 6: load takes
	 *  the same param). Evaluated lazily per call. */
	mcpServers?: () => AcpMcpServer[];
	/** Permission policy for session/request_permission, evaluated per request:
	 *  "auto" selects the first allow option; "deny" consults the human
	 *  handler (parking) or fail-closes to the first reject option. Absent =
	 *  deny (fail closed). */
	permissions?: () => "auto" | "deny";
	/** Human gate for "deny"-policy turns. The request is PARKED: the JSON-RPC
	 *  reply waits until the handler settles. The returned optionId is
	 *  validated against the server's options; undefined/null deny. Absent =
	 *  synchronous deny (fail closed). */
	onPermissionRequest?: AcpPermissionHandler;
	/** Park budget for one permission dialog. Tests shrink it. */
	permissionParkMs?: number;
}

const INIT_TIMEOUT_MS = 30_000;
const SESSION_OP_TIMEOUT_MS = 20_000;

/** Human-decision budget for one parked permission request. Mirrors the
 *  approval-gate park budget (APPROVAL_PARK_TIMEOUT_MS): the dialog must
 *  deny by itself, never hold the agy prompt open forever. */
const PERMISSION_PARK_MS = 480_000;

/** One session/request_permission option block (the subset we consume). */
export interface AcpPermissionOption {
	optionId?: string;
	kind?: string;
	name?: string;
}

/** Payload handed to the permission handler when the server asks for a human
 *  decision. Options are server-defined data; the handler returns the chosen
 *  optionId, or undefined/null to deny. */
export interface AcpPermissionRequest {
	sessionId?: string;
	options: AcpPermissionOption[];
	toolCall?: { toolCallId?: string; kind?: string; title?: string };
}

export type AcpPermissionHandler = (req: AcpPermissionRequest) => Promise<string | null | undefined>;


export class AcpConnection {
	#opts: AcpConnectionOptions;
	#child: ChildProcess | undefined;
	#rpc: JsonRpcSession | undefined;
	#stderrTail = "";
	#stagedHome: string | undefined;
	#usageSeen = false;
	/** Set ONLY by a parsed PromptResponse.usage; this gates estimate
	 *  suppression. #usageSeen stays diagnostic: any usage-shaped frame trips
	 *  it, and the connection outlives turns. */
	#exactUsageSeen = false;
	#exited = false;
	#killed = false;
	#suppressUpdates = false;
	#updateSessionId: string | null = null;
	agentInfo: Record<string, unknown> | undefined;
	/** Last known mode/model config echo from set_config_option results. */
	lastConfigOptions: unknown = undefined;
	/** Parked permission dialogs: each entry settles its own request as
	 *  cancelled. Cancellation and connection death drain the set. */
	#permissionPending = new Set<() => void>();
	/** allow_always / reject_always answers, keyed by toolCall kind|title for
	 *  the life of this connection: identical requests skip the dialog. */
	#permissionMemory = new Map<string, string>();

	constructor(opts: AcpConnectionOptions) {
		this.#opts = opts;
	}

	get alive(): boolean {
		return this.#child !== undefined && !this.#exited && !this.#killed;
	}

	get pid(): number | undefined {
		return this.#child?.pid;
	}

	get stderrTail(): string {
		// Redacted at the boundary: the raw tail stays internal, every consumer
		// (doctor display, driver exit logs, failure messages) sees redacted text.
		return redactText(this.#stderrTail);
	}

	/** Gate B watch: latched true once any session/update frame carried
	 *  usage/token fields. /agy doctor surfaces it the day upstream starts
	 *  sending token counts; silent until then. */
	get usageSeen(): boolean {
		return this.#usageSeen;
	}

	/** True once the server sent real per-turn usage (PromptResponse.usage). */
	get exactUsageSeen(): boolean {
		return this.#exactUsageSeen;
	}

	/** While true, session/update notifications are dropped: they are the
	 *  full-text history replay that precedes a session/load response, never
	 *  live generation (run 6). */
	set updateSuppression(flag: boolean) {
		this.#suppressUpdates = flag;
	}

	/** Spawn the server and perform the initialize handshake. Idempotent per
	 *  instance: call once. */
	async start(): Promise<void> {
		if (this.#child) return;
		const args = [...(this.#opts.binArgs ?? [])];
		if (this.#opts.isolateHome) {
			this.#stagedHome = stageAgyHome(typeof this.#opts.isolateHome === "object" ? this.#opts.isolateHome : {});
			args.push("--gemini-dir", this.#stagedHome);
		}
		let child: ChildProcess;
		try {
			child = spawn(this.#opts.bin, args, {
				cwd: this.#opts.cwd,
				stdio: ["pipe", "pipe", "pipe"],
				detached: process.platform !== "win32",
				windowsHide: true,
				...(this.#opts.extraEnv ? { env: { ...process.env, ...this.#opts.extraEnv } } : {}),
			});
		} catch (err) {
			this.#releaseHome();
			throw err;
		}
		this.#child = child;
		child.stdout?.setEncoding("utf8");
		child.stderr?.setEncoding("utf8");
		// Pipe failures arrive asynchronously as stream 'error' events; the sync
		// try/catch in #write cannot see them. Without this listener an EPIPE
		// (server died mid-handshake) is uncaught and kills pi.
		child.stdin?.on("error", (err) => {
			this.#opts.log("stdin-error", { message: redactText(err.message) });
			if (!this.#exited && !this.#killed) this.#finish(redactText(err.message));
		});

		const rpc = new JsonRpcSession({
			send: (frame) => this.#write(frame),
			onRequest: (method, params) => this.#onServerRequest(method, params),
			onNotification: (method, params) => this.#onNotification(method, params),
			onParseError: (line) => this.#opts.log("parse-error", { line }),
			onOverflow: (detail) => {
				// The session already aborted its pending requests with the typed
				// reason; finish so later events are ignored, then take the whole
				// process GROUP down: a flooder is broken or hostile, and the
				// binary may be a wrapper script with live descendants.
				this.#opts.log("frame-overflow", { detail });
				this.#finish(`stdout frame overflow: ${detail}`);
				const child = this.#child;
				try {
					if (child?.pid && process.platform !== "win32") {
						process.kill(-child.pid, "SIGKILL");
					} else {
						child?.kill("SIGKILL");
					}
				} catch {
					/* already gone */
				}
			},
		});
		this.#rpc = rpc;

		child.stdout?.on("data", (chunk: string) => rpc.feed(chunk));
		child.stderr?.on("data", (chunk: string) => {
			this.#stderrTail = (this.#stderrTail + chunk).slice(-8192);
		});
		child.on("error", (err) => {
			this.#opts.log("spawn-error", { message: redactText(err.message) });
			this.#finish(redactText(err.message));
		});
		child.on("exit", (code, signal) => {
			this.#opts.log("exit", { code: code ?? signal ?? "?" });
			// The reason rides into pending-request rejections, so it must be
			// redacted here (server stderr can carry auth material). When the
			// server dies with no output the exit code/signal is the only clue,
			// so it goes into the reason ahead of the stderr tail.
			const where = signal ? `signal ${signal}` : code !== null ? `code ${code}` : "";
			const tail = redactText(this.#stderrTail.trim());
			const detail = [where, tail || "process gone"].filter(Boolean).join(": ");
			this.#finish(detail, code, signal);
		});

		const result = (await this.request(
			"initialize",
			{
				protocolVersion: 1,
				clientCapabilities: { fs: { readTextFile: false, writeTextFile: false }, terminal: false },
			},
			INIT_TIMEOUT_MS,
		)) as Record<string, unknown> | undefined;
		const info = result?.agentInfo;
		if (typeof info === "object" && info !== null) this.agentInfo = info as Record<string, unknown>;
		this.#opts.log("initialized", { version: this.serverVersion() });
	}

	serverVersion(): string | undefined {
		const v = this.agentInfo?.version;
		return typeof v === "string" ? v : undefined;
	}

	async newSession(cwd: string): Promise<AcpSessionInfo> {
		const result = (await this.guarded(
			"session/new",
			{ cwd, mcpServers: this.#mcpServers() },
			SESSION_OP_TIMEOUT_MS,
		)) as Record<string, unknown>;
		const sessionId = result.sessionId;
		if (typeof sessionId !== "string" || sessionId.length === 0) {
			throw new Error("ACP session/new returned no sessionId");
		}
		this.#updateSessionId = sessionId;
		this.lastConfigOptions = result.configOptions;
		return { sessionId };
	}

	async loadSession(sessionId: string, cwd: string): Promise<void> {
		this.#updateSessionId = sessionId;
		this.updateSuppression = true;
		try {
			// History replay arrives as notifications BEFORE this resolves; the
			// suppression flag drops it (never live text).
			const result = (await this.request(
				"session/load",
				{ sessionId, cwd, mcpServers: this.#mcpServers() },
				SESSION_OP_TIMEOUT_MS,
			)) as Record<string, unknown> | undefined;
			this.lastConfigOptions = result?.configOptions;
		} finally {
			this.updateSuppression = false;
		}
	}

	async setConfigOption(sessionId: string, configId: string, value: string): Promise<void> {
		const result = (await this.guarded(
			"session/set_config_option",
			{ sessionId, configId, value },
			SESSION_OP_TIMEOUT_MS,
		)) as Record<string, unknown> | undefined;
		this.lastConfigOptions = result?.configOptions;
	}

	/** No request timeout on purpose: the driver's overall/idle timers govern
	 *  the turn and fire abortAll on breach. */
	async prompt(
		sessionId: string,
		text: string,
		images: Array<{ data: string; mimeType: string }> = [],
		contextBlock?: { uri: string; text: string },
	): Promise<{ stopReason: string; usage?: AgyUsage }> {
		// Block order: images, then the embedded-context resource (pi-side
		// digest), then the text question last (it refers to everything before
		// it). Shapes per the ACP v1 content-block schema; embeddedContext is
		// advertised in promptCapabilities (verified run 5).
		const blocks: Array<Record<string, unknown>> = [
			...images.map((i) => ({ type: "image", data: i.data, mimeType: i.mimeType })),
		];
		if (contextBlock) {
			blocks.push({
				type: "resource",
				resource: {
					uri: contextBlock.uri,
					mimeType: "text/markdown",
					text: contextBlock.text,
				},
			});
		}
		blocks.push({ type: "text", text });
		const result = (await this.request("session/prompt", {
			sessionId,
			prompt: blocks,
		})) as Record<string, unknown> | undefined;
		const stopReason = result?.stopReason;
		if (typeof stopReason !== "string") {
			throw new Error("ACP session/prompt returned no stopReason");
		}
		// Exact PromptResponse.usage is distinct from context-window occupancy
		// updates; never infer token counts from {used,size}.
		const usage = parseAcpTurnUsage(result?.usage);
		if (usage) {
			this.#usageSeen = true;
			this.#exactUsageSeen = true;
		}
		return { stopReason, ...(usage ? { usage } : {}) };
	}

	cancel(sessionId: string): void {
		if (!this.#rpc || !this.alive) throw new Error("ACP connection is not running");
		this.#rpc.notify("session/cancel", { sessionId });
		for (const cancel of [...this.#permissionPending]) cancel();
	}

	async closeSession(sessionId: string): Promise<void> {
		await this.guarded("session/close", { sessionId }, SESSION_OP_TIMEOUT_MS);
	}

	/** Protocol-level permission answering: policy "auto" selects the first
	 *  allow option synchronously; "deny" consults the parked human handler
	 *  (#answerPermission) or fail-closes. See there for the full matrix. */
	#onServerRequest(method: string, params: unknown): Promise<unknown> {
		if (method === "session/request_permission") {
			return this.#answerPermission(params as AcpPermissionRequest);
		}
		// fs/* and terminal/* are declined: our client capabilities are off and
		// agy keeps executing its own tools (plan §8 capability posture).
		this.#opts.log("unsupported-server-request", { method });
		return Promise.reject(new Error(`client capability not enabled: ${method}`));
	}

	/** Answer session/request_permission. "auto" (skipPermissions turns)
	 *  selects the first allow option synchronously. Otherwise a wired handler
	 *  parks the request — the reply waits for the human — while every other
	 *  path fail-closes synchronously: no handler, esc, throw, timeout,
	 *  connection death. A chosen *_always option is remembered per connection
	 *  for identical later requests (same toolCall kind+title). */
	#answerPermission(params: AcpPermissionRequest): Promise<unknown> {
		const options = Array.isArray(params?.options) ? params.options : [];
		const allow = options.find((o) => typeof o.kind === "string" && o.kind.startsWith("allow"));
	const denyId = options.find((o) => typeof o.kind === "string" && o.kind.startsWith("reject"))?.optionId;
		const policy = this.#opts.permissions?.() ?? "deny";
		if (policy === "auto") {
			const chosen = (allow ?? options[0])?.optionId;
			this.#opts.log("permission", { optionId: chosen, policy });
			return Promise.resolve({ outcome: { outcome: "selected", optionId: chosen } });
		}
		const handler = this.#opts.onPermissionRequest;
		if (!handler) {
			this.#opts.log("permission", { optionId: denyId, policy });
			return Promise.resolve(
				denyId !== undefined
					? { outcome: { outcome: "selected", optionId: denyId } }
					: { outcome: { outcome: "cancelled" } },
			);
		}
		// Always-memory needs a stable identity: the title. Without one, every
		// untitled call would collapse onto one key and inherit its answer.
		const memKey = params?.toolCall?.title ? `${params.toolCall.kind ?? ""}|${params.toolCall.title}` : undefined;
		const remembered = memKey !== undefined ? this.#permissionMemory.get(memKey) : undefined;
		if (remembered !== undefined && options.some((o) => o.optionId === remembered)) {
			this.#opts.log("permission", { optionId: remembered, policy: "memory" });
			return Promise.resolve({ outcome: { outcome: "selected", optionId: remembered } });
		}
		const parkMs = this.#opts.permissionParkMs ?? PERMISSION_PARK_MS;
		return new Promise((resolve) => {
			let timer: NodeJS.Timeout | undefined;
			// First settle wins: a late dialog answer after a timeout/deny must
			// not re-log or record an always-memory from a dead request.
			let settled = false;
			const settle = (optionId: string | undefined, why: string): void => {
				if (settled) return;
				settled = true;
				if (timer) clearTimeout(timer);
				this.#permissionPending.delete(settleCancel);
				this.#opts.log("permission", { optionId, policy: why });
				// undefined optionId (no reject option on the table) cancels
				// instead of selecting nothing.
				resolve(
					optionId !== undefined
						? { outcome: { outcome: "selected", optionId } }
						: { outcome: { outcome: "cancelled" } },
				);
			};
			const settleDeny = (): void => settle(denyId, "dialog-deny");
			const settleCancel = (): void => settle(undefined, "cancel");
			timer = setTimeout(() => {
				this.#opts.log("permission-timeout", { parkMs });
				settleDeny();
			}, parkMs);
			this.#permissionPending.add(settleCancel);
			Promise.resolve()
				.then(() => handler(params))
				.then((picked) => {
					if (settled) return;
					const chosen = picked != null ? options.find((o) => o.optionId === picked) : undefined;
					if (!chosen?.optionId) {
						settle(denyId, "dialog-deny");
						return;
					}
					if (chosen.kind === "allow_always" || chosen.kind === "reject_always") {
						if (memKey !== undefined) this.#permissionMemory.set(memKey, chosen.optionId);
					}
					settle(chosen.optionId, "dialog");
				})
				.catch((err: unknown) => {
					this.#opts.log("permission-error", { message: err instanceof Error ? err.message : String(err) });
					settle(denyId, "dialog-error");
				});
		});
	}

	#onNotification(method: string, params: unknown): void {
		if (method === "session/update") {
			// Latched before the suppression gate: history-replay frames are the
			// server's payloads too, and they are the cheapest signal source.
			if (!this.#usageSeen && frameCarriesUsage(params)) this.#usageSeen = true;
			if (this.#suppressUpdates) return; // load replay: history, not live text
			const p = typeof params === "object" && params !== null ? (params as Record<string, unknown>) : {};
			const sessionId = typeof p.sessionId === "string" ? p.sessionId : this.#updateSessionId;
			this.#opts.onUpdate(sessionId, p.update);
			return;
		}
		if (method === "auth_required") {
			this.#opts.log("auth-required", params);
			return;
		}
		this.#opts.log("notification", { method });
	}

	/** Wrap a request: -32000 family becomes AcpAuthError with the remediation
	 *  the server provided. */
	private async guarded(method: string, params: unknown, timeoutMs: number): Promise<unknown> {
		try {
			return await this.request(method, params, timeoutMs);
		} catch (err) {
			throw translateError(method, err);
		}
	}

	async request(method: string, params?: unknown, timeoutMs?: number): Promise<unknown> {
		if (!this.#rpc || !this.alive) throw new Error("ACP connection is not running");
		try {
			return await this.#rpc.request(method, params, timeoutMs);
		} catch (err) {
			throw translateError(method, err);
		}
	}

	#mcpServers(): AcpMcpServer[] {
		try {
			return this.#opts.mcpServers?.() ?? [];
		} catch {
			return [];
		}
	}

	#write(frame: string): void {
		const stdin = this.#child?.stdin;
		if (!stdin || !stdin.writable || this.#exited) {
			this.abortAll("connection closed");
			return;
		}
		try {
			stdin.write(frame + "\n");
		} catch (err) {
			this.#opts.log("write-failed", { message: err instanceof Error ? err.message : String(err) });
			this.abortAll("connection closed");
		}
	}

	/** Gate D teardown: reject every pending request, then kill the process.
	 *  Nothing is ever written to the dying transport; no promise survives. */
	abortAll(reason: string): void {
		this.#rpc?.abortAll(reason);
	}
	kill(): void {
		if (this.#killed) return;
		this.#killed = true;
		this.abortAll("connection killed");
		const child = this.#child;
		if (!child || this.#exited) return;
		this.#opts.log("kill", { pid: child.pid ?? "?" });
		try {
			if (child.pid && process.platform !== "win32") {
				process.kill(-child.pid, "SIGTERM");
				setTimeout(() => {
					try {
						if (!this.#exited && child.pid) process.kill(-child.pid, "SIGKILL");
					} catch {
						/* already gone */
					}
				}, 750);
			} else {
				child.kill("SIGTERM");
			}
		} catch {
			/* already gone */
		}
	}

	#finish(reason: string, code: number | null = null, signal: NodeJS.Signals | null = null): void {
		if (this.#exited) return;
		this.#exited = true;
		// Pending permission dialogs must not outlive the connection: cancel them
		// so their replies race the teardown instead of hanging the server.
		const pendings = [...this.#permissionPending];
		this.#permissionPending.clear();
		for (const deny of pendings) deny();
		this.abortAll(`connection exited: ${reason || "process gone"}`);
		this.#releaseHome();
		this.#opts.onExit({ code, signal, stderrTail: redactText(this.#stderrTail) });
	}

	#releaseHome(): void {
		if (this.#stagedHome) removeStagedAgyHome(this.#stagedHome);
		this.#stagedHome = undefined;
	}
}

/** ACP's optional (unstable) per-turn PromptResponse.usage, not the
 *  session/usage_update context-window occupancy notification. */
export function parseAcpTurnUsage(value: unknown): AgyUsage | undefined {
	if (typeof value !== "object" || value === null || Array.isArray(value)) return undefined;
	const u = value as Record<string, unknown>;
	const count = (v: unknown): number | undefined =>
		typeof v === "number" && Number.isSafeInteger(v) && v >= 0 ? v : undefined;
	const input = count(u.inputTokens);
	const output = count(u.outputTokens);
	const total = count(u.totalTokens);
	const thought = count(u.thoughtTokens);
	const cacheRead = count(u.cachedReadTokens);
	if (input === undefined || output === undefined || total === undefined) return undefined;
	return {
		input_tokens: input,
		output_tokens: output,
		total_tokens: total,
		...(thought === undefined ? {} : { thinking_tokens: thought }),
		...(cacheRead === undefined ? {} : { cache_read_tokens: cacheRead }),
	};
}

export function translateError(method: string, err: unknown): Error {
	if (err instanceof AcpAuthError) return err;
	if (err instanceof JsonRpcResponseError) {
		if (err.code === -32000) {
			const detail = typeof err.data === "object" && err.data !== null ? (err.data as { message?: unknown }).message : undefined;
			const detailText = typeof detail === "string" ? `: ${detail}` : `: ${err.message}`;
			return new AcpAuthError(`ACP authentication required for ${method}${detailText}. Run agy in your terminal and complete Google sign-in, then restart pi.`);
		}
		// Typed protocol errors survive: callers inspect .code for parameter
		// and capability failures. The method prefix is lost — describe()
		// callers that need it log the method at the call site.
		return err;
	}
	if (err instanceof Error) return err;
	return new Error(`ACP ${method} failed: ${String(err)}`);
}
