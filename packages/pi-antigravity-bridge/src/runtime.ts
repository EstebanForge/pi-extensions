// Realm-wide bridge runtime for multi-session pi processes (e.g. subagents).
//
// When multiple sessions bind the extension factory in the same JS realm,
// module state is shared, pi-ai's provider registry is process-global (the last
// registerProvider wins), and each session fires its own session_start and
// session_shutdown. Left uncoordinated, a child session overwrites the parent's
// provider and its shutdown deletes process.pid-keyed artifacts (bridge dir,
// approval hook script, global MCP entry) while the parent still runs.
//
// One realm per JS realm (globalThis) owns the shared pieces:
//   - SessionStore (single writer per sessions.json);
//   - one stable streamSimple that routes each call by options.sessionId;
//   - one MCP listener with per-session route tokens (sessions use their own
//     token in ACP mcpServers / isolated stream-json home; shared per-realm
//     artifacts carry realmToken and resolve to the active streaming session);
//   - refcounted teardown of per-realm artifacts when the last session leaves.

import fs from "node:fs";
import path from "node:path";
import {
	createAssistantMessageEventStream,
	type Api,
	type AssistantMessage,
	type AssistantMessageEventStream,
	type Model,
	type SimpleStreamOptions,
	type TranscriptContext,
} from "@earendil-works/pi-ai";
import { logsDir } from "./config.js";
import { unregisterBridgeServer } from "./mcp-registration.js";
import { startMcpServer, type McpBridgeDeps, type McpServerHandle, type McpStartResult } from "./mcp-server.js";
import { SessionStore } from "./sessions.js";

const REALM_KEY = Symbol.for("pi-antigravity-bridge.runtime");

/** The approval hook script of this realm (one per process, realmToken embedded). */
export function approvalHookScriptPath(): string {
	return path.join(logsDir(), `approval-hook-${process.pid}.js`);
}

/** Read the session manager's current session id live (changes across /new and /resume). */
export function liveSessionId(sessionManager: unknown): string | undefined {
	if (typeof sessionManager !== "object" || sessionManager === null || !("getSessionId" in sessionManager)) {
		return undefined;
	}
	const read = (sessionManager as { getSessionId?: unknown }).getSessionId;
	if (typeof read !== "function") return undefined;
	try {
		const id: unknown = read.call(sessionManager);
		return typeof id === "string" && id.length > 0 ? id : undefined;
	} catch {
		return undefined;
	}
}

export type BridgeStreamSimple = (
	model: Model<Api>,
	context: TranscriptContext,
	options?: SimpleStreamOptions,
) => AssistantMessageEventStream;

export interface SessionPort {
	sessionId(): string | undefined;
	streamSimple: BridgeStreamSimple;
	hasActiveTurn(): boolean;
	conversationId(): string | undefined;
}

/** A session's view of the bridge listener. `token` is the session's own
 *  route; `realmToken` is the listener token carried by per-realm artifacts. */
export interface BridgeEndpoint extends McpServerHandle {
	realmToken: string;
}

export interface BridgeAttachResult {
	ok: boolean;
	reason?: string;
	handle?: BridgeEndpoint;
	first: boolean;
}

export interface RealmSession {
	attachBridge(deps: McpBridgeDeps, log: (event: string, data?: unknown) => void): Promise<BridgeAttachResult>;
	leave(): Promise<void>;
}

export interface BridgeRealm {
	readonly store: SessionStore;
	readonly streamSimple: BridgeStreamSimple;
	readonly liveSessions: number;
	join(port: SessionPort): RealmSession;
}

interface Member {
	port: SessionPort;
	bridge?: McpBridgeDeps;
	log?: (event: string, data?: unknown) => void;
	route?: { token: string; remove(): void };
}

const NO_TURN = "no active antigravity turn; the pi tool bridge only works while an antigravity model is streaming";
const SEVERAL_TURNS =
	"several antigravity sessions are streaming in this process and this request carries no session token";

class Realm implements BridgeRealm {
	#store: SessionStore | undefined;
	readonly #members = new Set<Member>();
	#starting: Promise<McpStartResult> | null = null;
	#server: McpServerHandle | null = null;
	#closing: Promise<void> = Promise.resolve();
	#lastLog: ((event: string, data?: unknown) => void) | undefined;

	get store(): SessionStore {
		this.#store ??= new SessionStore();
		return this.#store;
	}

	get liveSessions(): number {
		return this.#members.size;
	}

	readonly streamSimple: BridgeStreamSimple = (model, context, options) => {
		const member = this.#memberFor(options?.sessionId);
		if (!member) return refusedStream(model, "Antigravity bridge: no live session in this process");
		return member.port.streamSimple(model, context, options);
	};

	join(port: SessionPort): RealmSession {
		const member: Member = { port };
		this.#members.add(member);
		let left = false;
		return {
			attachBridge: (deps, log) => this.#attach(member, deps, log),
			leave: async () => {
				if (left) return;
				left = true;
				member.route?.remove();
				this.#members.delete(member);
				if (this.#members.size === 0) await this.#teardown();
			},
		};
	}

	async dispose(): Promise<void> {
		this.#members.clear();
		await this.#teardown();
	}

	#memberFor(sessionId: string | undefined): Member | undefined {
		const members = [...this.#members];
		if (sessionId) {
			const exact = members.find((m) => m.port.sessionId() === sessionId);
			if (exact) return exact;
			const owner = members.find((m) => {
				const id = m.port.sessionId();
				return id !== undefined && sessionId.startsWith(`${id}:`);
			});
			if (owner) return owner;
		}
		return members[0];
	}

	async #attach(
		member: Member,
		deps: McpBridgeDeps,
		log: (event: string, data?: unknown) => void,
	): Promise<BridgeAttachResult> {
		member.bridge = deps;
		member.log = log;
		const first = this.#starting === null;
		const starting = (this.#starting ??= this.#closing.then(() =>
			startMcpServer(this.#router, { log: (event, data) => this.#log(event, data), addDirConfig: false }),
		));
		const started = await starting;
		if (!started.ok || !started.handle) {
			if (this.#starting === starting) this.#starting = null;
			return { ok: false, reason: started.reason, first };
		}
		if (!this.#members.has(member)) {
			return { ok: false, reason: "session ended before the bridge started", first };
		}
		const server = started.handle;
		this.#server = server;
		member.route?.remove();
		const route = server.addRoute(deps);
		member.route = route;
		return {
			ok: true,
			first,
			handle: {
				port: server.port,
				token: route.token,
				realmToken: server.token,
				approvals: server.approvals,
				addRoute: server.addRoute,
				close: async () => route.remove(),
			},
		};
	}

	async #teardown(): Promise<void> {
		const starting = this.#starting;
		this.#starting = null;
		this.#server = null;
		if (!starting) return;
		this.#closing = (async () => {
			const started = await starting;
			await started.handle?.close();
			fs.rmSync(approvalHookScriptPath(), { force: true });
			unregisterBridgeServer(process.pid);
		})().catch(() => {
			/* best effort */
		});
		await this.#closing;
	}

	readonly #router: McpBridgeDeps = {
		listTools: () => {
			const attached = [...this.#members].filter((m) => m.bridge);
			const target = this.#streaming() ?? (attached.length === 1 ? attached[0] : undefined);
			if (target?.bridge) return target.bridge.listTools();
			this.#log("list-tools-refused", { reason: this.#unattributed(), sessions: attached.length });
			return [];
		},
		onToolCall: (callId, name, args, signal) => {
			const target = this.#streaming();
			if (!target?.bridge) return Promise.reject(new Error(this.#unattributed()));
			return target.bridge.onToolCall(callId, name, args, signal);
		},
		onApproval: (ticket, payload) => {
			const conversationId = typeof payload.conversationId === "string" ? payload.conversationId : undefined;
			const onApproval = this.#streaming(conversationId)?.bridge?.onApproval;
			if (onApproval) {
				onApproval(ticket, payload);
				return;
			}
			this.#server?.approvals.resolve(ticket, { allow: false, reason: `approval gate: ${this.#unattributed()}` });
		},
	};

	#streaming(conversationId?: string): Member | undefined {
		const open = [...this.#members].filter((m) => m.bridge && m.port.hasActiveTurn());
		if (open.length === 1) return open[0];
		if (conversationId === undefined) return undefined;
		const owners = open.filter((m) => m.port.conversationId() === conversationId);
		return owners.length === 1 ? owners[0] : undefined;
	}

	#unattributed(): string {
		const open = [...this.#members].filter((m) => m.bridge && m.port.hasActiveTurn());
		return open.length > 1 ? SEVERAL_TURNS : NO_TURN;
	}

	#log(event: string, data?: unknown): void {
		const members = [...this.#members];
		const sink = members.find((m) => m.log)?.log ?? this.#lastLog;
		this.#lastLog = sink;
		sink?.(event, data);
	}
}

function refusedStream(model: Model<Api>, message: string): AssistantMessageEventStream {
	const stream = createAssistantMessageEventStream();
	const error: AssistantMessage = {
		role: "assistant",
		content: [],
		api: model.api,
		provider: model.provider,
		model: model.id,
		usage: {
			input: 0,
			output: 0,
			cacheRead: 0,
			cacheWrite: 0,
			totalTokens: 0,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
		},
		stopReason: "error",
		errorMessage: message,
		timestamp: Date.now(),
	};
	stream.push({ type: "error", reason: "error", error });
	stream.end();
	return stream;
}

/** This realm's bridge runtime, created on first use. */
export function bridgeRealm(): BridgeRealm {
	const existing: unknown = Reflect.get(globalThis, REALM_KEY);
	if (existing instanceof Realm) return existing;
	const realm = new Realm();
	Reflect.set(globalThis, REALM_KEY, realm);
	return realm;
}

/** Drop the realm (closing its listener) so each test starts clean. */
export async function __resetRealmForTests(): Promise<void> {
	const existing: unknown = Reflect.get(globalThis, REALM_KEY);
	Reflect.deleteProperty(globalThis, REALM_KEY);
	if (existing instanceof Realm) await existing.dispose();
}
