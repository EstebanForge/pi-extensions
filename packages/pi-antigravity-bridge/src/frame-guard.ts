// Frame-guard: shared stdout framing defense for both engines.
//
// agy's stdout is a protocol stream, but foreign processes occasionally write
// into the same inherited pipe (the Chromium launcher behind a browser login
// prints "Opening in existing browser session." straight into it). Two
// defenses:
//
//   1. A hard per-frame ceiling: a line with no newline must never grow the
//      reassembly buffer without bound. Breach = the peer is broken or
//      hostile, the transport is dead.
//   2. Known-noise handling: a complete noise line is dropped before parsing;
//      a noise FRAGMENT without a trailing newline glues itself onto the next
//      real frame, so repair strips everything up to and including the marker.

/** Hard ceiling on one buffered (newline-terminated) frame. 32MB matches the
 *  reference ACP transport; real frames are KBs, machine-generated output
 *  with no newline for 32MB is a flood, not a frame. */
export const MAX_FRAME_BYTES = 32 * 1024 * 1024;

const NOISE_MARKERS = ["Opening in existing browser session."];

/** True when a complete line is pure known noise: drop before parsing. */
export function isKnownNoiseLine(line: string): boolean {
	const trimmed = line.trim();
	if (!trimmed) return false;
	return NOISE_MARKERS.some((m) => trimmed === m);
}

/** Repair for the glue case: a noise fragment arrived without its newline and
 *  the next real frame is now "noise + json". Returns the remainder after the
 *  first known marker, or null when the line carries no marker. */
export function stripGluedNoise(line: string): string | null {
	for (const marker of NOISE_MARKERS) {
		const idx = line.indexOf(marker);
		if (idx >= 0) return line.slice(idx + marker.length).trim();
	}
	return null;
}
