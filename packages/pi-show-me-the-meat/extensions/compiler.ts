/**
 * pi-show-me-the-meat — the deterministic compiler.
 *
 * Turns a model-submitted edit plan into a reading diff. The model never authors
 * output text: it submits remove / replace / fold operations in original
 * 1-based line coordinates, and this compiler validates the plan and renders it
 * mechanically. KEEP is implicit — every line not removed or folded is emitted
 * verbatim. A FOLD range becomes one compiler-generated `marker + indent + "..."`
 * row. A REPLACE is a single-line elision whose `new` must be a deletion-only
 * projection of `old` (validated). Imports are removed mechanically before the
 * model plan is applied.
 *
 * Ported from meat (https://github.com/boldsoftware/meat) meat/editplan.go,
 * with these deliberate simplifications (documented):
 *   - No Python suite / delimiter / triple-quote validators. A fold may therefore
 *     collapse a Python suite header in a rare pathological case.
 *   - No move detection or move-symmetry enforcement.
 *   - `validateRetainedStructure` is replaced by a forgiving rule: a source line
 *     that survives keeps its enclosing file header and hunk header automatically
 *     (auto-fix instead of error).
 *   - Mandatory-import removals vanish SILENTLY (no elision marker); only
 *     model-chosen removals get a `⋯⋯ N lines elided ⋯⋯` marker.
 */
import { analyzeDiff, isHunkSource, type AnalyzedDiff } from "./diff.js";
import { mandatoryImportMask } from "./imports.js";

const MAX_REPLACEMENT_BYTES = 4 << 10; // 4 KiB
const MAX_SUMMARY_BYTES = 500;

const MARKER_OPEN = "\u22ef\u22ef "; // ⋯⋯
const MARKER_CLOSE = " \u22ef\u22ef"; // ⋯⋯

/** Inclusive 1-based line range into the original diff. */
export interface LineRange {
	start: number;
	end: number;
}

/** A single-line elision: `new` must be a deletion-only projection of `old`. */
export interface LineReplacement {
	line: number;
	old: string;
	new: string;
}

/** A range of ≥2 same-polarity hunk source lines to collapse into one `...` row. */
export interface LineFold {
	start: number;
	end: number;
}

export interface EditPlan {
	remove: LineRange[];
	replace: LineReplacement[];
	fold: LineFold[];
}

export interface Submission extends EditPlan {
	summary: string;
}

interface PlannedFold {
	start: number; // 1-based inclusive
	end: number; // 1-based inclusive
	marker: string; // "+", "-", or " "
	indent: string;
}

interface PlannedReplacement {
	start: number; // offset into the line body (after the diff marker)
	end: number;
	newText: string;
}

export interface CompileResult {
	abridged: string;
	summary: string;
	/** Visible changed lines, counting each fold row as one. The "kept" count. */
	visibleChanged: number;
	removedChanged: number;
	foldedChanged: number;
	totalChanged: number;
	totalLines: number;
	folds: number;
	markers: number;
	files: { kept: number; total: number };
	allElided: boolean;
}

/** Number every line with a 1-indexed `N|` gutter (display-only coordinate space). */
export function numberDiff(rawDiff: string): string {
	const lines = rawDiff.replace(/\n$/, "").split("\n");
	const width = String(lines.length).length;
	return lines.map((l, i) => `${String(i + 1).padStart(width, " ")}|${l}`).join("\n");
}

function escapeRegExp(s: string): string {
	return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * Project a deletion-only elision: parse `new` into literal and wildcard spans
 * (a run of exactly three '.' or a single '…' is a wildcard; any other '.' run is
 * a literal), then rebuild the output from VERBATIM SLICES OF `old` joined by a
 * fixed "..." sentinel. The model's `new` text is never spliced into the output;
 * it only determines where the elisions are. Returns null if `new` is not a
 * deletion-only projection of `old` (no wildcard, adjacent wildcards, or a
 * literal that does not appear in `old` in order).
 */
function projectElision(old: string, newText: string): string | null {
	const runes = Array.from(newText);
	type Seg = { lit: string } | { wild: true };
	const segs: Seg[] = [];
	let wildcards = 0;
	let prevWild = false;
	let i = 0;
	while (i < runes.length) {
		if (runes[i] === "\u2026") {
			if (prevWild) return null;
			segs.push({ wild: true });
			wildcards++;
			prevWild = true;
			i++;
		} else if (runes[i] === ".") {
			let j = i;
			while (j < runes.length && runes[j] === ".") j++;
			const run = j - i;
			if (run === 3) {
				if (prevWild) return null;
				segs.push({ wild: true });
				wildcards++;
				prevWild = true;
			} else {
				segs.push({ lit: ".".repeat(run) });
				prevWild = false;
			}
			i = j;
		} else {
			let lit = "";
			while (i < runes.length && runes[i] !== "\u2026" && runes[i] !== ".") {
				lit += runes[i]!;
				i++;
			}
			segs.push({ lit });
			prevWild = false;
		}
	}
	if (wildcards === 0) return null; // new must elide something

	let pattern = "^";
	for (const s of segs) pattern += "wild" in s ? "(.+)" : `(${escapeRegExp(s.lit)})`;
	pattern += "$";
	let re: RegExp;
	try {
		re = new RegExp(pattern, "s");
	} catch {
		return null;
	}
	const m = re.exec(old);
	if (!m) return null;
	// Rebuild from old's captured literal slices (m[k+1]) and fixed "..." sentinels.
	let out = "";
	for (let k = 0; k < segs.length; k++) out += "wild" in segs[k]! ? "..." : (m[k + 1] ?? "");
	return out;
}

/** Find the unique occurrence of `sub` in `text`; ambiguity (0 or 2+) fails. */
function uniqueSubstringIndex(text: string, sub: string): { index: number; unique: boolean } {
	const first = text.indexOf(sub);
	if (first < 0) return { index: 0, unique: false };
	// Search one char after the first start so overlapping matches ("aa" in "aaa") count as ambiguous.
	if (text.indexOf(sub, first + 1) >= 0) return { index: 0, unique: false };
	return { index: first, unique: true };
}

function validateSummary(summary: string): string[] {
	const problems: string[] = [];
	if (summary.trim() === "") problems.push("summary must not be empty");
	else if (Buffer.byteLength(summary, "utf8") > MAX_SUMMARY_BYTES)
		problems.push(`summary is over the ${MAX_SUMMARY_BYTES}-byte limit`);
	for (const r of summary) {
		if (r === "\n" || r === "\r" || r === "\0" || r === "\x1b" || r === "\u2028" || r === "\u2029") {
			problems.push("summary must be a single printable line");
			break;
		}
		if (r !== "\t" && /[\x00-\x1f\x7f]/.test(r)) {
			problems.push("summary contains a control character");
			break;
		}
	}
	return problems;
}

function validateSingleLine(name: string, text: string): string[] {
	const problems: string[] = [];
	if (Buffer.byteLength(text, "utf8") > MAX_REPLACEMENT_BYTES)
		problems.push(`${name} is over the ${MAX_REPLACEMENT_BYTES}-byte limit`);
	for (const r of text) {
		if (r === "\n" || r === "\r" || r === "\0" || r === "\x1b" || r === "\u2028" || r === "\u2029") {
			problems.push(`${name} must be a single printable line`);
			break;
		}
	}
	return problems;
}

function leadingWhitespace(s: string): string {
	const m = s.match(/^[ \t]*/);
	return m ? (m[0] ?? "") : "";
}

function commonPrefix(a: string, b: string): string {
	const n = Math.min(a.length, b.length);
	let i = 0;
	while (i < n && a[i] === b[i]) i++;
	return a.slice(0, i);
}

/** Validate and describe a fold range. Mirrors meat's prepareFold (minus Python guards). */
function prepareFold(a: AnalyzedDiff, fold: LineFold, index: number): PlannedFold | string {
	const { start, end } = fold;
	if (!Number.isInteger(start) || !Number.isInteger(end) || start >= end) {
		return `fold[${index}]: want at least two lines in an inclusive range, got ${start}-${end}`;
	}
	const n = a.lines.length;
	if (end > n) return `fold[${index}]: line ${end} is past end of diff (${n} lines)`;

	let marker = "";
	let indent = "";
	let haveIndent = false;
	for (let line = start; line <= end; line++) {
		const idx = line - 1;
		if (!isHunkSource(a.kinds[idx]!) || a.lines[idx]!.length === 0) {
			return `fold[${index}]: line ${line} is not source inside one diff hunk`;
		}
		const lineMarker = a.lines[idx]!.charAt(0);
		if (marker === "") marker = lineMarker;
		else if (marker !== lineMarker)
			return `fold[${index}]: mixed diff markers in range ${start}-${end}`;
		const body = a.lines[idx]!.slice(1);
		if (body.trim() === "") continue;
		const lineIndent = leadingWhitespace(body);
		indent = haveIndent ? commonPrefix(indent, lineIndent) : lineIndent;
		haveIndent = true;
	}
	if (!haveIndent) return `fold[${index}]: range ${start}-${end} contains only blank source lines`;
	return { start, end, marker, indent };
}

/**
 * Compile a submission into a reading diff. Throws on any invalid plan
 * (malformed ranges, non-projection replacements, overlapping folds) rather
 * than silently producing a misleading diff.
 */
export function compilePlan(rawDiff: string, sub: Submission): CompileResult {
	const a = analyzeDiff(rawDiff);
	const n = a.lines.length;
	const importHidden = mandatoryImportMask(a);
	const hidden = importHidden.slice(); // union mask; folds and removes add to this
	const modelRemoved = new Array<boolean>(n).fill(false); // set only by model REMOVE (not imports)
	const foldedAt = new Array<number>(n).fill(-1); // fold index at a fold's start line
	const isFolded = new Array<boolean>(n).fill(false); // any line inside a fold
	const folds: PlannedFold[] = [];
	const problems: string[] = [];

	problems.push(...validateSummary(sub.summary));

	// 1. REMOVE
	for (const [i, r] of sub.remove.entries()) {
		if (!Number.isInteger(r.start) || !Number.isInteger(r.end)) {
			problems.push(`remove[${i}]: invalid inclusive range ${r.start}-${r.end}`);
			continue;
		}
		if (r.start < 1 || r.end < 1 || r.start > r.end) {
			problems.push(`remove[${i}]: invalid inclusive range ${r.start}-${r.end}`);
			continue;
		}
		if (r.end > n) {
			problems.push(`remove[${i}]: line ${r.end} is past end of diff (${n} lines)`);
			continue;
		}
		for (let line = r.start; line <= r.end; line++) {
			if (importHidden[line - 1]) continue; // mechanically handled; naming it is a no-op
			if (modelRemoved[line - 1]) {
				problems.push(`remove[${i}]: overlaps an earlier range at line ${line}`);
				break;
			}
			modelRemoved[line - 1] = true;
			hidden[line - 1] = true;
		}
	}

	// 2. FOLD
	for (const [i, fold] of sub.fold.entries()) {
		const res = prepareFold(a, fold, i);
		if (typeof res === "string") {
			problems.push(res);
			continue;
		}
		const f = res;
		// A fold fully inside mandatory-import rows is redundant: import removal wins.
		let mandatoryCount = 0;
		for (let line = f.start; line <= f.end; line++) {
			if (importHidden[line - 1]) mandatoryCount++;
		}
		if (mandatoryCount > 0) {
			if (mandatoryCount !== f.end - f.start + 1) {
				problems.push(
					`fold[${i}]: crosses automatically removed import rows and behavioral rows in range ${f.start}-${f.end}; fold only the behavioral rows`,
				);
			}
			continue; // import-only fold: nothing emitted
		}
		// Reject overlap with an already-hidden (removed/folded) line.
		let conflict = 0;
		for (let line = f.start; line <= f.end; line++) {
			if (hidden[line - 1]) {
				conflict = line;
				break;
			}
		}
		if (conflict > 0) {
			const kind = isFolded[conflict - 1] ? "fold" : "remove";
			problems.push(`fold[${i}]: overlaps ${kind} at line ${conflict}`);
			continue;
		}
		const foldIndex = folds.length;
		folds.push(f);
		foldedAt[f.start - 1] = foldIndex;
		for (let line = f.start; line <= f.end; line++) {
			hidden[line - 1] = true;
			isFolded[line - 1] = true;
		}
	}

	// 3. REPLACE
	const replacementsByLine = new Map<number, PlannedReplacement[]>();
	for (const [i, r] of sub.replace.entries()) {
		if (!Number.isInteger(r.line) || r.line < 1 || r.line > n) {
			problems.push(`replace[${i}]: line ${r.line} is outside the diff (1-${n})`);
			continue;
		}
		if (importHidden[r.line - 1]) continue; // redundant on hidden import scaffolding
		if (hidden[r.line - 1]) {
			const stateName = isFolded[r.line - 1] ? "folded" : "removed";
			problems.push(`replace[${i}]: line ${r.line} is also ${stateName}`);
			continue;
		}
		if (r.old === "") {
			problems.push(`replace[${i}]: old must not be empty`);
			continue;
		}
		problems.push(...validateSingleLine(`replace[${i}]: old`, r.old).map((p) => `replace[${i}]: ${p}`));
		problems.push(...validateSingleLine(`replace[${i}]: new`, r.new).map((p) => `replace[${i}]: ${p}`));
		if (r.new === r.old) {
			problems.push(`replace[${i}]: new must elide some part of old`);
			continue;
		}
		const projected = projectElision(r.old, r.new);
		if (projected === null) {
			problems.push(
				`replace[${i}]: new must match all of old, with every omitted span represented by ... or …`,
			);
			continue;
		}
		if (!isHunkSource(a.kinds[r.line - 1]!)) {
			problems.push(`replace[${i}]: line ${r.line} is not a source line inside a diff hunk`);
			continue;
		}
		const body = a.lines[r.line - 1]!.slice(1);
		const { index, unique } = uniqueSubstringIndex(body, r.old);
		if (!unique) {
			problems.push(`replace[${i}]: old must occur exactly once after the diff marker on line ${r.line}`);
			continue;
		}
		const list = replacementsByLine.get(r.line) ?? [];
		list.push({ start: index, end: index + r.old.length, newText: projected });
		replacementsByLine.set(r.line, list);
	}
	// Detect overlapping replacement spans on the same line.
	for (const [lineNo, edits] of replacementsByLine) {
		edits.sort((x, y) => x.start - y.start);
		for (let k = 1; k < edits.length; k++) {
			if (edits[k]!.start < edits[k - 1]!.end) {
				problems.push(`replace: spans overlap on line ${lineNo}`);
			}
		}
	}

	if (problems.length > 0) {
		throw new Error(
			problems.length === 1 ? problems[0] : `edit plan has ${problems.length} errors:\n- ${problems.join("\n- ")}`,
		);
	}

	// Structural restore: a visible source line keeps its enclosing file and
	// hunk headers. If the model removed a header but kept body lines, the header
	// is restored so the reading diff never shows an orphaned hunk or attributes
	// a change to the wrong file. Import-only files have no visible source, so
	// their mechanically-hidden metadata is untouched.
	{
		let metaIdx: number[] = [];
		let hunkHeaderIdx = -1;
		for (let k = 0; k < n; k++) {
			const kind = a.kinds[k];
			if (kind === "header") {
				metaIdx = [k];
				hunkHeaderIdx = -1;
			} else if (
				kind === "index" ||
				kind === "oldFile" ||
				kind === "newFile" ||
				kind === "renameFrom" ||
				kind === "renameTo" ||
				kind === "copyFrom" ||
				kind === "copyTo"
			) {
				metaIdx.push(k);
			} else if (kind === "hunkHeader") {
				hunkHeaderIdx = k;
			} else if (isHunkSource(kind!) && !hidden[k]) {
				for (const m of metaIdx) hidden[m] = false;
				if (hunkHeaderIdx >= 0) hidden[hunkHeaderIdx] = false;
			}
		}
	}

	// 4. RENDER
	const out: string[] = [];
	let markers = 0;
	let i = 0;
	while (i < n) {
		const fi = foldedAt[i]!;
		if (fi >= 0) {
			const f = folds[fi]!;
			out.push(`${f.marker}${f.indent}...`);
			i = f.end; // end is 1-based inclusive; next index is f.end
			continue;
		}
		if (hidden[i]) {
			// Mandatory-import removals vanish silently; only contiguous runs of
			// model-chosen removals earn a marker, and the count excludes imports.
			while (i < n && hidden[i] && foldedAt[i]! < 0 && !isFolded[i]) {
				if (importHidden[i]) {
					i++;
					continue;
				}
				const subStart = i;
				while (i < n && hidden[i] && foldedAt[i]! < 0 && !isFolded[i] && !importHidden[i]) i++;
				const count = i - subStart;
				out.push(`${MARKER_OPEN}${count} line${count === 1 ? "" : "s"} elided${MARKER_CLOSE}`);
				markers++;
			}
			continue;
		}
		let text = a.lines[i]!;
		const edits = replacementsByLine.get(i + 1);
		if (edits && edits.length) {
			text = text[0]! + applyReplacements(text.slice(1), edits);
		}
		out.push(text);
		i++;
	}

	// 5. STATS
	let visibleChanged = 0;
	let removedChanged = 0;
	let foldedChanged = 0;
	let totalChanged = 0;
	for (let k = 0; k < n; k++) {
		if (a.kinds[k] !== "hunkChange") continue;
		totalChanged++;
		if (isFolded[k]) foldedChanged++;
		else if (hidden[k]) removedChanged++;
		else visibleChanged++;
	}
	// Each fold row that represents a +/- change counts as one visible changed line.
	for (const f of folds) {
		if (f.marker === "+" || f.marker === "-") visibleChanged++;
	}

	let totalFiles = 0;
	const represented = (k: number): boolean => !hidden[k] || !!isFolded[k];
	// A file is "kept" if any of its source/headers is represented.
	const fileSections: { start: number; end: number }[] = [];
	for (let k = 0; k < n; k++) {
		if (a.kinds[k] !== "header") continue;
		let end = n;
		for (let j = k + 1; j < n; j++) {
			if (a.kinds[j] === "header") {
				end = j;
				break;
			}
		}
		fileSections.push({ start: k, end });
	}
	let keptFiles = 0;
	for (const sec of fileSections) {
		totalFiles++;
		let any = false;
		for (let k = sec.start; k < sec.end; k++) {
			if (a.kinds[k] === "hunkChange" && represented(k)) {
				any = true;
				break;
			}
		}
		if (any) keptFiles++;
	}

	const abridged = out.join("\n");
	const allElided = abridged === "";

	return {
		abridged,
		summary: sub.summary.trim(),
		visibleChanged,
		removedChanged,
		foldedChanged,
		totalChanged,
		totalLines: n,
		folds: folds.length,
		markers,
		files: { kept: keptFiles, total: totalFiles },
		allElided,
	};
}

function applyReplacements(body: string, edits: PlannedReplacement[]): string {
	// Apply right-to-left so earlier offsets stay valid.
	const sorted = [...edits].sort((x, y) => x.start - y.start);
	let out = body;
	for (let k = sorted.length - 1; k >= 0; k--) {
		const e = sorted[k]!;
		out = out.slice(0, e.start) + e.newText + out.slice(e.end);
	}
	return out;
}

/** Human-readable manifest line, meat-style: "kept 12/240 changed lines". */
export function manifestLine(r: CompileResult): string {
	const noun = (c: number) => (c === 1 ? "changed line" : "changed lines");
	if (r.allElided) return `elided all ${r.totalChanged} ${noun(r.totalChanged)}`;
	let s = `kept ${r.visibleChanged}/${r.totalChanged} ${noun(r.totalChanged)}`;
	if (r.files.total > 1) s += ` in ${r.files.kept}/${r.files.total} files`;
	return s;
}
