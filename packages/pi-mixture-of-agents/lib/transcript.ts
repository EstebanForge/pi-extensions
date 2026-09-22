/**
 * Transcript trimming for reference calls.
 *
 * References get a cheaper, deterministic view of the conversation: only
 * user/assistant text. No system prompt, no tool schemas, no toolCall /
 * toolResult / thinking blocks. This keeps reference calls cheap, avoids
 * strict-provider rejections on tool-call transcripts, and (because the view
 * is a stable function of the stable history) makes the dedup signature
 * reliable across iterations.
 *
 * Mirrors moa_loop.py: trim non-text content, skip non-text
 * roles, hand the reference only role-labeled plain text.
 */

/** A minimal {role, content: [text]} message, the only thing refs see. */
export interface AdvisoryMessage {
	role: "user" | "assistant";
	content: Array<{ type: "text"; text: string }>;
}

type AnyMessage = {
	role?: string;
	content?: unknown;
};

function extractText(content: unknown): string {
	if (typeof content === "string") return content;
	if (!Array.isArray(content)) return "";
	return content
		.filter((c): c is { type: "text"; text: string } =>
			!!c && typeof c === "object" && (c as { type?: string }).type === "text" &&
			typeof (c as { text?: string }).text === "string",
		)
		.map((c) => c.text)
		.join("\n");
}

/**
 * Reduce a full conversation to user/assistant text only.
 * Drops system, toolResult roles and every non-text content block.
 * Preserves order. Empty messages are omitted.
 */
export function trimForReferences(messages: readonly AnyMessage[] | null | undefined): AdvisoryMessage[] {
	const out: AdvisoryMessage[] = [];
	for (const m of messages ?? []) {
		if (!m || typeof m !== "object") continue;
		if (m.role !== "user" && m.role !== "assistant") continue;
		const text = extractText(m.content).trim();
		if (!text) continue;
		out.push({ role: m.role, content: [{ type: "text", text }] });
	}
	return out;
}

/**
 * Render an advisory transcript as a single instruction string refs see:
 * role-labeled (User/Assistant), turns joined by blank lines. Deterministic
 * so the dedup signature is stable. Shared by the one-shot and session paths.
 */
export function renderAdvisoryInstruction(advisory: readonly AdvisoryMessage[]): string {
	return advisory
		.map((m) => `${m.role === "user" ? "User" : "Assistant"}: ${m.content.map((c) => c.text).join("\n")}`)
		.join("\n\n");
}
