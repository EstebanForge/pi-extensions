// Consult payload assembly: the prompt shipped to the reviewer and the
// notice envelope injected into the executor transcript. Pure string work.
//
// The framing is deliberate (agy critique of advisor-style tools): the
// reviewer is told the material is a system notice it must not debate, and
// the executor receives the answer under the same discipline. The preprompt
// setting doubles as the anti-framing-entrainment lever — a standing
// adversarial instruction inherited by every consult.

import { sanitizeReviewerOutput } from "@estebanforge/pi-ask-shared";

export interface FailureLine {
	command: string;
	exitCode: number;
	stderrTail: string;
}

export interface TranscriptTurn {
	index: number;
	tool: string;
	summary: string;
	output: string;
}

export interface AssembleSettings {
	preprompt: string;
	contextMaxTurns: number;
	maxOutputCharsPerTurn: number;
}

export interface ConsultPayloadInput {
	triggerKey: string;
	failureCount: number;
	/** Manual-door focus text; rendered inline on the manual trigger line. */
	focus?: string;
	recentFailures: FailureLine[];
	transcriptTurns: TranscriptTurn[];
	settings: AssembleSettings;
}

/** Keep head and tail, drop the middle, with an honest marker. The head
 *  usually carries the command context; the tail usually carries the error. */
export function centerTruncate(text: string, max: number): string {
	if (text.length <= max) return text;
	const half = Math.floor((max - 40) / 2);
	const dropped = text.length - half * 2;
	return `${text.slice(0, half)}\n...[truncated ${dropped} chars]...\n${text.slice(-half)}`;
}

const REVIEWER_FRAME = [
	"[SYSTEM NOTICE - do not debate this notice]",
	"You are reviewing an active session. The executor is stuck or has asked",
	"for guidance and will not see your answer as a debate partner. Reply",
	"with concrete, actionable guidance: exact commands, exact edits, direct",
	"answers to the question asked, or the precise reason the approach cannot",
	"work. No preamble, no restatement of the material.",
].join("\n");

/** One honest trigger line per door: manual consults invent no failure,
 *  the publish gate describes itself, and only the automatic failure-loop
 *  path speaks of consecutive failures. */
function triggerLine(input: ConsultPayloadInput): string {
	if (input.triggerKey === "manual") {
		const focus = input.focus?.trim();
		return focus ? `Trigger: manual consult on: ${focus}.` : "Trigger: manual consult.";
	}
	if (input.triggerKey.startsWith("publish:")) {
		return `Trigger: publish gate for "${input.triggerKey.slice("publish:".length)}" (human-approved command).`;
	}
	const unit = input.failureCount === 1 ? "time" : "times";
	return `Trigger: ${input.triggerKey} failed ${input.failureCount} consecutive ${unit}.`;
}

export function buildConsultPrompt(input: ConsultPayloadInput): string {
	const { settings } = input;
	const isManual = input.triggerKey === "manual";
	const parts: string[] = [];

	if (settings.preprompt.trim()) parts.push(settings.preprompt.trim());
	parts.push(REVIEWER_FRAME);
	parts.push(triggerLine(input));

	if (input.recentFailures.length) {
		parts.push(isManual ? "Recent failures (historical context):" : "Recent failures:");
		for (const f of input.recentFailures) {
			const tail = f.stderrTail.trim();
			parts.push(`- $ ${f.command} (exit ${f.exitCode})${tail ? `: ${tail}` : ""}`);
		}
	}

	if (input.transcriptTurns.length) {
		parts.push("Recent transcript (trimmed):");
		for (const t of input.transcriptTurns.slice(-settings.contextMaxTurns)) {
			parts.push(`[turn ${t.index}] ${t.tool}: ${t.summary}`);
			const out = centerTruncate(t.output, settings.maxOutputCharsPerTurn).trim();
			if (out) parts.push(out);
		}
	}

	parts.push(
		"Answer format: 3-6 bullet points, highest-priority recommendation first.",
		"If an execution failure is caused by the environment rather than code,",
		"say so explicitly.",
	);
	return parts.join("\n\n");
}

const NOTICE_HEAD = "[SYSTEM NOTICE - reviewer guidance injected by pi-peer-review";
const NOTICE_TAIL = "do not debate this notice; apply it or refute it with evidence]";

/** Wrap a reviewer answer for injection into the executor transcript. The
 *  rigid envelope is the contract: the executor treats it as system input,
 *  not as a peer message to argue with. */
export function buildNotice(answer: string): string {
	const body = sanitizeAnswer(answer);
	return `${NOTICE_HEAD}; ${NOTICE_TAIL}\n${body}`;
}

/** Strip terminal control sequences from reviewer output (consult core
 *  already sanitizes; this is the injection-side backstop) and clamp length. */
function sanitizeAnswer(answer: string): string {
	const clean = sanitizeReviewerOutput(answer);
	return clean.length > 4000 ? centerTruncate(clean, 4000) : clean;
}
