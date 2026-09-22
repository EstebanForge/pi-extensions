// Shared test helpers. Import this from any *.test.ts that needs to invoke a
// ToolDefinition's execute function.
//
// ToolDefinition.execute has a 5-arg signature (toolCallId, params, signal,
// onUpdate, ctx) per @earendil-works/pi-coding-agent. Our read tools only
// consume the first two; write tools also read ctx (for the confirm gate).
// This helper lets tests pass 2 or 3 args while satisfying the 5-arg type.
// Equivalent to a per-call cast, extracted so the test bodies stay readable.

import type { AgentToolResult } from "@earendil-works/pi-coding-agent";

// Cast through `unknown` twice on purpose: the ToolDefinition's execute is a
// 5-arg function whose first arg is `string`; declaring a compatible inline
// signature is brittle and forces every test to thread it. `any` here matches
// what pi's runtime does (calls execute with all 5 args and the tool body
// destructures or ignores them).
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type AnyExecute = (...args: any[]) => Promise<AgentToolResult<unknown>>;

// Default ctx used when a test passes none. A no-UI context makes confirmWrite
// short-circuit to "proceed" (headless rule), so read tools are unaffected and
// write tools exercise their POST/PUT path without needing a UI mock. Tests
// that want to assert on the gate itself pass an explicit ctx.
const NO_UI_CTX = { hasUI: false };

export function invoke<P>(
  tool: { execute: AnyExecute },
  params: P,
  ctx?: unknown,
): Promise<AgentToolResult<unknown>> {
  // Pass all 5 positional args execute expects: toolCallId, params, signal,
  // onUpdate, ctx. Read tools ignore 3-5; write tools read ctx.
  const fn = tool.execute as unknown as (
    a: string,
    b: unknown,
    c: unknown,
    d: unknown,
    e: unknown,
  ) => Promise<AgentToolResult<unknown>>;
  return fn("call-id", params, undefined, undefined, ctx ?? NO_UI_CTX);
}

// Pull the rendered text out of an AgentToolResult. Empty string when the
// result has no text part (shouldn't happen for our tools).
export function firstText(result: AgentToolResult<unknown>): string {
  const part = result.content[0];
  if (!part || part.type !== "text") return "";
  return part.text;
}
