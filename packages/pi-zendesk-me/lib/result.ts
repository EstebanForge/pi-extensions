import type { AgentToolResult } from "@earendil-works/pi-coding-agent";

// Read tools attach no details today; the union stays open so future tools
// can add shapes without touching every caller. Mirrors pi-slack-me.
export type ZendeskDetails = undefined;

export function toToolResult(
  text: string,
  details?: ZendeskDetails,
): AgentToolResult<ZendeskDetails> {
  return {
    content: [{ type: "text", text }],
    details,
  };
}

// Single error formatter shared across every tool. All Zendesk errors (auth,
// network, HTTP, scope) are caught at the tool boundary and converted to
// readable text rather than thrown - the agent sees one actionable message
// instead of a stack trace.
export function errorText(err: unknown): string {
  if (err instanceof Error) {
    return `Zendesk error: ${err.message}`;
  }
  return "Zendesk error: unknown failure.";
}
