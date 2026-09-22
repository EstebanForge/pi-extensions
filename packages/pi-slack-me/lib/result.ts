import type { AgentToolResult } from "@earendil-works/pi-coding-agent";

// Structured metadata a write tool attaches ONLY when the human edited the
// draft in the review dialog. postedContentExtras() emits this object plus a
// matching text block; when the draft shipped verbatim it emits neither,
// because the agent already holds its own draft in context. The model only
// sees a tool result's `content` text, so the same ground truth is also
// appended to the success line as prose.
export interface WriteDetails {
  /** Exact text transmitted to Slack after the user reviewed/edited. */
  postedContent?: string;
  /** True when the human changed the agent's draft in the review dialog. */
  edited?: boolean;
}

// Write tools attach WriteDetails; read tools attach nothing. The union stays
// open so future tools can add more shapes without touching every caller.
export type SlackDetails = WriteDetails | undefined;

export function toToolResult(
  text: string,
  details?: SlackDetails,
): AgentToolResult<SlackDetails> {
  return {
    content: [{ type: "text", text }],
    details,
  };
}

/**
 * Success-result extras for a write tool: a model-visible content block plus
 * structured details, returned ONLY when the human actually edited the draft.
 * When the draft shipped verbatim the agent already holds that text in its own
 * context, so echoing it back would duplicate tokens for no information gain.
 *
 * `extraText` is appended to the success line; `details` is attached to the
 * result. Both are empty/undefined in the not-edited case.
 */
export function postedContentExtras(text: string, edited: boolean): {
  extraText: string;
  details: WriteDetails | undefined;
} {
  if (!edited) return { extraText: "", details: undefined };
  return {
    extraText: `\nEdited by user: yes\nFinal content sent:\n-----\n${text}\n-----`,
    details: { postedContent: text, edited: true },
  };
}

// Single error formatter shared across every tool. All Slack errors (auth,
// network, HTTP, logical {ok:false}) are caught at the tool boundary and
// converted to readable text rather than thrown - the agent sees a single,
// actionable message instead of a stack trace.
export function errorText(err: unknown): string {
  if (err instanceof Error) {
    return `Slack error: ${err.message}`;
  }
  return "Slack error: unknown failure.";
}
