/**
 * pi-show-me-the-meat — diff layout analyzer.
 *
 * Parses a unified diff into an immutable, line-oriented layout: every physical
 * line is classified (file header, ---/+++ markers, hunk header, hunk context,
 * hunk change, no-newline marker, ...) and tagged with its file id, hunk id, and
 * source language. Everything downstream (mandatory import removal, the
 * remove/replace/fold compiler) consumes this layout and never re-parses text.
 *
 * Ported from meat (https://github.com/boldsoftware/meat) meat/diff.go, with one
 * deliberate simplification:
 *   - Line endings are plain `\n`; `\r\n` is not tracked separately. The reading
 *     diff is for reading, not patching.
 *
 * Hunk boundaries ARE count-tracked (parsed from `@@ -a,b +c,d @@`), so a
 * `--- `/`+++ ` pair or other structural-looking source line that appears
 * mid-hunk is classified as source while the declared counts have lines
 * remaining, instead of ending the hunk early.
 */
export type DiffLineKind =
	| "other"
	| "header" // diff --git a/.. b/..
	| "index" // index / similarity / dissimilarity / mode lines
	| "oldFile" // --- a/..
	| "newFile" // +++ b/..
	| "renameFrom"
	| "renameTo"
	| "copyFrom"
	| "copyTo"
	| "hunkHeader" // @@ -a,b +c,d @@
	| "hunkContext" //  space-prefixed
	| "hunkChange" // + or - prefixed
	| "noNewline"; // \ No newline at end of file

export type Language =
	| "unknown"
	| "go"
	| "python"
	| "javascript"
	| "rust"
	| "c"
	| "java";

export interface AnalyzedDiff {
	/** Physical lines of the diff (no trailing empty line from a final \n). */
	readonly lines: string[];
	/** Per-line kind. */
	readonly kinds: DiffLineKind[];
	/** Per-line source language (the file's language), `unknown` outside files. */
	readonly languages: Language[];
	/** Per-line file id; increments at each `diff --git`; -1 before the first. */
	readonly fileIds: number[];
	/** Per-line hunk id; increments at each `@@`; -1 outside a hunk. */
	readonly hunkIds: number[];
	/** For a no-newline marker, the source line index it attaches to; else -1. */
	readonly markerOwner: number[];
}

/** A hunk source line is a context or change line (the editable surface). */
export function isHunkSource(kind: DiffLineKind): boolean {
	return kind === "hunkContext" || kind === "hunkChange";
}

/** Detect a source language from a file path by extension. */
export function pathLanguage(rawPath: string): Language {
	const p = rawPath.toLowerCase().replace(/"/g, "");
	if (p.endsWith(".go")) return "go";
	if (p.endsWith(".py") || p.endsWith(".pyi")) return "python";
	if (
		p.endsWith(".js") ||
		p.endsWith(".jsx") ||
		p.endsWith(".mjs") ||
		p.endsWith(".cjs") ||
		p.endsWith(".ts") ||
		p.endsWith(".tsx") ||
		p.endsWith(".mts") ||
		p.endsWith(".cts")
	)
		return "javascript";
	if (p.endsWith(".rs")) return "rust";
	if (
		p.endsWith(".c") ||
		p.endsWith(".h") ||
		p.endsWith(".cc") ||
		p.endsWith(".hh") ||
		p.endsWith(".cpp") ||
		p.endsWith(".hpp") ||
		p.endsWith(".cxx") ||
		p.endsWith(".hxx")
	)
		return "c";
	if (p.endsWith(".java") || p.endsWith(".kt") || p.endsWith(".kts")) return "java";
	return "unknown";
}

function diffHeaderLanguage(line: string): Language {
	// `diff --git a/foo.go b/foo.go` -> fields[2:] are the paths.
	const fields = line.split(/\s+/);
	let lang: Language = "unknown";
	for (const f of fields.slice(2)) {
		const candidate = pathLanguage(f);
		if (candidate !== "unknown") lang = candidate;
	}
	return lang;
}

function fileMarkerLanguage(line: string): Language {
	// `--- a/foo.go` or `+++ b/foo.go` -> text after the 4-char marker.
	if (line.length < 4) return "unknown";
	let p = line.slice(4).trim();
	const tab = p.indexOf("\t");
	if (tab >= 0) p = p.slice(0, tab);
	return pathLanguage(p);
}

/** Parse `@@ -a,b +c,d @@` counts. Returns null for a bare/odd header. */
function parseHunkCounts(header: string): { old: number; new: number } | null {
	const f = header.split(/\s+/);
	if (f.length < 4 || f[0] !== "@@" || f[3] !== "@@") return null;
	const old = parseHunkRange(f[1]!, "-");
	if (old === null) return null;
	const next = parseHunkRange(f[2]!, "+");
	if (next === null) return null;
	return { old, new: next };
}

function parseHunkRange(field: string, sign: string): number | null {
	if (field.length < 2 || field[0] !== sign) return null;
	let rangeText = field.slice(1);
	let count = 1;
	const comma = rangeText.indexOf(",");
	if (comma >= 0) {
		const n = Number.parseInt(rangeText.slice(comma + 1), 10);
		if (Number.isNaN(n) || n < 0) return null;
		count = n;
		rangeText = rangeText.slice(0, comma);
	}
	if (Number.isNaN(Number.parseInt(rangeText, 10))) return null;
	return count;
}

function isFileMarker(line: string, marker: string): boolean {
	return line.startsWith(marker + " ") || line.startsWith(marker + "\t");
}

function isRawOldFileHeader(lines: string[], i: number): boolean {
	return i + 1 < lines.length && isFileMarker(lines[i]!, "---") && isFileMarker(lines[i + 1]!, "+++");
}

function hunkSourceKind(text: string): DiffLineKind | null {
	if (text === "") return null;
	const c = text[0];
	if (c === " ") return "hunkContext";
	if (c === "+" || c === "-") return "hunkChange";
	return null;
}

/**
 * Classify every line of a unified diff. Tolerant: malformed structure degrades
 * to `other` rather than throwing; the compiler treats unclassified lines as
 * pass-through (kept by default in the remove-centric model).
 */
export function analyzeDiff(text: string): AnalyzedDiff {
	const lines = text.replace(/\n$/, "").split("\n");
	const n = lines.length;
	const kinds: DiffLineKind[] = new Array(n).fill("other");
	const languages: Language[] = new Array(n).fill("unknown");
	const fileIds: number[] = new Array(n).fill(-1);
	const hunkIds: number[] = new Array(n).fill(-1);
	const markerOwner: number[] = new Array(n).fill(-1);

	let inFileSection = false;
	let inHunk = false;
	let currentFileId = -1;
	let currentHunkId = -1;
	let currentLanguage: Language = "unknown";
	// Hunk line-count tracking: a `--- `/`+++ ` pair (or any structural-looking
	// source line) that appears mid-hunk is classified as source while the
	// declared counts have lines remaining, instead of ending the hunk early.
	let oldRemain = 0;
	let newRemain = 0;
	let countsKnown = false;

	const noNewline = "\\ No newline at end of file";

	for (let i = 0; i < n; i++) {
		const text_ = lines[i]!;

		// No-newline marker attaches to the preceding source line.
		if (text_ === noNewline) {
			kinds[i] = "noNewline";
			if (inHunk) {
				hunkIds[i] = currentHunkId;
				fileIds[i] = currentFileId;
				if (i > 0 && isHunkSource(kinds[i - 1]!)) markerOwner[i] = i - 1;
			}
			continue;
		}

		if (inHunk) {
			// Structural exits: new file header, new hunk, or a paired file marker.
			if (text_.startsWith("diff --git ") || (countsKnown && oldRemain === 0 && newRemain === 0) || (!countsKnown && (text_.startsWith("@@") || isRawOldFileHeader(lines, i)))) {
				inHunk = false;
			} else {
				const kind = hunkSourceKind(text_);
				if (kind) {
					if (countsKnown) {
						const c = text_[0];
						if (c === " ") {
							if (oldRemain > 0) oldRemain--;
							if (newRemain > 0) newRemain--;
						} else if (c === "-") {
							if (oldRemain > 0) oldRemain--;
						} else if (c === "+") {
							if (newRemain > 0) newRemain--;
						}
					}
					kinds[i] = kind;
					hunkIds[i] = currentHunkId;
					fileIds[i] = currentFileId;
					languages[i] = currentLanguage;
					continue;
				}
				// Not a source line and not structural: end the hunk, reclassify below.
				inHunk = false;
			}
		}

		if (text_.startsWith("diff --git ")) {
			currentFileId++;
			currentHunkId = -1;
			kinds[i] = "header";
			fileIds[i] = currentFileId;
			currentLanguage = diffHeaderLanguage(text_);
			languages[i] = currentLanguage;
			inFileSection = true;
			inHunk = false;
			continue;
		}

		if (inFileSection && (text_.startsWith("index ") || text_.startsWith("similarity index ") || text_.startsWith("dissimilarity index ") || text_.startsWith("new file mode ") || text_.startsWith("deleted file mode ") || text_.startsWith("old mode ") || text_.startsWith("new mode "))) {
			kinds[i] = "index";
			fileIds[i] = currentFileId;
			continue;
		}

		if (inFileSection && text_.startsWith("rename from ")) {
			kinds[i] = "renameFrom";
			fileIds[i] = currentFileId;
			continue;
		}
		if (inFileSection && text_.startsWith("rename to ")) {
			kinds[i] = "renameTo";
			fileIds[i] = currentFileId;
			continue;
		}
		if (inFileSection && text_.startsWith("copy from ")) {
			kinds[i] = "copyFrom";
			fileIds[i] = currentFileId;
			continue;
		}
		if (inFileSection && text_.startsWith("copy to ")) {
			kinds[i] = "copyTo";
			fileIds[i] = currentFileId;
			continue;
		}

		if (isRawOldFileHeader(lines, i)) {
			kinds[i] = "oldFile";
			kinds[i + 1] = "newFile";
			fileIds[i] = currentFileId;
			fileIds[i + 1] = currentFileId;
			const oldLang = fileMarkerLanguage(lines[i]!);
			const newLang = fileMarkerLanguage(lines[i + 1]!);
			if (oldLang !== "unknown") currentLanguage = oldLang;
			if (newLang !== "unknown") currentLanguage = newLang;
			languages[i] = currentLanguage;
			languages[i + 1] = currentLanguage;
			i++; // consume the +++ line
			continue;
		}

		if (text_.startsWith("@@")) {
			kinds[i] = "hunkHeader";
			currentHunkId++;
			hunkIds[i] = currentHunkId;
			fileIds[i] = currentFileId;
			languages[i] = currentLanguage;
			const counts = parseHunkCounts(text_);
			if (counts) {
				oldRemain = counts.old;
				newRemain = counts.new;
				countsKnown = true;
			} else {
				oldRemain = 0;
				newRemain = 0;
				countsKnown = false;
			}
			inHunk = true;
			continue;
		}

		// Anything else (mailbox signature `-- `, prose, etc.): leave as `other`.
		if (currentFileId >= 0) fileIds[i] = currentFileId;
	}

	return { lines, kinds, languages, fileIds, hunkIds, markerOwner };
}
