// Minimal DeepWiki MCP-over-HTTP client.
//
// deepwiki.com exposes no REST API. Its hosted MCP server
// (https://mcp.deepwiki.com/mcp) uses the Streamable HTTP transport: each
// POST is a stateless, auth-free JSON-RPC 2.0 request answered as a single
// `text/event-stream` frame shaped `event: message\ndata: {json}`.
//
// We speak just enough of the protocol to call a tool: initialize (ignored),
// tools/call, parse the SSE frame, unwrap {result|error}.content[].text.
// No Mcp-Session-Id is required for the public tools we use, so we do not
// persist state across requests. This replaces a full MCP adapter install.

const DEFAULT_BASE_URL = "https://mcp.deepwiki.com/mcp";
const REQUEST_TIMEOUT_MS = 90_000;

export function baseUrl(): string {
  return process.env.DEEPWIKI_MCP_URL?.trim() || DEFAULT_BASE_URL;
}

interface JsonRpcResponse<T> {
  jsonrpc: "2.0";
  id: number | string;
  result?: T;
  error?: { code: number; message: string; data?: unknown };
}

interface ToolResult {
  content: Array<{ type: string; text?: string }>;
  isError?: boolean;
}

// Extract the first JSON object from an SSE stream body. DeepWiki answers a
// single `event: message\ndata: {...}` frame per request; we tolerate the
// `data: ` prefix and any leading keepalive lines without a full SSE parser.
function parseSseJson(body: string): unknown {
  for (const line of body.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed.startsWith("data:")) continue;
    const payload = trimmed.slice(5).trim();
    if (!payload) continue;
    try {
      return JSON.parse(payload);
    } catch {
      // Skip malformed frames; DeepWiki only ever sends one real frame.
    }
  }
  // Fallback: the body may be bare JSON (no SSE framing).
  try {
    return JSON.parse(body);
  } catch {
    throw new Error("DeepWiki returned an unparseable response.");
  }
}

export class DeepWikiError extends Error {
  readonly status: number;
  readonly isRateLimited: boolean;
  constructor(message: string, status = 0, isRateLimited = false) {
    super(message);
    this.name = "DeepWikiError";
    this.status = status;
    this.isRateLimited = isRateLimited;
  }
}

function friendlyStatus(status: number): string {
  if (status === 429) {
    return "DeepWiki rate limit reached. Wait a moment and retry.";
  }
  if (status === 404) {
    return "Repository not indexed by DeepWiki, or the repoName is malformed. Use owner/repo (e.g. solidjs/solid).";
  }
  if (status === 401 || status === 403) {
    return "DeepWiki denied access. Public repos need no auth; check the repoName and that the repo is public.";
  }
  if (status >= 500) {
    return `DeepWiki server error (${status}). Try again later.`;
  }
  return `DeepWiki request failed (HTTP ${status}).`;
}

// Call a DeepWiki MCP tool and return its concatenated text output.
export async function callDeepWikiTool(
  name: string,
  args: Record<string, unknown>,
): Promise<string> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);

  let response: Response;
  try {
    response = await fetch(baseUrl(), {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Accept: "application/json, text/event-stream",
      },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: 1,
        method: "tools/call",
        params: { name, arguments: args },
      }),
      signal: controller.signal,
    });
  } catch (err) {
    clearTimeout(timer);
    const msg = err instanceof Error ? err.message : String(err);
    if (msg.includes("abort")) {
      throw new DeepWikiError(
        `DeepWiki request timed out after ${REQUEST_TIMEOUT_MS / 1000}s. The service may be slow indexing this repo; retry.`,
      );
    }
    throw new DeepWikiError(`Network error reaching DeepWiki: ${msg}`);
  }

  // Keep the abort signal live through the body read so a stalled download is
  // caught by the same timeout. clearTimeout fires only once everything landed.
  try {
    if (!response.ok) {
      throw new DeepWikiError(friendlyStatus(response.status), response.status, response.status === 429);
    }

    const body = await response.text();
    const parsed = parseSseJson(body) as JsonRpcResponse<ToolResult>;

    if (parsed.error) {
      throw new DeepWikiError(parsed.error.message || "DeepWiki JSON-RPC error.");
    }

    const result = parsed.result;
    if (!result || !result.content || result.content.length === 0) {
      throw new DeepWikiError("DeepWiki returned an empty result.");
    }

    const text = result.content
      .map((part) => (part.type === "text" ? part.text ?? "" : ""))
      .join("\n")
      .trim();

    if (result.isError) {
      throw new DeepWikiError(text || "DeepWiki reported a tool error.");
    }
    return text;
  } finally {
    clearTimeout(timer);
  }
}
