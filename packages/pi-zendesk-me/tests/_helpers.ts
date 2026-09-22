import { vi } from "vitest";
import type { AgentToolResult } from "@earendil-works/pi-coding-agent";

// ToolDefinition.execute has a 5-arg signature (toolCallId, params, signal,
// onUpdate, ctx) per @earendil-works/pi-coding-agent. Our tools only consume
// the first two; the other three are required by the type but ignored at
// runtime. This helper lets tests pass 2 args while satisfying the 5-arg
// contract, same as pi-slack-me's tests/_helpers.ts. `any` matches what pi's
// runtime does.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type AnyExecute = (...args: any[]) => Promise<AgentToolResult<unknown>>;

export function invoke<P>(
  tool: { execute: AnyExecute },
  params: P,
): Promise<AgentToolResult<unknown>> {
  const fn = tool.execute as unknown as (
    a: string,
    b: P,
  ) => Promise<AgentToolResult<unknown>>;
  return fn("call-id", params);
}

// First text block of a tool result, typed for assertions.
export function firstText(result: AgentToolResult<unknown>): string {
  const block = result.content[0] as { type: string; text: string };
  return block.text;
}

// Set the three required env vars. Auth reads env at call time, so stubEnv is
// enough; tests that need missing vars override with empty strings.
export function stubZendeskEnv(): void {
  vi.stubEnv("ZENDESK_SUBDOMAIN", "{subdomain}");
  vi.stubEnv("ZENDESK_CLIENT_ID", "test-client-id");
  vi.stubEnv("ZENDESK_CLIENT_SECRET", "test-client-secret");
}

export function jsonResponse(
  body: unknown,
  status = 200,
  headers?: Record<string, string>,
): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json", ...headers },
  });
}

// Replace global fetch with a vi.fn dispatching through `handler`. The mock
// receives (url: string, init?: RequestInit) and may be async.
export function fetchMock(
  handler: (url: string, init?: RequestInit) => Response | Promise<Response>,
): ReturnType<typeof vi.fn> {
  const mock = vi.fn(async (url: unknown, init?: unknown) =>
    handler(String(url), init as RequestInit | undefined),
  );
  vi.stubGlobal("fetch", mock as unknown as typeof fetch);
  return mock;
}

// Standard OAuth token endpoint success response. Most api/tool tests need a
// token before the request under test fires.
export const TOKEN_OK = {
  access_token: "test-access-token",
  token_type: "bearer",
  scope: "tickets:read users:read organizations:read",
  expires_in: 1800,
};

export function isTokenRequest(url: string): boolean {
  return url === "https://{subdomain}.zendesk.com/oauth/tokens";
}
