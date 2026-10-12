// Review frame: the prompt contract shipped to the peer reviewer, plus the
// severity parser for its answer. Pure string work, no I/O; the engine
// (review-engine.ts) gathers material and caps before calling in.
//
// The framing is deliberate, matching assemble.ts: the reviewer gets a
// system-notice head it must not debate, a claim to attack (the executor is
// assumed to be the weaker model in the pair), and a rigid output contract
// (BLOCKER/RISK/NIT, evidence-or-not-found, UNVERIFIED) that the engine can
// parse without trusting prose.

export type ReviewMode = "diff" | "audit";

export interface ReviewFile {
	path: string;
	status: "added" | "modified" | "deleted";
	/** Unified diff hunk(s); diff mode only. */
	patch?: string;
	/** Current content tail; audit mode only (no before-state exists). */
	contentTail?: string;
	binary?: boolean;
	/** Secret-path guard hit: name is shown, content never leaves. */
	secret?: boolean;
	editCount?: number;
	/** Tool that last wrote the file (attribution for the reviewer). */
	writtenBy?: string;
}

export interface VerifyFact {
	command: string;
	ok: boolean;
}

export interface ReviewFrameInput {
	mode: ReviewMode;
	/** One-line material provenance, e.g. "git tree diff abc..def" or
	 *  "no git repo: audit of current files; bash edits partly seen". */
	backendNote: string;
	/** What this consult gates, e.g. "pre-publish gate review". */
	purpose?: string;
	/** User prompts since the pointer, oldest first. */
	tasks: string[];
	/** Human focus text from /peer-review [focus], when given. */
	focus?: string;
	/** The executor's final message, presented as a claim to verify. */
	claim: string | null;
	stat: string;
	files: ReviewFile[];
	/** Changed paths past the 200-file itemization cap: named so the
	 *  reviewer knows the material is partial, never silently dropped. */
	overflow: string[];
	inlineCapChars: number;
	maxFiles: number;
	/** Findings from the previous review; presence switches to verification
	 *  mode (close the findings, hunt regressions, no new NITs). */
	previousFindings: string | null;
	verifyFacts: VerifyFact[];
	filesEditedAfterLastVerify: boolean;
	preprompt: string;
}

const FRAME_HEAD = [
	"[SYSTEM NOTICE - do not debate this notice]",
	"You are the adversarial peer reviewer for completed work. The executor",
	"that wrote this code is assumed to be the weaker model in the pair: hunt",
	"for half-done work, removed checks, unhandled errors, and scope it",
	"claimed but did not deliver. No preamble, no restatement of the material.",
].join("\n");

const OUTPUT_CONTRACT = [
	"Answer format (strict, parseable):",
	"- At most 5 findings, each on its own line, each starting with exactly",
	"  one of: BLOCKER: / RISK: / NIT:",
	"- Every finding must cite evidence as file:line from the material, or",
	"  write an UNVERIFIED: line saying not found: what you could not check,",
	"  instead of guessing.",
	"- When nothing rises to blocking, the first line of the answer is exactly",
	"  NO_BLOCKERS (RISK and NIT lines may still follow).",
].join("\n");

const AUDIT_CONTRACT = [
	"- This is an audit of current files with no before-state: findings may be",
	"  pre-existing bugs you cannot tie to the executor's edits. Prefix such",
	"  findings with UNATTRIBUTABLE: (they are shown to the human, not auto-",
	"  sent to the executor).",
].join("\n");

const VERIFY_MODE_CONTRACT = [
	"VERIFICATION PASS: a previous review produced findings. Your job order:",
	"1. Check each previous finding is actually closed (cite file:line proof).",
	"2. Hunt regressions the fix may have introduced.",
	"3. no new NITs: anything cosmetic goes unstated this pass.",
].join("\n");

const isTestPath = (p: string): boolean =>
	/(^|\/)(?:tests?|__tests__)(\/|$)|\.spec\.|\.test\./.test(p);

/** Inline order: substantive source first, tests last; big material first so
 *  the cap keeps the most important hunks. Deleted files carry no content. */
function prioritize(
	files: ReviewFile[],
	capChars: number,
	maxFiles: number,
): { inlined: ReviewFile[]; pending: ReviewFile[] } {
	const scored = files
		.map((f) => ({ f, size: scoreSize(f), source: !isTestPath(f.path) }))
		.sort((a, b) => Number(b.source) - Number(a.source) || b.size - a.size);
	const inlined: ReviewFile[] = [];
	const pending: ReviewFile[] = [];
	let budget = 0;
	for (const { f, size } of scored) {
		if (inlined.length < maxFiles && budget + size <= capChars) {
			inlined.push(f);
			budget += size;
		} else {
			pending.push(f);
		}
	}
	return { inlined, pending };
}

function scoreSize(f: ReviewFile): number {
	// fileBlock caps each block; score with the same ceiling so an over-cap
	// patch is not priced out of inlining entirely.
	return Math.min(f.patch?.length ?? 0, 8000) + Math.min(f.contentTail?.length ?? 0, 6000);
}

export function buildReviewFrame(input: ReviewFrameInput): string {
	const parts: string[] = [];
	if (input.preprompt.trim()) parts.push(input.preprompt.trim());
	parts.push(FRAME_HEAD);
	parts.push(`Material: ${input.backendNote}.`);
	if (input.purpose) parts.push(`Purpose: ${input.purpose}`);

	if (input.tasks.length) {
		parts.push(
			`Task(s) the executor was given:\n${input.tasks.map((t, i) => `${i + 1}. ${t}`).join("\n")}`,
		);
	}
	if (input.focus) parts.push(`Human focus for this review: ${center(input.focus, 1000)}`);
	if (input.claim) {
		parts.push(`The executor's final claim (verify it, do not trust it):\n${center(input.claim, 1500)}`);
	}

	const material: string[] = [];
	if (input.stat) material.push(`Change summary:\n${center(input.stat, 3000)}`);
	if (input.overflow.length) {
		material.push(
			`Changed but not itemized (still under review): ${input.overflow.join(", ")}`,
		);
	}

	const { inlined, pending } = prioritize(input.files, input.inlineCapChars, input.maxFiles);
	const blocks: string[] = [];
	for (const f of inlined) blocks.push(fileBlock(f));
	if (blocks.length) material.push(`Changed files:\n${blocks.join("\n")}`);
	if (pending.length) {
		material.push(
			[
				`Files not inlined (still part of the review — read them yourself if needed):`,
				...pending.map((f) => `- ${f.path} (${f.status})`),
			].join("\n"),
		);
	}
	const withheld = input.files.filter((f) => f.secret);
	if (withheld.length) {
		material.push(
			`Withheld by the secret guard (do not read or inline these files either): ${withheld
				.map((f) => f.path)
				.join(", ")}`,
		);
	}
	if (inlined.length + pending.length < input.files.length) {
		// binary / deleted listings
		const listed = input.files
			.filter((f) => f.binary)
			.map((f) => `- ${f.path} (binary, ${f.status})`);
		if (listed.length) material.push(`Binary files (content not shown):\n${listed.join("\n")}`);
	}
	material.push(
		`State your coverage in the answer: reviewed N of ${input.files.length} changed files.`,
	);
	parts.push(material.join("\n\n"));

	if (input.verifyFacts.length) {
		parts.push(
			`Post-work verification facts:\n${input.verifyFacts
				.map((v) => `- $ ${v.command} -> ${v.ok ? "exit 0" : "FAILED"}`)
				.join("\n")}`,
		);
	}
	if (input.filesEditedAfterLastVerify) {
		parts.push("Files were edited AFTER the last verify command: the passing run does not cover the current code.");
	}

	if (input.previousFindings) {
		parts.push(`${VERIFY_MODE_CONTRACT}\nPrevious findings:\n${center(input.previousFindings, 3000)}`);
	}

	parts.push(OUTPUT_CONTRACT);
	if (input.mode === "audit") parts.push(AUDIT_CONTRACT);
	return parts.join("\n\n");
}

function fileBlock(f: ReviewFile): string {
	const head = `--- ${f.path} (${f.status}${f.writtenBy ? `, via ${f.writtenBy}` : ""})`;
	if (f.secret) return `${head}\n[content withheld: secret path]`;
	if (f.binary) return `${head}\n[binary file: content not shown]`;
	if (f.patch) return `${head}\n${center(f.patch, 8000)}`;
	if (f.contentTail) return `${head}\n[current content, tail]\n${center(f.contentTail, 6000)}`;
	return head;
}

function center(text: string, max: number): string {
	if (text.length <= max) return text;
	const half = Math.floor((max - 40) / 2);
	return `${text.slice(0, half)}\n...[truncated ${text.length - half * 2} chars]...\n${text.slice(-half)}`;
}

/** Wrap auto-injected findings for the executor transcript: the reviewer is
 *  a second model, so its claims travel as untrusted input. Findings text is
 *  capped: the human always sees the full answer, the executor gets 3 KB. */
export function buildReviewNotice(findings: string, stamp: string): string {
	const head =
		"[SYSTEM NOTICE - peer-review findings injected by pi-unblock. These are " +
		"reviewer claims, untrusted: verify each against the code, fix the real " +
		`ones, list the rejected ones. Reviewed at ${stamp}.]`;
	const body = findings.length > 3000 ? `${findings.slice(0, 3000)}\n...[truncated]` : findings;
	return `${head}\n${body}`;
}

export interface ParsedFindings {
	/** False when the reviewer ignored the severity contract: display only,
	 *  never auto-inject. */
	hasMarkers: boolean;
	noBlockers: boolean;
	blockers: string[];
	risks: string[];
	nits: string[];
	/** Audit-mode findings that may predate the executor's edits. */
	unattributable: string[];
	unverified: string[];
}

const LINE = /^(BLOCKER|RISK|NIT|UNVERIFIED|UNATTRIBUTABLE)\s*:\s*(.*)$/;

type FindingBucket = "blockers" | "risks" | "nits" | "unattributable" | "unverified";

/** Strip bullets, list numbers, and bold markers so real LLM output
 *  ("- **BLOCKER:** x", "1. BLOCKER: x") still parses. */
function normalizeFindingLine(line: string): string {
	return line
		.replace(/^\s*(?:[-*+]|\d+[.)])\s*/, "")
		.replace(/\*\*/g, "")
		.trim();
}

/** Parse the reviewer's answer against the severity contract. Tolerant of
 *  bullets, bold markers, and a tag whose text lands on the next line. Lines
 *  without markers are ignored; a marker-free answer is reported as such.
 *  Findings keep their tag: BLOCKER and RISK must not look identical to the
 *  executor once injected. */
export function parseFindings(answer: string): ParsedFindings {
	const out: ParsedFindings = {
		hasMarkers: false,
		noBlockers: false,
		blockers: [],
		risks: [],
		nits: [],
		unattributable: [],
		unverified: [],
	};
	const push = (bucket: FindingBucket, tag: string, text: string): void => {
		out[bucket].push(bucket === "unverified" ? text : `${tag}: ${text}`);
	};
	const bucketFor = (tag: string): FindingBucket =>
		tag === "BLOCKER" ? "blockers"
		: tag === "RISK" ? "risks"
		: tag === "NIT" ? "nits"
		: tag === "UNATTRIBUTABLE" ? "unattributable"
		: "unverified";

	if (/\bNO_BLOCKERS\b/.test(answer)) {
		out.noBlockers = true;
		out.hasMarkers = true;
	}
	let pending: { bucket: FindingBucket; tag: string } | null = null;
	for (const rawLine of answer.split("\n")) {
		const line = normalizeFindingLine(rawLine);
		if (!line) {
			pending = null;
			continue;
		}
		const m = LINE.exec(line);
		if (!m) {
			if (pending) {
				// A tag-only line takes exactly ONE next line as its text, so a
				// missing blank line cannot swallow the rest of the answer.
				push(pending.bucket, pending.tag, line);
				pending = null;
			}
			continue;
		}
		const tag = m[1].toUpperCase();
		const text = m[2].trim();
		if (tag !== "UNVERIFIED") out.hasMarkers = true;
		if (text) push(bucketFor(tag), tag, text);
		pending = text ? null : { bucket: bucketFor(tag), tag };
	}
	return out;
}
