import type { AgentToolResult } from "@earendil-works/pi-coding-agent";
import { DeepWikiError } from "./api";

// DeepWiki tools return plain text; no structured details today.
export type DeepWikiDetails = undefined;

export function toToolResult(text: string): AgentToolResult<DeepWikiDetails> {
  return {
    content: [{ type: "text", text }],
    details: undefined,
  };
}

// Shared across both tools: collapse to a single Error check. DeepWikiError
// extends Error, so its message flows through the same path.
export function errorText(err: unknown): string {
  return err instanceof Error
    ? `DeepWiki error: ${err.message}`
    : "DeepWiki error: unknown failure.";
}
