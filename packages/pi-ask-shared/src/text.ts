/** One-line summary for run registries and /stop listings. */
export function summarizePrompt(prompt: string, max = 80): string {
	const flat = prompt.replace(/\s+/g, " ").trim();
	return flat.length > max ? `${flat.slice(0, max - 3)}...` : flat;
}

/**
 * Tell a spawned peer its wall-clock budget so it can pace toward a complete
 * answer instead of being killed mid-task by the runProcess watchdog. Models
 * have no clock, so this buys scope pacing, not timekeeping. Magnitude-based:
 * sub-two-minute budgets get a direct-answer framing (read-only consults),
 * longer ones get the complete-answer-or-subset framing. Empty for absent
 * caps and anything under one second, which the watchdog would turn into an
 * instant kill - callers guard those separately.
 */
export function buildTimeBudgetNotice(timeoutMs: number): string {
	if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) return "";
	if (timeoutMs < 1000) {
		// Below one second the watchdog fires before any model could read the
		// prompt; "about 1 second" would overstate the budget.
		return "";
	}
	if (timeoutMs < 120_000) {
		const sec = Math.floor(timeoutMs / 1000);
		return `[TIME BUDGET] You have about ${sec} ${sec === 1 ? "second" : "seconds"}. The run is terminated at the limit and you may be cut off mid-task. Provide a direct, concise final answer immediately.`;
	}
	// Floor, never round: the notice must not claim more time than the
	// watchdog grants.
	const min = Math.floor(timeoutMs / 60_000);
	return `[TIME BUDGET] You have about ${min} minutes of wall-clock time. The run is terminated at the limit and you may be cut off mid-task. Deliver a complete final answer before it; if the task cannot fit, deliver the most valuable complete subset and state what remains.`;
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
