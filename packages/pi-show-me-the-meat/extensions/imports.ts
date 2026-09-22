/**
 * pi-show-me-the-meat — mandatory import removal.
 *
 * The compiler-owned half of every edit plan: a per-language, mechanical
 * classifier that marks import / module / include statements for removal before
 * the model ever sees the diff. The model is told not to spend coordinates on
 * imports; this pass guarantees it regardless of model behavior.
 *
 * Ported from meat (https://github.com/boldsoftware/meat) meat/imports.go.
 * v1 scope: single-line imports for all six languages plus multiline forms
 * (Go import blocks, Python `from x import (...)` and backslash continuations,
 * JS/TS multiline import + require destructuring, Rust braced `use`, C/C++
 * backslash-continued includes). DEFERRED from meat (documented gaps):
 *   - import rows embedded inside multiline string literals (embeddedSourceLines)
 *   - Python try:/if:/with: import-guard suites (expandPythonImportOnlySuites)
 *   - blank-row framing fill between import groups (fillImportGroupGaps)
 *   - Go/Java `package` row as import-only framing (isImportOnlyFramingRow)
 * The simplified framing pass still drops an import-only hunk's header and an
 * import-only file's metadata, which covers the common case.
 */
import type { AnalyzedDiff, Language } from "./diff.js";

// --- per-language matchers (RE2-compatible; ported verbatim from imports.go) -
const goImportBlockStartRE = /^import\s*\(\s*(?:\/\/.*)?$/;
const goImportBlockEndRE = /^\)\s*(?:\/\/.*)?$/;
// Go raw-string import paths (`import \`fmt\``) are valid but vanishingly rare;
// matching only double-quoted paths keeps the regex literal backtick-free.
const goImportMemberRE =
	/^(?:(?:[._]|[A-Za-z_][A-Za-z0-9_]*)\s+)?(?:"(?:[^"\\]|\\.)*")\s*(?:\/\/.*)?$/;
const goImportSingleRE =
	/^import\s+(?:(?:[._]|[A-Za-z_][A-Za-z0-9_]*)\s+)?(?:"(?:[^"\\]|\\.)*")\s*(?:\/\/.*)?$/;

const pythonImportListRE =
	/^[A-Za-z_][A-Za-z0-9_]*(?:\.[A-Za-z_][A-Za-z0-9_]*)*(?:\s+as\s+[A-Za-z_][A-Za-z0-9_]*)?(?:\s*,\s*[A-Za-z_][A-Za-z0-9_]*(?:\.[A-Za-z_][A-Za-z0-9_]*)*(?:\s+as\s+[A-Za-z_][A-Za-z0-9_]*)?)*$/;
const pythonFromStartRE =
	/^from\s+(?:\.*(?:[A-Za-z_][A-Za-z0-9_]*(?:\.[A-Za-z_][A-Za-z0-9_]*)*)?)\s+import\s+(.+)$/;
const pythonFromListRE =
	/^(?:\*|[A-Za-z_][A-Za-z0-9_]*(?:\s+as\s+[A-Za-z_][A-Za-z0-9_]*)?(?:\s*,\s*[A-Za-z_][A-Za-z0-9_]*(?:\s+as\s+[A-Za-z_][A-Za-z0-9_]*)?)*)$/;

// Module specifiers are matched only as " or ' delimited strings. JS template-
// literal specifiers (`import x from \`mod\``) are non-standard and omitted to
// keep the regex literals backtick-free.
const javascriptSideEffectImportRE = /^import\s+["'][^"']+["']\s*;?\s*(?:\/\/.*)?$/;
const javascriptFromImportRE =
	/^import\s+.+\s+from\s+["'][^"']+["'](?:\s+(?:with|assert)\s*\{.*\})?\s*;?\s*(?:\/\/.*)?$/;
const javascriptTSRequireImportRE =
	/^import\s+[A-Za-z_$][A-Za-z0-9_$]*\s*=\s*require\s*\(\s*["'][^"']+["']\s*\)\s*;?\s*(?:\/\/.*)?$/;
const javascriptRequireRE =
	/^(?:require\s*\(\s*["'][^"']+["']\s*\)|(?:const|let|var)\s+(?:[A-Za-z_$][A-Za-z0-9_$]*|\{[^;]*\}|\[[^;]*\])\s*=\s*require\s*\(\s*["'][^"']+["']\s*\)(?:\.[A-Za-z_$][A-Za-z0-9_$]*)*)\s*;?\s*(?:\/\/.*)?$/;
const javascriptRequireStartRE =
	/^(?:const|let|var)\s+(?:[A-Za-z_$][A-Za-z0-9_$]*|\{[^;]*|\[[^;]*)\s*=\s*require\s*\(/;
const javascriptImportContinuationMemberRE =
	/^[A-Za-z0-9_$,*{}\s]+(?:\s+as\s+[A-Za-z_$][A-Za-z0-9_$]*)?[,]?$/;

const rustUseStartRE = /^(?:pub(?:\s*\([^)]*\))?\s+)?use\s+/;
const rustUseContinuationMemberRE = /^[A-Za-z0-9_:,*{}\s]+(?:\s+as\s+[A-Za-z_][A-Za-z0-9_]*)?[,;]?$/;

const cIncludeStartRE = /^#\s*include(?:_next)?(?:\s|[<"])/;

const javaImportRE =
	/^import\s+(?:static\s+)?[A-Za-z_$][A-Za-z0-9_$]*(?:\.[A-Za-z_$*][A-Za-z0-9_$*]*)*(?:\s+as\s+[A-Za-z_$][A-Za-z0-9_$]*)?\s*;?\s*(?:\/\/.*)?$/;

interface SideLine {
	/** Original diff line index. */
	index: number;
	/** Line body with the leading diff marker (`+`/`-`/` `) stripped. */
	text: string;
}

function stripPythonComment(text: string): string {
	const hash = text.indexOf("#");
	if (hash >= 0) text = text.slice(0, hash);
	return text.trim();
}

function countSub(s: string, sub: string): number {
	let c = 0;
	let i = s.indexOf(sub);
	while (i >= 0) {
		c++;
		i = s.indexOf(sub, i + sub.length);
	}
	return c;
}

// --- per-language statement-end scanners (exclusive end; start if not import) -

function goImportEnd(lines: SideLine[], start: number): number {
	let t = lines[start]!.text.trim();
	if (goImportSingleRE.test(t)) return start + 1;
	if (!goImportBlockStartRE.test(t)) return start;
	for (let i = start + 1; i < lines.length && i <= start + 200; i++) {
		t = lines[i]!.text.trim();
		if (goImportBlockEndRE.test(t)) return i + 1;
		if (t === "" || t.startsWith("//") || goImportMemberRE.test(t)) continue;
		return i;
	}
	return start;
}

function pythonImportEnd(lines: SideLine[], start: number): number {
	const code = stripPythonComment(lines[start]!.text.trim());
	if (code.startsWith("import ")) {
		const rest = code.slice("import ".length).trim();
		return pythonContinuedImportEnd(lines, start, rest, pythonImportListRE);
	}
	const m = pythonFromStartRE.exec(code);
	if (!m) return start;
	return pythonContinuedImportEnd(lines, start, m[1]!.trim(), pythonFromListRE);
}

function pythonContinuedImportEnd(
	lines: SideLine[],
	start: number,
	rest: string,
	final: RegExp,
): number {
	if (rest.startsWith("(")) {
		let balance = countSub(rest, "(") - countSub(rest, ")");
		if (balance <= 0) {
			const inside = rest.startsWith("(") ? rest.slice(1, rest.endsWith(")") ? -1 : undefined) : rest;
			const trimmed = inside.trim().replace(/,$/, "");
			if (final.test(trimmed)) return start + 1;
			return start;
		}
		let contents = rest.slice(1);
		for (let i = start + 1; i < lines.length && i <= start + 200; i++) {
			const part = stripPythonComment(lines[i]!.text.trim());
			const member = part.replace(/\(/g, "").replace(/\)/g, "").replace(/,$/, "").trim();
			if (member !== "" && !pythonFromListRE.test(member)) return i;
			balance += countSub(part, "(") - countSub(part, ")");
			contents += " " + part.replace(/\(/g, "").replace(/\)/g, "");
			if (balance === 0) {
				const inside = contents.trim().replace(/,$/, "");
				if (final.test(inside)) return i + 1;
				return i;
			}
		}
		return start;
	}
	if (rest.endsWith("\\")) {
		let joined = rest.slice(0, -1).trim();
		for (let i = start + 1; i < lines.length && i <= start + 50; i++) {
			let part = stripPythonComment(lines[i]!.text.trim());
			const continued = part.endsWith("\\");
			part = part.slice(0, -1).trim();
			joined += " " + part;
			if (!continued) {
				if (final.test(joined.trim())) return i + 1;
				return start;
			}
		}
		return start;
	}
	if (final.test(rest)) return start + 1;
	return start;
}

function javascriptImportEnd(lines: SideLine[], start: number): number {
	const t0 = lines[start]!.text.trim();
	if (!t0.startsWith("import ") || t0.slice("import".length).trim().startsWith("(")) return start;
	let joined = "";
	for (let i = start; i < lines.length && i <= start + 80; i++) {
		const tl = lines[i]!.text.trim();
		joined = joined ? joined + " " + tl : tl;
		if (
			javascriptSideEffectImportRE.test(joined) ||
			javascriptFromImportRE.test(joined) ||
			javascriptTSRequireImportRE.test(joined)
		)
			return i + 1;
		if (i === start) {
			if (t0.includes("{") || t0.includes("[") || t0.endsWith(",")) continue;
			return start;
		}
		if (tl === "" || tl.startsWith("//") || javascriptImportContinuationMemberRE.test(tl)) continue;
		return i;
	}
	return start;
}

function javascriptRequireEnd(lines: SideLine[], start: number): number {
	const t0 = lines[start]!.text.trim();
	const bareRequire = t0.startsWith("require(") || t0.startsWith("require (");
	let direct = bareRequire || javascriptRequireStartRE.test(t0);
	for (const kw of ["const ", "let ", "var "]) {
		if (!t0.startsWith(kw)) continue;
		const unclosed =
			countSub(t0, "{") > countSub(t0, "}") || countSub(t0, "[") > countSub(t0, "]");
		if (unclosed) direct = true;
	}
	if (!direct) return start;
	let joined = "";
	for (let i = start; i < lines.length && i <= start + 80; i++) {
		joined = joined ? joined + " " + lines[i]!.text.trim() : lines[i]!.text.trim();
		if (javascriptRequireRE.test(joined)) return i + 1;
	}
	return start;
}

function rustUseEnd(lines: SideLine[], start: number): number {
	const t = lines[start]!.text.trim();
	if (!rustUseStartRE.test(t)) return start;
	if (t.endsWith(";")) return start + 1;
	if (!t.includes("{") && !t.endsWith("::")) return start;
	for (let i = start + 1; i < lines.length && i <= start + 200; i++) {
		const c = lines[i]!.text.trim();
		if (c === "" || c.startsWith("//")) continue;
		if (!rustUseContinuationMemberRE.test(c)) return i;
		if (c.endsWith(";")) return i + 1;
	}
	return start;
}

function cIncludeEnd(lines: SideLine[], start: number): number {
	if (!cIncludeStartRE.test(lines[start]!.text.trim())) return start;
	for (let i = start; i < lines.length && i <= start + 50; i++) {
		if (!lines[i]!.text.trim().endsWith("\\")) return i + 1;
	}
	return start;
}

function javaImportEnd(lines: SideLine[], start: number): number {
	if (javaImportRE.test(lines[start]!.text.trim())) return start + 1;
	return start;
}

function importStatementEnd(lines: SideLine[], start: number, lang: Language): number {
	switch (lang) {
		case "go":
			return goImportEnd(lines, start);
		case "python":
			return pythonImportEnd(lines, start);
		case "javascript": {
			const e = javascriptImportEnd(lines, start);
			return e > start ? e : javascriptRequireEnd(lines, start);
		}
		case "rust":
			return rustUseEnd(lines, start);
		case "c":
			return cIncludeEnd(lines, start);
		case "java":
			return javaImportEnd(lines, start);
		default:
			return start;
	}
}

/** Classify which side lines (by position) are import scaffolding. */
function classifySideImports(lines: SideLine[], lang: Language): boolean[] {
	const hidden = new Array(lines.length).fill(false);
	let i = 0;
	while (i < lines.length) {
		const end = importStatementEnd(lines, i, lang);
		if (end <= i) {
			i++;
			continue;
		}
		for (let j = i; j < end; j++) hidden[j] = true;
		i = end;
	}
	return hidden;
}

interface HunkSpan {
	headerIndex: number;
	start: number; // first source line
	end: number; // exclusive: first structural line after the hunk body
	language: Language;
}

function hunkSpans(a: AnalyzedDiff): HunkSpan[] {
	const spans: HunkSpan[] = [];
	const n = a.lines.length;
	for (let i = 0; i < n; i++) {
		if (a.kinds[i] !== "hunkHeader") continue;
		const language = a.languages[i]!;
		let end = i + 1;
		while (
			end < n &&
			a.kinds[end] !== "hunkHeader" &&
			a.kinds[end] !== "header" &&
			a.kinds[end] !== "oldFile" &&
			a.kinds[end] !== "newFile"
		) {
			end++;
		}
		spans.push({ headerIndex: i, start: i + 1, end, language });
	}
	return spans;
}

/**
 * Compute the compiler-owned mandatory import-removal mask: a per-line boolean
 * (true = hide as import scaffolding). The compiler merges this into its hidden
 * mask before applying the model's plan.
 */
export function mandatoryImportMask(a: AnalyzedDiff): boolean[] {
	const n = a.lines.length;
	const hidden = new Array<boolean>(n).fill(false);
	const spans = hunkSpans(a);

	for (const h of spans) {
		if (h.language === "unknown") continue;
		const minus: SideLine[] = [];
		const plus: SideLine[] = [];
		const minusPos = new Map<number, number>();
		const plusPos = new Map<number, number>();
		for (let i = h.start; i < h.end; i++) {
			if (a.kinds[i] !== "hunkContext" && a.kinds[i] !== "hunkChange") continue;
			const text = a.lines[i]!;
			const marker = text[0];
			const body = text.slice(1);
			if (marker === " " ) {
				minusPos.set(i, minus.length);
				minus.push({ index: i, text: body });
				plusPos.set(i, plus.length);
				plus.push({ index: i, text: body });
			} else if (marker === "-") {
				minusPos.set(i, minus.length);
				minus.push({ index: i, text: body });
			} else if (marker === "+") {
				plusPos.set(i, plus.length);
				plus.push({ index: i, text: body });
			}
		}
		const minusHidden = classifySideImports(minus, h.language);
		const plusHidden = classifySideImports(plus, h.language);
		for (let i = h.start; i < h.end; i++) {
			if (a.kinds[i] !== "hunkContext" && a.kinds[i] !== "hunkChange") continue;
			const marker = a.lines[i]![0];
			if (marker === "-") hidden[i] = minusHidden[minusPos.get(i)!] ?? false;
			else if (marker === "+") hidden[i] = plusHidden[plusPos.get(i)!] ?? false;
			else if (marker === " ")
				hidden[i] = (minusHidden[minusPos.get(i)!] ?? false) && (plusHidden[plusPos.get(i)!] ?? false);
		}
	}

	// Simplified framing: drop an import-only hunk's header, and an import-only
	// file's metadata. A hunk is import-only when every one of its source lines
	// is import-hidden and at least one was. A file's metadata is dropped only
	// when EVERY hunk in that file is import-only (not any), so a file that mixes
	// an import hunk with a real-change hunk keeps its headers.
	const importOnlyHunks = new Set<number>();
	for (const h of spans) {
		let anySource = false;
		let allHidden = true;
		for (let i = h.start; i < h.end; i++) {
			if (a.kinds[i] !== "hunkContext" && a.kinds[i] !== "hunkChange") continue;
			anySource = true;
			if (!hidden[i]) allHidden = false;
		}
		if (anySource && allHidden) {
			hidden[h.headerIndex] = true;
			importOnlyHunks.add(a.hunkIds[h.headerIndex]!);
		}
	}
	const fileHunks = new Map<number, { total: number; importOnly: number }>();
	for (const h of spans) {
		const fid = a.fileIds[h.headerIndex]!;
		if (fid < 0) continue;
		const e = fileHunks.get(fid) ?? { total: 0, importOnly: 0 };
		e.total++;
		if (importOnlyHunks.has(a.hunkIds[h.headerIndex]!)) e.importOnly++;
		fileHunks.set(fid, e);
	}
	const hiddenFiles = new Set<number>();
	for (const [fid, e] of fileHunks) {
		if (e.total > 0 && e.importOnly === e.total) hiddenFiles.add(fid);
	}
	if (hiddenFiles.size) {
		for (let i = 0; i < n; i++) {
			const fid = a.fileIds[i]!;
			if (fid >= 0 && hiddenFiles.has(fid)) {
				const k = a.kinds[i];
				if (
					k === "header" ||
					k === "index" ||
					k === "oldFile" ||
					k === "newFile" ||
					k === "renameFrom" ||
					k === "renameTo" ||
					k === "copyFrom" ||
					k === "copyTo"
				)
					hidden[i] = true;
			}
		}
	}

	return hidden;
}
