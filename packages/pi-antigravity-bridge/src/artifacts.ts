// Read-only artifact scan over one agy conversation's brain dir.
//
// agy drops files in three places under brain/<conversationId>/: the
// conversation root itself, .tempmediaStorage/ (media agy generated), and
// .user_uploaded/ (files the user handed it). Nothing else surfaces them,
// so this module lists them for pi (live-probed 2026-09-24: both trees
// exist per engine; media dirs are created on demand and may be absent).
//
// Read-only by design: list and open, never delete. Each entry is
// realpath'd and containment-checked canonical-to-canonical, which defeats
// symlinks pointing outside the conversation root and stays correct when
// the conversation dir itself is reached through a symlinked ancestor
// (macOS /var -> /private/var, symlinked homes). A file could still be
// swapped for a symlink between listing and a later `open` — the OS opener
// would follow it; that is outside this module's guarantee and acceptable
// for a single-user, own-home tool.

import { readdir, realpath, stat } from "node:fs/promises";
import path from "node:path";

export type AgyArtifactKind = "conversation" | "generated" | "uploaded";
export type AgyArtifactMediaType =
	| "image"
	| "audio"
	| "video"
	| "pdf"
	| "markdown"
	| "text"
	| "other";

export interface AgyArtifact {
	name: string;
	absolutePath: string;
	kind: AgyArtifactKind;
	mediaType: AgyArtifactMediaType;
	bytes: number;
	modifiedMs: number;
}

const EXT_TO_MEDIA: Record<string, AgyArtifactMediaType> = {
	png: "image",
	jpg: "image",
	jpeg: "image",
	gif: "image",
	webp: "image",
	svg: "image",
	bmp: "image",
	mp3: "audio",
	wav: "audio",
	ogg: "audio",
	m4a: "audio",
	flac: "audio",
	mp4: "video",
	mov: "video",
	webm: "video",
	mkv: "video",
	pdf: "pdf",
	md: "markdown",
	markdown: "markdown",
	txt: "text",
	csv: "text",
	json: "text",
};

function mediaTypeFor(name: string): AgyArtifactMediaType {
	return EXT_TO_MEDIA[path.extname(name).slice(1).toLowerCase()] ?? "other";
}

/** Files that are agy bookkeeping, not user-facing artifacts. */
function isSkippedName(name: string): boolean {
	return name.startsWith(".") || name.endsWith(".metadata.json");
}

const SCAN_ROOTS: Array<{ sub: string | null; kind: AgyArtifactKind }> = [
	{ sub: null, kind: "conversation" },
	{ sub: ".tempmediaStorage", kind: "generated" },
	{ sub: ".user_uploaded", kind: "uploaded" },
];

/** List artifacts under one conversation dir. Missing subdirs are normal
 *  (created on demand) and skip silently; a missing conversation dir
 *  returns []. Newest first. */
export async function listAgyArtifacts(conversationDir: string): Promise<AgyArtifact[]> {
	// Canonicalize ONCE and derive everything from the canonical root: a
	// raw-vs-canonical containment check silently rejects every entry when
	// any ancestor is a symlink (the relative prefix comparison crosses
	// resolved/unresolved segments and yields a bogus "..").
	let root: string;
	try {
		root = await realpath(conversationDir);
	} catch {
		return [];
	}
	const byPath = new Map<string, AgyArtifact>();
	for (const { sub, kind } of SCAN_ROOTS) {
		const dir = sub === null ? root : path.join(root, sub);
		let entries;
		try {
			entries = await readdir(dir, { withFileTypes: true });
		} catch {
			continue;
		}
		for (const entry of entries) {
			if (!entry.isFile()) continue; // Dirent type: symlinks excluded here
			if (isSkippedName(entry.name)) continue;
			// Re-resolve per entry and re-check containment on the canonical
			// path: catches anything swapped in between readdir and use.
			let canonical: string;
			let stats;
			try {
				canonical = await realpath(path.join(dir, entry.name));
				if (!containedIn(root, canonical)) continue;
				stats = await stat(canonical);
			} catch {
				continue;
			}
			if (!stats.isFile()) continue;
			const key = canonical;
			if (byPath.has(key)) continue;
			byPath.set(key, {
				name: entry.name,
				absolutePath: canonical,
				kind,
				mediaType: mediaTypeFor(entry.name),
				bytes: stats.size,
				modifiedMs: stats.mtimeMs,
			});
		}
	}
	return [...byPath.values()].sort((a, b) => b.modifiedMs - a.modifiedMs);
}

function containedIn(root: string, candidate: string): boolean {
	const rel = path.relative(root, candidate);
	return rel === "" || (!rel.startsWith("..") && !path.isAbsolute(rel));
}

/** OS open command for the user's default handler. Undefined on unknown
 *  platforms (caller renders a message instead of spawning blind). */
export function artifactOpenCommand(): { cmd: string } | undefined {
	if (process.platform === "darwin") return { cmd: "open" };
	if (process.platform === "linux") return { cmd: "xdg-open" };
	return undefined;
}
