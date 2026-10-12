// Review engine: the /peer-review machinery. Owns the review pointer (what
// has already been reviewed), gathers material under two backends (git tree
// diff, or an mtime-walk audit when there is no repo), builds the frame, runs
// the consult, and delivers findings (full text to the human, BLOCKER/RISK
// only to the executor as untrusted claims on the next turn).
//
// Pointer rules (fail-safe by design): a failed consult never advances the
// pointer, so coverage is never lost; an empty delta costs nothing; a backend
// flip (git init / rm -rf .git mid-session) resets the pointer with an audit
// reason. The consult timeout is a code constant, not a setting: a file-
// reading review must not livelock against the short consult timeout.
import { appendFileSync, closeSync, mkdirSync, openSync, readSync, statSync } from "node:fs";
import { isAbsolute, join, relative, resolve, sep } from "node:path";
import {
	ConsultError,
	levelToTier,
	runConsult as defaultRunConsult,
	type ConsultOptions,
	type ConsultPeer,
} from "@estebanforge/pi-ask-shared";
import { isSecretPath, redactText } from "./secrets.js";
import {
	buildReviewFrame,
	buildReviewNotice,
	parseFindings,
	type ReviewFile,
	type ReviewMode,
	type VerifyFact,
} from "./review-frame.js";
import {
	detectBackend,
	EMPTY_TREE,
	fileStatuses,
	gitDiffStat,
	gitPatchFor,
	gitTreeSnapshot,
	hashSnapshot,
	isBinaryPath,
	isExcludedPath,
	walkRecentFiles,
	type Backend,
	type ChangeFile,
} from "./snapshot.js";
import { describeCall, resolveCliFor, resolveReviewerCall, REVIEW_TIMEOUT_MS, type Reviewer, type UnblockSettings } from "./settings.js";

/** Review consults read files and repos; they need real headroom. */
/** Candidate cap for the mtime walk (files backend). */
const WALK_CAP = 20_000;
/** Per-file content tail kept in audit mode. */
const AUDIT_TAIL_CHARS = 6000;
/** Task/claim caps fed to the frame. */
const TASK_CAP_CHARS = 2000;
const MAX_TASKS = 5;
const MAX_VERIFY_FACTS = 10;
/** After this many passes over the same file, say so (soft, never blocks). */
const DIMINISHING_PASSES = 2;

/** Shell commands that count as post-work verification facts. */
const VERIFY_RE =
	/\b(test|tests|vitest|jest|pytest|cargo\s+test|cargo\s+clippy|go\s+test|tsc|typecheck|typecheck\.|lint|eslint|biome|ruff|phpstan|psalm|shellcheck)\b/;

export interface ReviewEnginePorts {
	runConsult: typeof defaultRunConsult;
	nowMs(): number;
	notify(text: string, level?: "info" | "warning"): void;
	/** Findings bound for the executor's next prompt (idle-safe delivery). */
	injectNextTurn(text: string): void;
	/** Mutex shared with the controller's consult gate. */
	tryStart(): { started: boolean; blockedBy?: string };
	end(): void;
}

export interface ReviewEngineOptions {
	cwd: string;
	getSettings(): UnblockSettings;
	ports: ReviewEnginePorts;
}

interface Pointer {
	backend: Backend;
	/** Git backend: tree id. */
	tree: string | null;
	/** Files backend: content hashes. */
	hashes: Map<string, string>;
	atMs: number;
}

interface Delta {
	backend: Backend;
	fromTree: string | null;
	toTree: string | null;
	statuses: ChangeFile[];
	stat: string;
	/** Files backend: content hashes at delta time; the reviewed pointer. */
	hashes: Map<string, string>;
	/** When the delta was computed. The pointer inherits it: files created
	 *  during a long consult have mtimes before the consult ended, and the
	 *  next walk must still see them. */
	atMs: number;
}

export class ReviewEngine {
	private readonly cwd: string;
	private readonly getSettings: () => UnblockSettings;
	private readonly ports: ReviewEnginePorts;

	private pointer: Pointer | null = null;
	private baselinePointer: Pointer | null = null;
	private readonly prompts: string[] = [];
	private claim: string | null = null;
	private previousFindings: string | null = null;
	private readonly passCounts = new Map<string, number>();
	private readonly touched = new Map<string, { tool: string; atMs: number }>();
	private readonly editHunks: { path: string; before: string; after: string; atMs: number }[] = [];
	private readonly verifyFacts: VerifyFact[] = [];
	private lastEditAtMs = 0;
	private lastVerifyOkAtMs = 0;

	constructor({ cwd, getSettings, ports }: ReviewEngineOptions) {
		this.cwd = cwd;
		this.getSettings = getSettings;
		this.ports = ports;
	}

	// --- event-fed state ------------------------------------------------------

	/** User prompt captured at before_agent_start. */
	notePrompt(text: string): void {
		const t = text.trim();
		if (!t) return;
		this.prompts.push(t.slice(-TASK_CAP_CHARS));
		if (this.prompts.length > MAX_TASKS) this.prompts.shift();
	}

	/** Executor's final message, captured at agent_end. */
	noteClaim(text: string | null): void {
		const t = text?.trim();
		if (t) this.claim = t;
	}

	/** File written via a write/edit tool: attribution + candidate source.
	 *  Paths are contained to cwd (tool inputs are model-authored; a `../`
		*  or absolute path must never send outside material to the reviewer). */
	noteWrite(path: string, tool: string): void {
		const rel = this.sanitizeRel(path);
		if (!rel) return;
		this.touched.set(rel, { tool, atMs: this.ports.nowMs() });
		this.lastEditAtMs = this.ports.nowMs();
	}

	private sanitizeRel(path: string): string | null {
		if (!path) return null;
		const rel = relative(this.cwd, resolve(this.cwd, path));
		if (!rel || rel.startsWith("..") || isAbsolute(rel)) return null;
		return rel.split(sep).join("/");
	}

	/** Edit-tool before/after capture: pseudo-diff material for audit mode.
	 *  Redaction runs BEFORE slicing: a cut private-key block would leak its
		*  body past the truncated BEGIN line. */
	noteEdit(path: string, before: string, after: string): void {
		const rel = this.sanitizeRel(path);
		if (!rel) return;
		this.noteWrite(rel, "edit");
		this.editHunks.push({
			path: rel,
			before: redactText(before).slice(-2000),
			after: redactText(after).slice(0, 2000),
			atMs: this.ports.nowMs(),
		});
		if (this.editHunks.length > 40) this.editHunks.shift();
	}

	/** Shell result: verification facts (test/typecheck/lint runs). */
	noteShell(command: string, ok: boolean): void {
		if (!VERIFY_RE.test(command)) return;
		this.verifyFacts.push({ command, ok });
		if (this.verifyFacts.length > MAX_VERIFY_FACTS) this.verifyFacts.shift();
		if (ok) this.lastVerifyOkAtMs = this.ports.nowMs();
	}

	/** Run settled: cheap telemetry only (no delta computation). */
	noteSettled(aborted: boolean): void {
		this.log({ kind: "settled", aborted, touches: this.touched.size, claim: this.claim !== null });
	}

	// --- pointer --------------------------------------------------------------

	/** Take the first snapshot. Safe to call repeatedly; the extension fires
	 *  it at session_start and every review re-ensures it. */
	async baseline(): Promise<void> {
		if (this.pointer) return;
		this.pointer = await this.takeSnapshot();
		this.baselinePointer = this.pointer;
		this.log({ kind: "baseline", backend: this.pointer.backend });
	}

	/** Human-facing unreviewed count for the publish confirm dialog. */
	async unreviewedLine(): Promise<string | null> {
		await this.baseline();
		const delta = await this.computeDelta(this.pointer!);
		if (delta.statuses.length === 0) return null;
		const statTail = delta.stat.split("\n").at(-1);
		return `${statTail || `${delta.statuses.length} file(s) changed`} since last peer review`;
	}

	/** Publish review succeeded: everything so far counts as reviewed. */
	markReviewed(): void {
		this.advancePointer("publish");
	}

	private takeSnapshot(): Pointer {
		try {
			const backend = detectBackend(this.cwd);
			if (backend === "git") {
				return { backend, tree: gitTreeSnapshot(this.cwd), hashes: new Map(), atMs: this.ports.nowMs() };
			}
		} catch {
			// fall through to files backend
		}
		return {
			backend: "files",
			tree: null,
			hashes: hashSnapshot(this.cwd, walkRecentFiles(this.cwd, 0, WALK_CAP)),
			atMs: this.ports.nowMs(),
		};
	}
	/** The pointer moves to what was actually reviewed, never to a fresh
	 *  snapshot: edits made while the consult ran (up to 10 min+) stay under
	 *  review. Git: the diffed tree. Files: the computed hash map. */
	private advancePointer(cause: string, delta?: Delta): void {
		this.pointer = delta
			? { backend: delta.backend, tree: delta.toTree, hashes: delta.hashes, atMs: delta.atMs }
			: this.takeSnapshot();
		this.prompts.length = 0;
		this.claim = null;
		this.log({ kind: "advance", cause, backend: this.pointer.backend });
	}

	// --- review ---------------------------------------------------------------

	/** The manual door: review everything since the last check (or the session
	 *  baseline with full), consult the reviewer, deliver findings. */
	async peerReview(opts: { reviewer?: Reviewer; full?: boolean; focus?: string; signal?: AbortSignal } = {}): Promise<void> {
		await this.baseline();
		const material = await this.gather(opts);
		if (!material) return; // empty delta or flip notice already sent

		const { frame, delta } = material;
		const gate = this.ports.tryStart();
		if (!gate.started) {
			this.ports.notify(`peer-review: gate blocked (${gate.blockedBy ?? "in-flight"})`);
			return;
		}

		const s = this.getSettings();
		const peer = (opts.reviewer ?? s.reviewer) as ConsultPeer;
		const { model, effort } = resolveReviewerCall(s, peer as Reviewer);
		// The consult is a headless CLI run that can take minutes: without
		// this line the command looks dead until findings land.
		const scope = opts.full
			? "a full audit since session start"
			: `changes in ${delta.statuses.length} file(s)`;
		this.ports.notify(
			`peer-review: consulting ${peer} (${describeCall(model, effort)}) on ${scope} — please wait for the response`,
			"info",
		);
		const { binary, args } = resolveCliFor(peer as Reviewer, s.binary);
		const consultOpts: ConsultOptions = {
			peer,
			binary,
			args,
			prompt: frame,
			timeoutMs: Math.max(REVIEW_TIMEOUT_MS, 3 * s.timeoutSec * 1000),
			signal: opts.signal,
			model,
		};
		if (peer === "claude") consultOpts.claude = { effort: effort ?? undefined, mode: "read" };
		else if (peer === "codex") consultOpts.codex = { reasoning: effort ?? undefined, sandbox: "read-only" };
		else consultOpts.agy = { resolved: { model: model ?? "", effort: effort ? levelToTier(effort) : undefined } };

		let answer: string;
		try {
			const result = await this.ports.runConsult(consultOpts);
			answer = result.answer;
		} catch (err) {
			this.ports.end();
			// Failed reviews keep the pointer: the wave stays under review.
			const reason = describeFailure(err);
			this.ports.notify(`peer-review: consult failed — ${reason}`);
			this.log({ kind: "peer-review", backend: delta.backend, files: delta.statuses.length, error: reason.slice(0, 200) });
			return;
		}
		this.ports.end();

		const parsed = parseFindings(answer);
		const counts = `BLOCKER ${parsed.blockers.length}, RISK ${parsed.risks.length}, NIT ${parsed.nits.length}`;
		const head = `peer-review: ${delta.statuses.length} file(s) — ${counts}`;
		this.ports.notify(
			parsed.hasMarkers
				? `${head}\n${answer}`
				: `${head}\n${answer}\n(no severity markers; findings not auto-sent)`,
		);
		this.log({
			kind: "peer-review",
			backend: delta.backend,
			files: delta.statuses.length,
			blockers: parsed.blockers.length,
			risks: parsed.risks.length,
			nits: parsed.nits.length,
			contract: parsed.hasMarkers,
		});

		// Executor delivery: BLOCKER/RISK only, as untrusted claims.
		const injectable = [...parsed.blockers, ...parsed.risks];
		if (parsed.hasMarkers && injectable.length > 0) {
			const stamp = new Date(this.ports.nowMs()).toISOString();
			this.ports.injectNextTurn(buildReviewNotice(injectable.join("\n"), stamp));
		}

		// Pointer advances only on success, and only to the reviewed tree.
		this.advancePointer("review", delta);
		const repeats = delta.statuses
			.filter((f) => (this.passCounts.get(f.path) ?? 0) >= DIMINISHING_PASSES)
			.map((f) => f.path);
		if (repeats.length > 0) {
			this.ports.notify(
				`peer-review: pass ${DIMINISHING_PASSES + 1} on ${repeats.join(", ")} — diminishing returns`,
			);
		}
		for (const f of delta.statuses) {
			this.passCounts.set(f.path, (this.passCounts.get(f.path) ?? 0) + 1);
		}
		this.previousFindings =
			parsed.blockers.length + parsed.risks.length > 0
				? injectable.join("\n").slice(0, 3000)
				: null;
	}

	/** Frame for the publish gate: null when there is nothing unreviewed, so
	 *  the controller falls back to its ring-based consult. */
	async publishFrame(signal?: AbortSignal): Promise<string | null> {
		await this.baseline();
		const material = await this.gather({}, "pre-publish gate review: BLOCKER findings should block the publish");
		void signal;
		return material?.frame ?? null;
	}

	// --- material -------------------------------------------------------------

	private async gather(
		opts: { full?: boolean; focus?: string },
		purpose?: string,
	): Promise<{ frame: string; delta: Delta } | null> {
		let from = opts.full ? this.baselinePointer : this.pointer;
		const backend = detectBackend(this.cwd);
		if (from && from.backend !== backend) {
			// git init / .git removal mid-session: the old pointer is meaningless.
			// First review after the flip is a first-review audit of the current
			// state (diff against an empty pointer); the pointer advances to a
			// fresh snapshot of the new backend only after a successful review.
			this.ports.notify(`peer-review: backend changed to ${backend}; first review is a full audit`);
			from = { backend, tree: null, hashes: new Map(), atMs: 0 };
		}

		const delta = this.computeDelta(from!);
		if (delta.statuses.length === 0) {
			this.ports.notify(`peer-review: nothing changed since last review (${backend})`);
			return null;
		}

		const { files, overflow } =
			backend === "git"
				? this.gitFiles(delta)
				: this.auditFiles(delta, from!.atMs);
		const s = this.getSettings();
		const frame = buildReviewFrame({
			mode: (backend === "git" ? "diff" : "audit") as ReviewMode,
			backendNote:
				backend === "git"
					? `git tree diff ${delta.fromTree?.slice(0, 7)}..${delta.toTree?.slice(0, 7)}`
					: "no git repo: audit of current files; bash edits partly seen",
			purpose,
			tasks: [...this.prompts],
			focus: opts.focus,
			claim: this.claim,
			stat: delta.stat,
			files,
			overflow,
			inlineCapChars: 20_000,
			maxFiles: 40,
			previousFindings: this.previousFindings,
			verifyFacts: [...this.verifyFacts],
			filesEditedAfterLastVerify: this.lastEditAtMs > this.lastVerifyOkAtMs,
			preprompt: s.preprompt,
		});
		return { frame, delta };
	}

	private computeDelta(from: Pointer): Delta {
		const atMs = this.ports.nowMs();
		const backend = detectBackend(this.cwd);
		if (backend === "git") {
			const toTree = gitTreeSnapshot(this.cwd);
			// from.tree is null only after a backend flip: diff against the
			// empty tree so the first audit sees everything as added.
			const fromTree = from.tree ?? EMPTY_TREE;
			const statuses = fileStatuses(this.cwd, fromTree, toTree);
			const stat = gitDiffStat(this.cwd, fromTree, toTree);
			return { backend, fromTree, toTree, statuses, stat, hashes: new Map(), atMs };
		}
		const candidates = new Set<string>([
			...walkRecentFiles(this.cwd, Math.max(0, from.atMs - 2000), WALK_CAP),
			...this.touched.keys(),
			...from.hashes.keys(),
		]);
		const now = hashSnapshot(this.cwd, [...candidates]);
		const statuses: ChangeFile[] = [];
		for (const [path, hash] of now) {
			const before = from.hashes.get(path);
			if (before === undefined) statuses.push({ path, status: "added" });
			else if (before !== hash) statuses.push({ path, status: "modified" });
		}
		for (const [path] of from.hashes) {
			if (!now.has(path)) {
				try {
					statSync(join(this.cwd, path));
				} catch {
					statuses.push({ path, status: "deleted" });
				}
			}
		}
		return { backend, fromTree: null, toTree: null, statuses, stat: `${statuses.length} file(s) changed`, hashes: now, atMs };
	}

	private gitFiles(delta: Delta): { files: ReviewFile[]; overflow: string[] } {
		const listed = delta.statuses.slice(0, 200).filter((f) => !isExcludedPath(f.path));
		const overflow = delta.statuses.slice(200).map((f) => f.path);
		const files = listed.map((f) => {
			const base: ReviewFile = {
				path: f.path,
				status: f.status,
				writtenBy: this.touched.get(f.path)?.tool,
				secret: isSecretPath(f.path),
			};
			if (base.secret || f.status === "deleted") return base;
			const abs = join(this.cwd, f.path);
			try {
				if (isBinaryPath(abs)) {
					base.binary = true;
					return base;
				}
			} catch {
				// file only exists in the target tree (e.g. added in a branch);
				// content still reachable through the tree diff below.
			}
			const patch = gitPatchFor(this.cwd, delta.fromTree!, delta.toTree!, [f.path]);
			base.patch = redactText(patch);
			return base;
		});
		return { files, overflow };
	}

	private auditFiles(delta: Delta, sinceMs: number): { files: ReviewFile[]; overflow: string[] } {
		const hunks = new Map<string, string[]>();
		for (const h of this.editHunks) {
			if (h.atMs < sinceMs - 2000) continue;
			const list = hunks.get(h.path) ?? [];
			list.push(`@@ edit @@\n-${h.before.split("\n").join("\n-")}\n+${h.after.split("\n").join("\n+")}`);
			hunks.set(h.path, list);
		}
		const listed = delta.statuses.slice(0, 200).filter((f) => !isExcludedPath(f.path));
		const overflow = delta.statuses.slice(200).map((f) => f.path);
		const files = listed.map((f) => {
			const base: ReviewFile = {
				path: f.path,
				status: f.status,
				writtenBy: this.touched.get(f.path)?.tool,
				secret: isSecretPath(f.path),
			};
			if (base.secret) return base;
			const abs = join(this.cwd, f.path);
			if (f.status === "deleted") return base;
			try {
				if (isBinaryPath(abs)) {
					base.binary = true;
					return base;
				}
				// Redact BEFORE slicing; and read only a bounded window (the
				// tail), so a huge file costs a bounded scan.
				const windowBytes = 128 * 1024;
				const st = statSync(abs);
				const start = Math.max(0, st.size - windowBytes);
				const len = Math.min(windowBytes, st.size - start);
				const buf = Buffer.alloc(len);
				const fd = openSync(abs, "r");
				try {
					readSync(fd, buf, 0, len, start);
				} finally {
					try {
						closeSync(fd);
					} catch {}
				}
				base.contentTail = redactText(buf.toString("utf-8")).slice(-AUDIT_TAIL_CHARS);
			} catch {
				return base;
			}
			const hunk = hunks.get(f.path);
			if (hunk?.length) base.patch = redactText(hunk.join("\n"));
			return base;
		});
		return { files, overflow };
	}

	private log(entry: Record<string, unknown>): void {
		try {
			const dir = join(this.cwd, ".pi");
			mkdirSync(dir, { recursive: true });
			appendFileSync(join(dir, "unblock-log.jsonl"), `${JSON.stringify({ ts: new Date(this.ports.nowMs()).toISOString(), ...entry })}\n`);
		} catch {
			// telemetry must never break a review
		}
	}
}

function describeFailure(err: unknown): string {
	if (err instanceof ConsultError) {
		return err.stderr ? `${err.message}: ${err.stderr.slice(-300)}` : err.message;
	}
	return err instanceof Error ? err.message : String(err);
}
