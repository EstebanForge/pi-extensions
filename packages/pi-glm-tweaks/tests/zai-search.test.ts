import { describe, expect, it } from "vitest";
import {
	extractSearchResults,
	findRpcMessage,
	parseMcpBody,
	ZaiMcpSearchClient,
	ZaiSearchError,
	type ZaiWebSearchArgs,
} from "../lib/zai-search.js";

/** Frame one JSON-RPC message the way the Z.AI server does (SSE, no space after `data:`). */
function sse(message: unknown): string {
	return `event:message\ndata:${JSON.stringify(message)}\n\n`;
}

interface RecordedRequest {
	url: string;
	headers: Record<string, string>;
	body: Record<string, any>;
}

interface FakeFetch {
	impl: typeof fetch;
	requests: RecordedRequest[];
}

/**
 * Fetch double that records every request and routes on the JSON-RPC method.
 * Handlers receive the parsed request; return a Response.
 */
function fakeFetch(handler: (req: RecordedRequest) => Response): FakeFetch {
	const requests: RecordedRequest[] = [];
	const impl = (async (url: string | URL | Request, init?: RequestInit) => {
		// Spread the plain-object headers as-is: new Headers() would lowercase
		// every name, and the assertions check the original casing the client sent.
		const headers = { ...(init?.headers as Record<string, string>) };
		const body = JSON.parse(String(init?.body));
		const req = { url: String(url), headers, body };
		requests.push(req);
		return handler(req);
	}) as unknown as typeof fetch;
	return { impl, requests };
}

const RESULT_ITEM = { title: "Pi agent", link: "https://github.com/earendil-works/pi", content: "A coding agent.", refer: "ref_1" };
// The server double-encodes: text is a JSON string wrapping the JSON array.
const DOUBLE_ENCODED = JSON.stringify(JSON.stringify([RESULT_ITEM]));

function jsonResponse(status: number, bodyText: string, extraHeaders: Record<string, string> = {}): Response {
	return new Response(bodyText, {
		status,
		headers: { "content-type": "text/event-stream", ...extraHeaders },
	});
}

describe("parseMcpBody", () => {
	it("parses SSE events and picks the message by id (wrong SSE id line tolerated)", () => {
		// Observed shape: SSE framing says id:1 while the JSON-RPC body says id:2.
		const body = `id:1\nevent:message\ndata:${JSON.stringify({ jsonrpc: "2.0", id: 2, result: { ok: true } })}\n\n`;
		const messages = parseMcpBody(body);
		expect(messages).toHaveLength(1);
		expect(findRpcMessage(messages, 2)).toEqual({ jsonrpc: "2.0", id: 2, result: { ok: true } });
	});

	it("skips non-JSON SSE noise and joins multi-line data payloads", () => {
		// Blank line separates the noise event from the real one (SSE spec).
		const body = `: keep-alive\nevent:logging\ndata:not json\n\nevent:message\ndata:{"jsonrpc":"2.0","id":1,\ndata:"result":{"ok":true}}\n\n`;
		const messages = parseMcpBody(body);
		expect(messages).toHaveLength(1);
		expect((messages[0] as any).result).toEqual({ ok: true });
	});

	it("parses plain JSON bodies (no SSE framing)", () => {
		const messages = parseMcpBody(`{"jsonrpc":"2.0","id":1,"result":{}}`);
		expect(messages).toHaveLength(1);
		expect((messages[0] as any).id).toBe(1);
	});

	it("returns [] for empty bodies (notification acknowledgements)", () => {
		expect(parseMcpBody("")).toEqual([]);
		expect(parseMcpBody("\r\n")).toEqual([]);
	});
});

describe("extractSearchResults", () => {
	it("unwraps the double-encoded result array", () => {
		expect(extractSearchResults(DOUBLE_ENCODED)).toEqual([RESULT_ITEM]);
	});

	it("accepts a single-encoded array too", () => {
		expect(extractSearchResults(JSON.stringify([RESULT_ITEM]))).toEqual([RESULT_ITEM]);
	});

	it("throws ZaiSearchError on non-JSON payloads (fail visibly, never fake an empty result)", () => {
		expect(() => extractSearchResults("No results")).toThrow(ZaiSearchError);
	});

	it("throws on a non-array payload", () => {
		expect(() => extractSearchResults(JSON.stringify({ error: "bad" }))).toThrow(ZaiSearchError);
	});

	it("drops malformed items (missing title/content) instead of crashing the formatter", () => {
		// Peer-review finding: only `link` was validated, so an item with a
		// link but no content survived the filter and crashed
		// formatSearchResults with a raw TypeError.
		const payload = JSON.stringify([
			RESULT_ITEM,
			{ title: "No content", link: "https://example.com/x" },
			{ link: "https://example.com/y", content: "No title" },
			null,
		]);
		expect(extractSearchResults(payload)).toEqual([RESULT_ITEM]);
	});
});

function makeServer(handlerOverrides: Partial<Record<"initialize" | "tools/call", (req: RecordedRequest, call: number) => Response>> = {}) {
	let session = 0;
	let initializeCalls = 0;
	const { impl, requests } = fakeFetch((req) => {
		const method = req.body.method;
		if (method === "initialize") {
			initializeCalls++;
			session++;
			return (
				handlerOverrides.initialize?.(req, initializeCalls) ??
				jsonResponse(200, sse({ jsonrpc: "2.0", id: req.body.id, result: { protocolVersion: "2024-11-05", capabilities: {}, serverInfo: { name: "test", version: "0" } } }), {
					"mcp-session-id": `sid-${session}`,
				})
			);
		}
		if (method === "notifications/initialized") return jsonResponse(200, "");
		if (method === "tools/call") {
			return handlerOverrides["tools/call"]?.(req, initializeCalls) ?? jsonResponse(200, sse({ jsonrpc: "2.0", id: req.body.id, result: { content: [{ type: "text", text: DOUBLE_ENCODED }], isError: false } }));
		}
		return jsonResponse(500, "unreachable");
	});
	return { impl, requests, get initializeCalls() { return initializeCalls; } };
}

describe("ZaiMcpSearchClient", () => {
	const ARGS: ZaiWebSearchArgs = { search_query: "pi agent", search_recency_filter: "oneWeek", location: "us" };
	const OPTIONS = { apiKey: "test-key" };

	it("handshakes once, reuses the session, and maps wire arguments", async () => {
		const server = makeServer();
		const client = new ZaiMcpSearchClient({ fetchImpl: server.impl });

		await client.search(ARGS, OPTIONS);
		await client.search({ search_query: "second" }, OPTIONS);

		// One handshake for two searches: initialize + initialized once.
		expect(server.initializeCalls).toBe(1);
		const init = server.requests.find((r) => r.body.method === "initialize")!;
		expect(init.headers["Authorization"]).toBe("Bearer test-key");
		expect(init.url).toBe("https://api.z.ai/api/mcp/web_search_prime/mcp");

		const calls = server.requests.filter((r) => r.body.method === "tools/call");
		expect(calls).toHaveLength(2);
		expect(calls[0].body.params).toEqual({ name: "web_search_prime", arguments: ARGS });
		// Session + negotiated protocol version ride on every post-init request.
		expect(calls[0].headers["mcp-session-id"]).toBe("sid-1");
		expect(calls[0].headers["MCP-Protocol-Version"]).toBe("2024-11-05");
		// Undefined optionals are dropped (server schema is additionalProperties:false).
		expect(calls[1].body.params.arguments).toEqual({ search_query: "second" });
	});

	it("re-initializes once when the cached session dies (HTTP 404)", async () => {
		let toolCalls = 0;
		const server = makeServer({
			"tools/call": (req) => {
				toolCalls++;
				// First call: session evicted. After retry: success.
				if (toolCalls === 1) return jsonResponse(404, "session not found");
				return jsonResponse(200, sse({ jsonrpc: "2.0", id: req.body.id, result: { content: [{ type: "text", text: DOUBLE_ENCODED }], isError: false } }));
			},
		});
		const client = new ZaiMcpSearchClient({ fetchImpl: server.impl });

		const results = await client.search({ search_query: "retry me" }, OPTIONS);
		expect(results).toEqual([RESULT_ITEM]);
		expect(server.initializeCalls).toBe(2);
		expect(toolCalls).toBe(2);
		// The retried call carries the NEW session id from the second handshake.
		const secondCall = server.requests.filter((r) => r.body.method === "tools/call")[1];
		expect(secondCall.headers["mcp-session-id"]).toBe("sid-2");
	});

	it("retries once on a JSON-RPC session error, then succeeds", async () => {
		let toolCalls = 0;
		const server = makeServer({
			"tools/call": (req) => {
				toolCalls++;
				if (toolCalls === 1) {
					return jsonResponse(200, sse({ jsonrpc: "2.0", id: req.body.id, error: { code: -32001, message: "Session expired" } }));
				}
				return jsonResponse(200, sse({ jsonrpc: "2.0", id: req.body.id, result: { content: [{ type: "text", text: DOUBLE_ENCODED }], isError: false } }));
			},
		});
		const client = new ZaiMcpSearchClient({ fetchImpl: server.impl });
		await expect(client.search({ search_query: "x" }, OPTIONS)).resolves.toEqual([RESULT_ITEM]);
		expect(server.initializeCalls).toBe(2);
	});

	it("propagates non-session JSON-RPC errors without a retry", async () => {
		const server = makeServer({
			"tools/call": (req) => jsonResponse(200, sse({ jsonrpc: "2.0", id: req.body.id, error: { code: -32000, message: "quota exceeded" } })),
		});
		const client = new ZaiMcpSearchClient({ fetchImpl: server.impl });
		await expect(client.search({ search_query: "x" }, OPTIONS)).rejects.toThrow(/quota exceeded/);
		expect(server.initializeCalls).toBe(1);
		expect(server.requests.filter((r) => r.body.method === "tools/call")).toHaveLength(1);
	});

	it("throws with the server text when the tool result has isError:true", async () => {
		const server = makeServer({
			"tools/call": (req) => jsonResponse(200, sse({ jsonrpc: "2.0", id: req.body.id, result: { content: [{ type: "text", text: "upstream blocked" }], isError: true } })),
		});
		const client = new ZaiMcpSearchClient({ fetchImpl: server.impl });
		await expect(client.search({ search_query: "x" }, OPTIONS)).rejects.toThrow(/upstream blocked/);
	});

	it("throws a clear error on initialize failure (bad key)", async () => {
		const server = makeServer({
			initialize: (req) => jsonResponse(200, sse({ jsonrpc: "2.0", id: req.body.id, error: { code: -32000, message: "Invalid API key" } })),
		});
		const client = new ZaiMcpSearchClient({ fetchImpl: server.impl });
		await expect(client.search({ search_query: "x" }, OPTIONS)).rejects.toThrow(/Invalid API key/);
		// Handshake failures are PERMANENT (bad key, endpoint down) and must
		// not be retried: the error messages embed the word "initialize", and
		// a naive session-error matcher keyed on it doubled the handshake
		// (peer-review finding).
		expect(server.initializeCalls).toBe(1);
		expect(server.requests.filter((r) => r.body.method === "tools/call")).toHaveLength(0);
	});

	it("concurrent searches on a dead session share ONE re-handshake (no reset race)", async () => {
		// Server whose FIRST session is dead from the start (evicted
		// server-side): tools/call 404s on sid-1, succeeds on any later one.
		let toolCalls = 0;
		const server = makeServer({
			"tools/call": (req) => {
				toolCalls++;
				if (req.headers["mcp-session-id"] === "sid-1") {
					return jsonResponse(404, "session not found");
				}
				return jsonResponse(200, sse({ jsonrpc: "2.0", id: req.body.id, result: { content: [{ type: "text", text: DOUBLE_ENCODED }], isError: false } }));
			},
		});
		const client = new ZaiMcpSearchClient({ fetchImpl: server.impl });

		// Both calls share the sid-1 session (handshake dedup), both hit the
		// dead session, both retry. Exactly ONE caller may reset + re-handshake
		// (initializeCalls: 2 total); the sibling must reuse sid-2, not tear it
		// down into a third handshake or a 404 loop.
		const [a, b] = await Promise.all([
			client.search({ search_query: "a" }, OPTIONS),
			client.search({ search_query: "b" }, OPTIONS),
		]);
		expect(a).toEqual([RESULT_ITEM]);
		expect(b).toEqual([RESULT_ITEM]);
		expect(server.initializeCalls).toBe(2);
		expect(toolCalls).toBe(4); // 2 failed on sid-1 + 2 succeeded on sid-2
	});
});
