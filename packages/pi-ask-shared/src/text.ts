/** One-line summary for run registries and /stop listings. */
export function summarizePrompt(prompt: string, max = 80): string {
	const flat = prompt.replace(/\s+/g, " ").trim();
	return flat.length > max ? `${flat.slice(0, max - 3)}...` : flat;
}

/**
 * The model-facing description for the `background` flag. One text, byte-identical
 * across all ask tools except the resume-handle name, so model behavior stays
 * consistent package to package.
 *
 * The load-bearing parts, do not trim them:
 * - "ALL": models overuse background when the gate is soft prose.
 * - "Blocking is strictly better": kills the poll-wait anti-pattern (background
 *   with nothing else to do costs extra turns for the same answer).
 * - The write-access line: a background peer editing the same files as the
 *   main agent is a data race.
 */
export function backgroundFlagText(handleName: string): string {
	return [
		`background (optional, default false). Default is blocking: you wait and get the answer in this call.`,
		`If true: the run starts now, the call returns a runId at once, no answer yet. When the run ends, a message arrives with the full answer and the resume handle (${handleName}). Do not poll. Do not wait.`,
		`Use background only if ALL are true:`,
		`1. You have real independent work to do now.`,
		`2. A late answer is acceptable.`,
		`3. You need no follow-up before the message arrives.`,
		`No other work? Blocking is strictly better: no extra turn.`,
		`A fresh run has no resume handle until the message arrives. Never use background with write access to files you are editing.`,
	].join(" ");
}
