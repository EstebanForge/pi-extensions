// Z.AI Web Search — direct MCP client, no MCP server required.
//
// Z.AI ships its Coding Plan web search as a REMOTE streamable-HTTP MCP
// server (docs.z.ai/devpack/mcp/search-mcp-server):
//
//   POST https://api.z.ai/api/mcp/web_search_prime/mcp
//   Authorization: Bearer <ZAI_API_KEY>
//   tool: web_search_prime (inputSchema additionalProperties: false)
//
// Users normally wire it through an MCP client (Claude Code, Cline,
// mcp-cli-ent). Pi already loads this extension, so instead we speak the
// MCP JSON-RPC protocol directly over fetch from the zai_web_search tool:
// initialize -> notifications/initialized -> tools/call. Three POSTs per
// process (the session is cached), zero MCP infrastructure on the user's
// machine, and the searches bill against the GLM Coding Plan search quota
// exactly like the official MCP path.
//
// Probed live 2026-08-21 (see CHANGELOG 1.6.0):
//   - Responses are SSE-framed (content-type text/event-stream) with one
//     `data:` line carrying the JSON-RPC message; some deployments answer
//     plain JSON instead, so both shapes are parsed.
//   - initialize returns the session id in the `mcp-session-id` response
//     header (not the body) and negotiates protocolVersion 2024-11-05.
//   - tools/call result content[0].text is DOUBLE-encoded JSON: a JSON
//     string whose payload is the JSON array of results. Both layers are
//     unwrapped in extractSearchResults.
//   - Result item shape: { title, link, content, refer }. `refer` is
//     Z.AI's internal citation id (ref_N) — kept here for completeness,
//     not surfaced to the LLM by the tool.
//
// Session lifecycle: the MCP session id is cached for the process
// lifetime. Server-side sessions can expire or be evicted; on a
// session-loss signal (HTTP 404/410, or 400/JSON-RPC error mentioning the
// session) the client drops the cached id, re-initializes once, and
// retries the call. Concurrent first calls dedupe through sessionPromise
// so two parallel zai_web_search calls open at most one session.

/** Wire arguments for the web_search_prime MCP tool (server schema is additionalProperties: false). */
export interface ZaiWebSearchArgs {
	search_query: string;
	/** Restrict results to a whitelist domain, e.g. "www.example.com". */
	search_domain_filter?: string;
	search_recency_filter?: "oneDay" | "oneWeek" | "oneMonth" | "oneYear" | "noLimit";
	content_size?: "medium" | "high";
	location?: "cn" | "us";
}

/** One search result as returned by web_search_prime. */
export interface ZaiSearchResult {
	title: string;
	link: string;
	content: string;
	refer?: string;
}

export interface ZaiSearchCallOptions {
	apiKey: string;
	signal?: AbortSignal;
}

/** Error class carrying the HTTP status when one was received. */
export class ZaiSearchError extends Error {
	readonly status?: number;

	constructor(message: string, options?: { status?: number; cause?: unknown }) {
		super(message, options?.cause !== undefined ? { cause: options.cause } : undefined);
		this.name = "ZaiSearchError";
		this.status = options?.status;
	}
}

export const ZAI_SEARCH_ENDPOINT = "https://api.z.ai/api/mcp/web_search_prime/mcp";
// Keep in sync with package.json version (sent as MCP clientInfo).
const CLIENT_INFO = { name: "pi-glm-tweaks", version: "1.6.0" };
// The version we REQUEST at initialize. The server negotiates DOWN to
// "2024-11-05" regardless; the negotiated value is what gets sent on every
// subsequent request (MCP-Protocol-Version), so this constant only shapes
// the handshake itself.
const REQUESTED_PROTOCOL_VERSION = "2025-03-26";

type FetchLike = typeof fetch;

export interface ZaiMcpSearchClientOptions {
	/** Override the MCP endpoint (tests). Defaults to ZAI_SEARCH_ENDPOINT. */
	endpoint?: string;
	/** Inject fetch (tests). Defaults to global fetch. */
	fetchImpl?: FetchLike;
}

/** A parsed SSE event's concatenated data payload. */
interface SseEvent {
	data: string;
}

/**
 * Parse one MCP HTTP response body into its JSON-RPC messages. Handles both
 * framed shapes observed in the wild:
 *   - text/event-stream: `event:`/`data:` lines, events separated by blank
 *     lines. Per the SSE spec, multiple `data:` lines inside one event join
 *     with "\n"; per the MCP spec, each event carries one JSON message.
 *   - application/json: the message object itself.
 * Unparseable payloads are skipped (SSE streams may also carry comments and
 * keep-alives) rather than failing the whole response.
 */
export function parseMcpBody(body: string): unknown[] {
	const text = body.trim();
	if (text === "") return [];
	// Plain JSON body (no SSE framing): a single message object.
	if (text.startsWith("{") || text.startsWith("[")) {
		try {
			const parsed = JSON.parse(text) as unknown;
			return Array.isArray(parsed) ? parsed : [parsed];
		} catch {
			return [];
		}
	}
	const messages: unknown[] = [];
	let current: SseEvent | null = null;
	const flush = () => {
		if (current && current.data !== "") {
			try {
				messages.push(JSON.parse(current.data));
			} catch {
				// Not JSON (comment/notification noise) — skip.
			}
		}
		current = null;
	};
	for (const line of body.split(/\r?\n/)) {
		if (line === "") {
			flush();
			continue;
		}
		if (line.startsWith("data:")) {
			const payload = line.slice(5).replace(/^ /, "");
			current ??= { data: "" };
			current.data = current.data === "" ? payload : `${current.data}\n${payload}`;
		}
		// `event:`/`id:` lines carry no payload we need; `:`-prefixed lines
		// are SSE comments (keep-alives).
	}
	flush();
	return messages;
}

/**
 * Find the JSON-RPC response matching a request id. Falls back to the only
 * message that looks like a response (result/error without id) — some
 * servers echo the wrong SSE `id:` line while the JSON-RPC body stays
 * correct (observed: `id:1` framing around an `"id":2` body).
 */
export function findRpcMessage(messages: unknown[], id: number | string): unknown | undefined {
	const byId = messages.find(
		(m): m is Record<string, unknown> =>
			typeof m === "object" && m !== null && "id" in m && (m as Record<string, unknown>).id === id,
	);
	if (byId) return byId;
	return messages.find(
		(m): m is Record<string, unknown> =>
			typeof m === "object" && m !== null && !("id" in m) && ("result" in m || "error" in m),
	);
}

/**
 * Unwrap the web_search_prime result text into result items. The observed
 * payload is double-encoded (text -> JSON string -> JSON array); both a
 * single-encoded array and a double-encoded one are accepted so a server
 * fix in either direction keeps working.
 */
export function extractSearchResults(text: string): ZaiSearchResult[] {
	let parsed: unknown;
	try {
		parsed = JSON.parse(text);
	} catch {
		throw new ZaiSearchError(`Z.AI search returned a non-JSON result: ${text.slice(0, 200)}`);
	}
	if (typeof parsed === "string") {
		// Keep the pre-decode string for the error message: TS resets the
		// `string` narrowing inside catch, and JSON.parse threw before any
		// reassignment, so `parsed` is still the raw text.
		const encoded = parsed;
		try {
			parsed = JSON.parse(encoded);
		} catch {
			throw new ZaiSearchError(`Z.AI search returned an unparseable result: ${encoded.slice(0, 200)}`);
		}
	}
	if (!Array.isArray(parsed)) {
		throw new ZaiSearchError(`Z.AI search returned an unexpected result shape: ${text.slice(0, 200)}`);
	}
	return parsed.filter(
		(item): item is ZaiSearchResult =>
			typeof item === "object" &&
			item !== null &&
			typeof (item as ZaiSearchResult).link === "string" &&
			typeof (item as ZaiSearchResult).title === "string" &&
			typeof (item as ZaiSearchResult).content === "string",
	);
}

/**
 * Does this error mean the cached MCP session died (retry once after re-init)?
 * Deliberately does NOT match "initialize": handshake failures embed that
 * word in their own messages, and a failed handshake is a permanent error
 * (bad key, endpoint down) — retrying it doubles the round-trips for
 * nothing. Only a dead ALREADY-ESTABLISHED session is retryable.
 */
function isSessionError(err: unknown): boolean {
	if (!(err instanceof ZaiSearchError)) return false;
	if (err.status === 404 || err.status === 410) return true;
	if (err.status === 400 && /\bsession\b/i.test(err.message)) return true;
	return /\bsession\b/i.test(err.message) && !/non-json|unparseable|unexpected result/i.test(err.message);
}

interface JsonRpcResponse {
	result?: {
		content?: Array<{ type?: string; text?: string }>;
		isError?: boolean;
		protocolVersion?: string;
	};
	error?: { code?: number; message?: string; data?: unknown };
}

/**
 * Minimal MCP streamable-HTTP client for the Z.AI web search tool.
 * One instance per process; the MCP session is initialized lazily and
 * reused across calls.
 */
export class ZaiMcpSearchClient {
	private readonly endpoint: string;
	private readonly fetchImpl: FetchLike;
	private sessionId: string | undefined;
	private protocolVersion: string | undefined;
	private nextId = 1;
	private sessionPromise: Promise<void> | undefined;

	constructor(options: ZaiMcpSearchClientOptions = {}) {
		this.endpoint = options.endpoint ?? ZAI_SEARCH_ENDPOINT;
		this.fetchImpl = options.fetchImpl ?? fetch;
	}

	/** Run one web search. Re-initializes once if the cached session died. */
	async search(args: ZaiWebSearchArgs, options: ZaiSearchCallOptions): Promise<ZaiSearchResult[]> {
		// Capture the handshake this call ran on. sessionPromise stays set
		// after completion (it dedupes, it is not cleared on success), so it
		// doubles as a generation marker for compare-and-clear below.
		let handshake: Promise<void> | undefined;
		try {
			await this.ensureSession(options);
			handshake = this.sessionPromise;
			return await this.callTool(args, options);
		} catch (err) {
			if (!isSessionError(err)) throw err;
			// Invalidate ONLY if no sibling already refreshed the session:
			// with N concurrent calls on a dead session, exactly one caller
			// may reset + re-handshake; the rest must reuse the fresh session
			// instead of tearing it down mid-flight (peer-review finding: the
			// naive unconditional reset raced concurrent retries into N
			// redundant handshakes and could 404 a sibling's own retry).
			if (this.sessionPromise === handshake) {
				this.sessionId = undefined;
				this.sessionPromise = undefined;
			}
			await this.ensureSession(options);
			return await this.callTool(args, options);
		}
	}

	private async ensureSession(options: ZaiSearchCallOptions): Promise<void> {
		if (this.sessionId !== undefined) return;
		// Dedupe concurrent initializers: parallel tool calls share one
		// handshake instead of racing two sessions.
		this.sessionPromise ??= this.initialize(options).then(
			() => undefined,
			(err: unknown) => {
				// Let the next caller retry the handshake fresh.
				this.sessionPromise = undefined;
				throw err;
			},
		);
		await this.sessionPromise;
	}

	/** initialize + notifications/initialized, capturing the session header. */
	private async initialize(options: ZaiSearchCallOptions): Promise<void> {
		const id = this.nextId++;
		const body: string = JSON.stringify({
			jsonrpc: "2.0",
			id,
			method: "initialize",
			params: {
				protocolVersion: REQUESTED_PROTOCOL_VERSION,
				capabilities: {},
				clientInfo: CLIENT_INFO,
			},
		});
		const response = await this.post(body, options, { expectSession: false });
		const messages = parseMcpBody(await response.bodyText);
		const message = findRpcMessage(messages, id) as JsonRpcResponse | undefined;
		if (!message) {
			throw new ZaiSearchError(`Z.AI MCP initialize returned no response: ${response.bodyText.slice(0, 200)}`, {
				status: response.status,
			});
		}
		if (message.error) {
			throw new ZaiSearchError(
				`Z.AI MCP initialize failed (${message.error.code ?? "?"}): ${message.error.message ?? "unknown error"}`,
				{ status: response.status },
			);
		}
		this.sessionId = response.sessionId;
		this.protocolVersion = message.result?.protocolVersion ?? REQUESTED_PROTOCOL_VERSION;

		// notifications/initialized — a notification: no id, no response body.
		// Some servers reply 202, this one 200 with an empty body; both fine.
		await this.post(JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" }), options, {
			expectSession: false,
		});
	}

	private async callTool(args: ZaiWebSearchArgs, options: ZaiSearchCallOptions): Promise<ZaiSearchResult[]> {
		const id = this.nextId++;
		const body = JSON.stringify({
			jsonrpc: "2.0",
			id,
			method: "tools/call",
			params: { name: "web_search_prime", arguments: args },
		});
		const response = await this.post(body, options, { expectSession: true });
		const messages = parseMcpBody(await response.bodyText);
		const message = findRpcMessage(messages, id) as JsonRpcResponse | undefined;
		if (!message) {
			throw new ZaiSearchError(`Z.AI search returned no response: ${response.bodyText.slice(0, 200)}`, {
				status: response.status,
			});
		}
		if (message.error) {
			throw new ZaiSearchError(
				`Z.AI search failed (${message.error.code ?? "?"}): ${message.error.message ?? "unknown error"}`,
				{ status: response.status },
			);
		}
		if (message.result?.isError) {
			const text = message.result.content?.map((c) => c.text ?? "").join("\n") ?? "";
			throw new ZaiSearchError(`Z.AI search error: ${text.slice(0, 300)}`, { status: response.status });
		}
		const text = message.result?.content?.find((c) => typeof c.text === "string")?.text;
		if (text === undefined) {
			throw new ZaiSearchError("Z.AI search returned no text content", { status: response.status });
		}
		return extractSearchResults(text);
	}

	/** One JSON-RPC POST. Non-2xx becomes a ZaiSearchError (status kept for retry logic). */
	private async post(
		body: string,
		options: ZaiSearchCallOptions,
		{ expectSession }: { expectSession: boolean },
	): Promise<{ status: number; sessionId: string | undefined; bodyText: string }> {
		const headers: Record<string, string> = {
			"Content-Type": "application/json",
			// Streamable HTTP requires offering both content types.
			Accept: "application/json, text/event-stream",
			Authorization: `Bearer ${options.apiKey}`,
		};
		if (this.sessionId !== undefined) headers["mcp-session-id"] = this.sessionId;
		if (this.protocolVersion !== undefined) headers["MCP-Protocol-Version"] = this.protocolVersion;

		let response: Response;
		try {
			response = await this.fetchImpl(this.endpoint, {
				method: "POST",
				headers,
				body,
				signal: options.signal,
			});
		} catch (err) {
			if (err instanceof Error && err.name === "AbortError") throw err;
			throw new ZaiSearchError(`Z.AI search request failed: ${(err as Error).message}`, { cause: err });
		}

		const bodyText = await response.text();
		if (!response.ok) {
			// A 400 with a session complaint is retryable; keep status + body.
			throw new ZaiSearchError(
				`Z.AI search HTTP ${response.status}${bodyText ? `: ${bodyText.slice(0, 200)}` : ""}`,
				{ status: response.status },
			);
		}
		const sessionId = response.headers.get("mcp-session-id") ?? undefined;
		if (expectSession && this.sessionId === undefined && sessionId !== undefined) {
			this.sessionId = sessionId;
		}
		return { status: response.status, sessionId, bodyText };
	}
}
