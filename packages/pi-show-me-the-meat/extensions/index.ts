/**
 * pi-show-me-the-meat — reading-diff tool that shows the meat, not the churn.
 *
 * Registers a `meat` tool that reads a git diff, hands it to an isolated
 * sub-agent (which reuses your configured Pi model, so any provider works),
 * and compiles the sub-agent's remove/replace/fold plan into a faithful reading
 * diff: every kept line is a real line from the original diff, emitted verbatim.
 *
 * Inspired by meat (https://github.com/boldsoftware/meat), distilled to its
 * source-anchored edit-plan model (REMOVE | REPLACE | FOLD) with a minimal
 * deterministic compiler, mandatory mechanical import removal, per-chunk
 * abridging with a content-addressed cache, and first-parent merge rendering.
 */
import type { ExtensionAPI, ThemeColor } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { StringEnum } from "@earendil-works/pi-ai";
import type { Model } from "@earendil-works/pi-ai/compat";
import { Box, Text } from "@earendil-works/pi-tui";
import { existsSync, mkdirSync, readFileSync, renameSync, statSync, writeFileSync } from "node:fs";
import { createHash } from "node:crypto";
import os from "node:os";
import path from "node:path";

import { numberDiff, compilePlan, manifestLine, type CompileResult, type Submission } from "./compiler.js";
import { abridgeViaSubagent } from "./subagent.js";
import { RUBRIC } from "./rubric.js";

const STAT = ["--stat", "--patch"];
const GIT_PREFIX: Record<string, string[]> = {
	working: ["diff", ...STAT],
	staged: ["diff", "--cached", ...STAT],
	all: ["diff", "HEAD", ...STAT],
	// `-m --first-parent` renders a merge commit as a normal two-tree diff against
	// its first parent, so merges flow through the compiler instead of being rejected.
	commit: ["show", "-m", "--first-parent", ...STAT],
	range: ["diff", ...STAT],
};

// Per-chunk single-shot budget for the sub-agent. meat chunks at ~400 KB / 32
// chunks; we start narrower and split at file then hunk boundaries.
const MAX_LINES = 2000;
const MAX_BYTES = 80_000;
const MAX_CHUNKS = 32;
// Hard ceiling on the whole diff (chunked or not). Beyond this, narrow manually.
const MAX_TOTAL_BYTES = 4_000_000;
// Bump when compiler.ts / imports.ts logic changes, to invalidate the cache.
const COMPILER_REV = "1";

interface MeatDetails {
	mode: string;
	ref?: string;
	path?: string;
	visibleChanged: number;
	totalChanged: number;
	totalLines: number;
	folds: number;
	markers: number;
	files: { kept: number; total: number };
	allElided: boolean;
	aborted: boolean;
	cached: boolean;
	chunks: number;
}

/** Payload for the inline `meat-reading-diff` chat entry (display-only; not in LLM context). */
interface MeatEntryData {
	summary: string;
	manifest: string;
	scope: string;
	abridged: string;
}

function findGitRoot(start: string): string | null {
	let dir = start;
	for (let i = 0; i < 64; i++) {
		if (existsSync(path.join(dir, ".git"))) return dir;
		const parent = path.dirname(dir);
		if (parent === dir) break;
		dir = parent;
	}
	return null;
}

/** Strip the leading diffstat block (and any commit message in show mode). */
function extractDiffBody(stdout: string): string {
	// Line-anchored: a commit message containing "diff --git" cannot trick us
	// into starting the body inside the message.
	const m = /^diff --git /m.exec(stdout);
	return m ? stdout.slice(m.index) : "";
}

export function sizeOk(text: string): boolean {
	const lines = text.replace(/\n$/, "").split("\n").length;
	return lines <= MAX_LINES && Buffer.byteLength(text, "utf8") <= MAX_BYTES;
}

/** Split a diff body into self-contained chunks at file, then hunk, boundaries. */
export function splitForChunking(diff: string): string[] {
	const lines = diff.split("\n");
	// Partition into file sections (each begins with "diff --git").
	const sections: string[][] = [];
	for (const line of lines) {
		if (line.startsWith("diff --git")) sections.push([line]);
		else (sections[sections.length - 1] ??= []).push(line);
	}
	const chunks: string[] = [];
	const flush = (piece: string[]) => {
		const t = piece.join("\n").replace(/\n$/, "");
		if (t) chunks.push(t);
	};

	for (const section of sections) {
		const text = section.join("\n");
		if (sizeOk(text)) {
			chunks.push(text.replace(/\n$/, ""));
			continue;
		}
		// Oversized file: keep its metadata prefix on every hunk-grouped piece.
		const firstHunk = section.findIndex((l) => l.startsWith("@@"));
		if (firstHunk <= 0) {
			// No hunk to split on (e.g. binary/rename only, or one giant hunk):
			// cannot split safely; emit whole and let it run (it may still fit).
			chunks.push(text.replace(/\n$/, ""));
			continue;
		}
		const meta = section.slice(0, firstHunk);
		const hunks: string[][] = [];
		for (let i = firstHunk; i < section.length; i++) {
			if (section[i]!.startsWith("@@")) hunks.push([section[i]!]);
			else (hunks[hunks.length - 1] ??= []).push(section[i]!);
		}
		let piece = [...meta];
		for (const hunk of hunks) {
			const candidate = [...piece, ...hunk].join("\n");
			if (!sizeOk(candidate) && piece.length > meta.length) {
				flush(piece);
				piece = [...meta];
			}
			piece.push(...hunk);
		}
		flush(piece);
	}
	return chunks;
}

/** Merge several per-chunk compile results into one reading diff. */
export function mergeResults(parts: CompileResult[]): CompileResult {
	const abridged = parts.map((p) => p.abridged).filter((a) => a !== "").join("\n");
	const summaries = [...new Set(parts.map((p) => p.summary).filter((s) => s.trim() !== ""))];
	return {
		abridged,
		summary: summaries.join("; ") || "(no summary)",
		visibleChanged: parts.reduce((a, p) => a + p.visibleChanged, 0),
		removedChanged: parts.reduce((a, p) => a + p.removedChanged, 0),
		foldedChanged: parts.reduce((a, p) => a + p.foldedChanged, 0),
		totalChanged: parts.reduce((a, p) => a + p.totalChanged, 0),
		totalLines: parts.reduce((a, p) => a + p.totalLines, 0),
		folds: parts.reduce((a, p) => a + p.folds, 0),
		markers: parts.reduce((a, p) => a + p.markers, 0),
		files: {
			kept: parts.reduce((a, p) => a + p.files.kept, 0),
			total: parts.reduce((a, p) => a + p.files.total, 0),
		},
		allElided: parts.every((p) => p.abridged === ""),
	};
}

function cacheDir(): string {
	const piDir = process.env.PI_CODING_AGENT_DIR || path.join(os.homedir(), ".pi", "agent");
	return path.join(piDir, "cache", "pi-show-me-the-meat");
}

function chunkCacheKey(modelId: string, chunk: string): string {
	return createHash("sha256").update(`${RUBRIC}\0${COMPILER_REV}\0${modelId}\0${chunk}`).digest("hex");
}

function isCompileResult(c: unknown): c is CompileResult {
	return (
		!!c &&
		typeof (c as CompileResult).abridged === "string" &&
		typeof (c as CompileResult).summary === "string" &&
		typeof (c as CompileResult).visibleChanged === "number" &&
		typeof (c as CompileResult).totalChanged === "number" &&
		typeof (c as CompileResult).totalLines === "number"
	);
}

function readCache(key: string): CompileResult | null {
	try {
		const raw = readFileSync(path.join(cacheDir(), `${key}.json`), "utf8");
		const c = JSON.parse(raw);
		return isCompileResult(c) ? c : null;
	} catch {
		return null;
	}
}

function writeCache(key: string, result: CompileResult): void {
	// Atomic: write a temp file then rename, so a concurrent run or a crash
	// mid-write cannot leave a truncated cache file.
	try {
		const dir = cacheDir();
		mkdirSync(dir, { recursive: true });
		const tmp = path.join(dir, `${key}.json.${process.pid}.tmp`);
		writeFileSync(tmp, JSON.stringify(result), "utf8");
		renameSync(tmp, path.join(dir, `${key}.json`));
	} catch {
		// Cache is a perf optimization; a write failure must never break the run.
	}
}

/** A code fence longer than the longest backtick run in the body. */
function fenceFor(body: string): string {
	let longest = 0;
	let run = 0;
	for (const ch of body) {
		if (ch === "`") {
			run++;
			if (run > longest) longest = run;
		} else run = 0;
	}
	return "`".repeat(Math.max(3, longest + 1));
}

async function abridge(
	diff: string,
	cwd: string,
	model: unknown,
	modelId: string,
	signal: AbortSignal | undefined,
): Promise<{ result: CompileResult; chunks: number; cached: boolean }> {
	const chunkTexts = sizeOk(diff) ? [diff] : splitForChunking(diff);
	if (chunkTexts.length > MAX_CHUNKS) {
		throw new Error(
			`diff is too large: ${chunkTexts.length} chunks after splitting (max ${MAX_CHUNKS}). Narrow it with the \`path\` parameter or a smaller range.`,
		);
	}
	const parts: CompileResult[] = [];
	let allCached = true;
	for (const chunk of chunkTexts) {
		const key = chunkCacheKey(modelId, chunk);
		const hit = readCache(key);
		if (hit) {
			parts.push(hit);
			continue;
		}
		allCached = false;
		const lines = chunk.replace(/\n$/, "").split("\n");
		const plan: Submission = await abridgeViaSubagent({
			cwd,
			rawDiff: chunk,
			numberedDiff: numberDiff(chunk),
			totalLines: lines.length,
			model: model as Model<any> | undefined,
			signal,
		});
		const compiled = compilePlan(chunk, plan);
		writeCache(key, compiled);
		parts.push(compiled);
	}
	const result = parts.length === 1 ? parts[0]! : mergeResults(parts);
	return { result, chunks: chunkTexts.length, cached: allCached };
}

export default function (pi: ExtensionAPI) {
	// Inline chat renderer: the reading diff is shown as its own entry in the
	// chat stream (not collapsed inside the tool block). Custom entries are
	// display-only and do NOT enter LLM context, so the tool's `content` (which
	// the model reads) is the single source of truth; this is pure user display.
	pi.registerEntryRenderer<MeatEntryData>("meat-reading-diff", (entry, _opts, theme) => {
		const d = entry.data;
		if (!d) return undefined;
		// Render as a distinct background panel (a "card"), the same technique Pi
		// uses for user messages and tool blocks, so this reads as a meat-generated
		// artifact rather than model streaming prose.
		const panel = new Box(1, 0, (t: string) => theme.bg("customMessageBg", t));
		panel.addChild(
			new Text(
				theme.fg("accent", "\u258c") +
					" " +
					theme.fg("customMessageLabel", theme.bold("MEAT")) +
					theme.fg("dim", "  reading diff") +
					theme.fg("muted", `  \u00b7 ${d.scope}`),
				0,
				0,
			),
		);
		panel.addChild(new Text(theme.fg("toolTitle", d.summary || "(no summary)"), 0, 0));
		panel.addChild(new Text(theme.fg("success", d.manifest), 0, 0));
		panel.addChild(new Text("", 0, 0));
		const body = d.abridged
			.split("\n")
			.map((ln) => {
				if (ln.startsWith("+") && !ln.startsWith("+++")) return theme.fg("toolDiffAdded", ln);
				if (ln.startsWith("-") && !ln.startsWith("---")) return theme.fg("toolDiffRemoved", ln);
				if (ln.startsWith("@@")) return theme.fg("accent", ln);
				if (
					ln.startsWith("diff ") ||
					ln.startsWith("index ") ||
					ln.startsWith("---") ||
					ln.startsWith("+++")
				)
					return theme.fg("muted", ln);
				if (ln.startsWith("\u22ef")) return theme.fg("dim", ln);
				return theme.fg("toolDiffContext", ln);
			})
			.join("\n");
		panel.addChild(new Text(body, 0, 0));
		return panel;
	});

	pi.registerTool({
		name: "meat",
		label: "Meat",
		description:
			"Reduce a git diff to the lines that carry the change (the meat) by spawning an isolated " +
			"sub-agent that selects what to remove, fold, or elide, then a compiler projects the rest verbatim. " +
			"Reads staged, unstaged, commit, range, or all-vs-HEAD diffs in any language. Imports are removed " +
			"automatically. Use whenever the user wants to read 'the meat', 'just the important parts', or an " +
			"abridged summary of a change.",
		promptSnippet: "Abridge a git diff to its important lines",
		promptGuidelines: [
			"Use meat when the user asks for 'the meat', 'just the important parts', an abridged/condensed diff, or to quickly grasp a change.",
			"meat runs an isolated sub-agent so the full diff does not pollute this context; it returns only the abridged reading diff.",
			"It works on any language and any provider (uses the configured model). Imports are stripped automatically.",
			"Pass mode (working/staged/commit/range/all), ref for commit/range, and optional path to narrow scope.",
			"Present the returned summary, the elision manifest, and the abridged diff to the user.",
		],
		parameters: Type.Object({
			mode: StringEnum(["working", "staged", "commit", "range", "all"] as const, {
				description: "working=unstaged, staged=cached, commit=specific SHA, range=two refs, all=HEAD diff",
			}),
			ref: Type.Optional(
				Type.String({ description: "Commit SHA, branch, or range (e.g. main..HEAD). Required for commit/range; ignored otherwise." }),
			),
			path: Type.Optional(
				Type.String({ description: "Limit to file or directory inside the repo (e.g. internal/auth). Git runs from this path, so it can point into a nested repo." }),
			),
		}),
		async execute(_toolCallId, params, signal, _onUpdate, ctx) {
			const { mode, ref, path: filePath } = params;
			const prefix = GIT_PREFIX[mode];
			if (!prefix) throw new Error(`unknown mode: ${mode}`);

			// ref is only meaningful for commit/range; honoring it elsewhere would
			// silently turn working/staged/all into a range diff.
			if (ref && mode !== "commit" && mode !== "range") {
				throw new Error(`ref is only valid for commit and range modes (got mode=${mode})`);
			}
			if ((mode === "commit" || mode === "range") && !ref) {
				throw new Error(`ref required for ${mode} mode`);
			}
			// ref is model-controlled input placed before `--`, so a leading dash would
			// be parsed by git as an option (option injection). Valid refs never start with '-'.
			if (ref && ref.startsWith("-")) {
				throw new Error("ref must not start with '-'");
			}

			const repoRoot = findGitRoot(process.cwd());
			let gitCwd = process.cwd();
			let pathspec = ".";
			if (filePath) {
				const resolved = path.resolve(gitCwd, filePath);
				// Confine the sub-agent's working directory to the repo root: an
				// absolute path or `../..` cannot escape it.
				if (repoRoot && !resolved.startsWith(repoRoot + path.sep) && resolved !== repoRoot) {
					throw new Error("path escapes the repository root");
				}
				try {
					if (statSync(resolved).isDirectory()) {
						gitCwd = resolved;
						pathspec = ".";
					} else {
						gitCwd = path.dirname(resolved);
						pathspec = path.basename(resolved);
					}
				} catch (err) {
					if ((err as NodeJS.ErrnoException).code !== "ENOENT") throw err;
					const root = findGitRoot(path.dirname(resolved));
					if (root) {
						gitCwd = root;
						pathspec = path.relative(root, resolved).replace(/\\/g, "/");
					} else {
						pathspec = filePath;
					}
				}
			}
			// Force the built-in differ so a diff in an unfamiliar repo cannot invoke a
			// configured external diff driver or textconv (i.e. an arbitrary command).
			// NOTE: `-c diff.external=` (empty) does NOT disable it — it installs an
			// empty driver git then tries to exec ("cannot run : No such file or
			// directory"), which breaks `git diff` (working/staged/all/range) on a
			// dirty tree. `--no-ext-diff` / `--no-textconv` are the correct switches.
			const gitArgs = [...prefix, "--no-ext-diff", "--no-textconv", ...(ref ? [ref] : []), "--", pathspec];

			const result = await pi.exec("git", gitArgs, { cwd: gitCwd, signal, timeout: 30_000 });
			if (result.code !== 0) {
				const hint = /not a git repository/i.test(result.stderr)
					? " — the working directory is not inside a git repo; pass `path` pointing into the repo."
					: "";
				throw new Error(`git failed (${result.code}): ${result.stderr}${hint}`);
			}

			const base = { mode, ref, path: filePath };
			if (!result.stdout.trim()) {
				return noChange(base);
			}

			const diff = extractDiffBody(result.stdout);
			if (!diff) {
				return {
					content: [
						{
							type: "text" as const,
							text: "No readable diff body (the change may be binary-only, or a commit with no text diff).",
						},
					],
					details: emptyDetails(base, 0) satisfies MeatDetails,
				};
			}
			// Combined/merge diffs break the line model. -m --first-parent normally
			// prevents them in commit mode; this is the safety net for anything else.
			if (/^(diff --cc|diff --combined)/m.test(diff) || /^@@@/m.test(diff)) {
				return {
					content: [
						{
							type: "text" as const,
							text: "Combined/merge diffs are not supported (the line model breaks on them). Review a non-merge commit, or a two-parent range like A..B.",
						},
					],
					details: emptyDetails(base, diff.replace(/\n$/, "").split("\n").length) satisfies MeatDetails,
				};
			}

			if (Buffer.byteLength(diff, "utf8") > MAX_TOTAL_BYTES) {
				return {
					content: [
						{
							type: "text" as const,
							text: `Diff is too large (${Buffer.byteLength(diff, "utf8")} bytes). Narrow it with the \`path\` parameter (a file or directory), or review a smaller commit/range.`,
						},
					],
					details: emptyDetails(base, diff.replace(/\n$/, "").split("\n").length) satisfies MeatDetails,
				};
			}

			const modelId = (ctx.model as { id?: string } | undefined)?.id ?? "default";

			let compiled: CompileResult;
			let chunks = 1;
			let cached = false;
			try {
				const out = await abridge(diff, gitCwd, ctx.model, modelId, signal);
				compiled = out.result;
				chunks = out.chunks;
				cached = out.cached;
			} catch (err) {
				const msg = err instanceof Error ? err.message : String(err);
				if (signal?.aborted) {
					return {
						content: [{ type: "text" as const, text: `meat was cancelled. ${msg}` }],
						details: { ...emptyDetails(base, 0), aborted: true } satisfies MeatDetails,
					};
				}
				throw err;
			}

			// Surface the reading diff INLINE in the chat as a display-only entry, so
		// the user sees it without expanding the collapsed tool block.
		pi.appendEntry<MeatEntryData>("meat-reading-diff", {
			summary: compiled.summary || "(no summary)",
			manifest: manifestLine(compiled),
			scope: `${base.mode}${base.ref ? " " + base.ref : ""}${base.path ? ` (${base.path})` : ""}${cached ? " · cached" : ""}${chunks > 1 ? ` · ${chunks} chunks` : ""}`,
			abridged: compiled.allElided ? "(the sub-agent judged every line to be churn — nothing kept)" : compiled.abridged,
		});

		return render(base, compiled, cached, chunks);
		},
		renderCall(args, theme, _ctx) {
			const modeColors: Record<string, ThemeColor> = {
				working: "warning",
				staged: "accent",
				commit: "success",
				range: "success",
				all: "warning",
			};
			let label = theme.fg("toolTitle", theme.bold("meat "));
			label += theme.fg(modeColors[args.mode] ?? "accent", args.mode);
			if (args.ref) label += theme.fg("muted", " " + args.ref);
			if (args.path) label += theme.fg("dim", " — " + args.path);
			label += theme.fg("dim", "  (reading diff)");
			return new Text(label, 0, 0);
		},
		renderResult(result, { isPartial }, theme, _ctx) {
			if (isPartial) return new Text(theme.fg("warning", "Abridging diff in sub-agent..."), 0, 0);
			const details = result.details as MeatDetails | undefined;
			if (!details) return new Text(theme.fg("dim", "meat"), 0, 0);
			if (details.aborted) return new Text(theme.fg("warning", "meat cancelled"), 0, 0);
			if (details.totalChanged === 0) return new Text(theme.fg("dim", "meat · no changes"), 0, 0);

			const pct = details.totalChanged > 0 ? Math.round((details.visibleChanged / details.totalChanged) * 100) : 0;
			let summary = theme.fg("accent", "meat");
			summary += theme.fg("dim", " · kept ") + theme.fg("success", String(details.visibleChanged));
			summary += theme.fg("dim", "/") + theme.fg("muted", String(details.totalChanged));
			summary += theme.fg("dim", " changed (") + theme.fg("muted", pct + "%");
			summary += theme.fg("dim", ") · ") + theme.fg("dim", details.markers + " gap" + (details.markers === 1 ? "" : "s"));
			if (details.folds > 0) summary += theme.fg("dim", " · " + details.folds + " fold" + (details.folds === 1 ? "" : "s"));
			if (details.chunks > 1) summary += theme.fg("dim", " · " + details.chunks + " chunks");
			if (details.cached) summary += theme.fg("success", " · cached");
			if (details.allElided) summary += theme.fg("warning", " · all elided");
			return new Text(summary, 0, 0);
		},
	});

	// /meat — direct invocation. Defaults to uncommitted changes, falling back to
	// the most recent commit; pass a revision to review a specific commit. Panel-only:
	// renders the branded inline entry and does NOT enter the agent loop. Mirrors the
	// tool pipeline via shared helpers (no `path` argument, so it skips path resolution).
	pi.registerCommand("meat", {
		description:
			"Abridge the current diff to its important lines (the meat). No args: uncommitted changes, or the most recent commit if there are none. Pass a revision (e.g. HEAD, HEAD~1, a sha) to review that commit.",
		getArgumentCompletions(prefix: string) {
			const cands = ["HEAD", "HEAD~1"];
			const hits = cands.filter((c) => c.startsWith(prefix));
			return hits.length ? hits.map((value) => ({ value, label: value })) : null;
		},
		async handler(args, ctx) {
			const rev = args.trim().split(/\s+/).filter(Boolean)[0];
			const modelId = (ctx.model as { id?: string } | undefined)?.id ?? "default";

			const abridgeOne = async (mode: "all" | "commit", ref?: string): Promise<{ empty: boolean }> => {
				const prefix = GIT_PREFIX[mode]!;
				const gitArgs = [...prefix, "--no-ext-diff", "--no-textconv", ...(ref ? [ref] : []), "--", "."];
				const result = await pi.exec("git", gitArgs, { cwd: process.cwd(), signal: ctx.signal, timeout: 30_000 });
				if (result.code !== 0) {
					throw new Error(
						/not a git repository/i.test(result.stderr)
							? "not a git repository"
							: `git failed (${result.code}): ${result.stderr}`,
					);
				}
				if (!result.stdout.trim()) return { empty: true };
				const diff = extractDiffBody(result.stdout);
				if (!diff) {
					ctx.ui.notify("meat: no readable diff body (binary-only, or a commit with no text diff).", "warning");
					return { empty: true };
				}
				if (/^(diff --cc|diff --combined)/m.test(diff) || /^@@@/m.test(diff)) {
					ctx.ui.notify("meat: combined/merge diffs are not supported.", "warning");
					return { empty: true };
				}
				if (Buffer.byteLength(diff, "utf8") > MAX_TOTAL_BYTES) {
					ctx.ui.notify("meat: diff too large; review a smaller scope.", "warning");
					return { empty: true };
				}
				const out = await abridge(diff, process.cwd(), ctx.model, modelId, ctx.signal);
				pi.appendEntry<MeatEntryData>("meat-reading-diff", {
					summary: out.result.summary || "(no summary)",
					manifest: manifestLine(out.result),
					scope: `${mode}${ref ? " " + ref : ""}${out.cached ? " · cached" : ""}${out.chunks > 1 ? ` · ${out.chunks} chunks` : ""}`,
					abridged: out.result.allElided ? "(the sub-agent judged every line to be churn — nothing kept)" : out.result.abridged,
				});
				return { empty: false };
			};

			ctx.ui.setStatus("meat", "\uD83E\uDD69 meat: cooking\u2026");
			try {
				ctx.ui.setWidget("meat-cooking", ["\uD83E\uDD69 Meat is cooking\u2026 (watch the status bar for progress)"], { placement: "aboveEditor" });
				if (rev) {
					await abridgeOne("commit", rev);
				} else {
					// Default: uncommitted changes; fall back to the most recent commit.
					const first = await abridgeOne("all");
					if (first.empty) await abridgeOne("commit", "HEAD");
				}
			} catch (err) {
				const msg = err instanceof Error ? err.message : String(err);
				ctx.ui.notify(
					/^not a git repository/i.test(msg) ? "meat: not inside a git repository." : `meat: ${msg}`,
					"error",
				);
			} finally {
				ctx.ui.setWidget("meat-cooking", undefined);
				ctx.ui.setStatus("meat", undefined);
			}
		},
	});
}

function noChange(base: { mode: string; ref?: string; path?: string }) {
	return {
		content: [{ type: "text" as const, text: "No changes found. Try: staged, working, all, commit, or range." }],
		details: {
			...base,
			visibleChanged: 0,
			totalChanged: 0,
			totalLines: 0,
			folds: 0,
			markers: 0,
			files: { kept: 0, total: 0 },
			allElided: false,
			aborted: false,
			cached: false,
			chunks: 1,
		} satisfies MeatDetails,
	};
}

function emptyDetails(base: { mode: string; ref?: string; path?: string }, totalLines: number): MeatDetails {
	return {
		...base,
		visibleChanged: 0,
		totalChanged: 0,
		totalLines,
		folds: 0,
		markers: 0,
		files: { kept: 0, total: 0 },
		allElided: false,
		aborted: false,
		cached: false,
		chunks: 1,
	};
}

function render(
	base: { mode: string; ref?: string; path?: string },
	compiled: CompileResult,
	cached: boolean,
	chunks: number,
) {
	const fence = fenceFor(compiled.abridged);
	const body = compiled.allElided
		? "(the sub-agent judged every line to be churn — nothing kept)"
		: `${fence}diff\n${compiled.abridged}\n${fence}`;

	const text = [
		`## ${compiled.summary || "(no summary)"}`,
		"",
		`**${manifestLine(compiled)}** · ${base.mode}${base.ref ? " " + base.ref : ""}${base.path ? ` (${base.path})` : ""}${cached ? " · cached" : ""}${chunks > 1 ? ` · ${chunks} chunks` : ""}`,
		"",
		body,
	].join("\n");

	return {
		content: [{ type: "text" as const, text }],
		details: {
			...base,
			visibleChanged: compiled.visibleChanged,
			totalChanged: compiled.totalChanged,
			totalLines: compiled.totalLines,
			folds: compiled.folds,
			markers: compiled.markers,
			files: compiled.files,
			allElided: compiled.allElided,
			aborted: false,
			cached,
			chunks,
		} satisfies MeatDetails,
	};
}
