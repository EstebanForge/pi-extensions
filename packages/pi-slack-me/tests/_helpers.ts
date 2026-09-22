// Shared test helpers. Import this from any *.test.ts that needs to invoke a
// ToolDefinition's execute function.
//
// ToolDefinition.execute has a 5-arg signature (toolCallId, params, signal,
// onUpdate, ctx) per @earendil-works/pi-coding-agent. Our tools only consume
// the first two; the other three are required by the type but ignored at
// runtime. This helper lets tests pass 2 args while satisfying the 5-arg
// type. Equivalent to a `(tool.execute as any)("c", params)` cast per call,
// extracted so the test bodies stay readable.

import type { AgentToolResult } from "@earendil-works/pi-coding-agent";

// Cast through `unknown` twice on purpose: the ToolDefinition's execute is a
// 5-arg function whose first arg is `string`; declaring a compatible 2-arg
// helper inline is brittle and forces every test to thread that signature.
// `any` here matches what pi's runtime does (calls execute with all 5 args
// and the tool body destructures or ignores them).
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type AnyExecute = (...args: any[]) => Promise<AgentToolResult<unknown>>;

export function invoke<P>(
  tool: { execute: AnyExecute },
  params: P,
): Promise<AgentToolResult<unknown>> {
  // Cast to a 2-arg shape that's compatible with the rest-arg source.
  const fn = tool.execute as unknown as (
    a: string,
    b: unknown,
  ) => Promise<AgentToolResult<unknown>>;
  return fn("call-id", params);
}

// Like invoke(), but also passes a tool-execution context (the 5th execute
// arg). Write tools read ctx.hasUI / ctx.ui.editor / ctx.ui.confirm to run
// the review gate; read tools ignore ctx. Pass a stub ctx from the test.
export function invokeWithCtx<P, C>(
  tool: { execute: AnyExecute },
  params: P,
  ctx: C,
): Promise<AgentToolResult<unknown>> {
  const fn = tool.execute as unknown as (
    a: string,
    b: unknown,
    c: unknown,
    d: unknown,
    e: C,
  ) => Promise<AgentToolResult<unknown>>;
  return fn("call-id", params, undefined, undefined, ctx);
}

// Pull the rendered text out of an AgentToolResult. Empty string when the
// result has no text part (shouldn't happen for our tools).
export function firstText(result: AgentToolResult<unknown>): string {
  const part = result.content[0];
  if (!part || part.type !== "text") return "";
  return part.text;
}
