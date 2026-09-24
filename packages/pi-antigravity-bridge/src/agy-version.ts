// agy CLI version gate.
//
// An agy older than MIN_AGY_VERSION fails stream-json turns with raw stream
// errors that look like bridge bugs, so we detect it once per process and
// say so plainly (session-start warning + /agy doctor) instead of letting
// users debug parse noise. Pure functions here; the only subprocess is
// `agy --version`, memoized per binary because discovery already spawns agy
// once per load and the version will not change mid-process.
//
// The ACP server reports its own version at initialize (agentInfo.version,
// e.g. "agy_acp_server_1.1.1") and /agy doctor already prints it. ACP build
// numbering is a different lineage from the CLI, so no floor is enforced
// there: the one known-good build must not be locked out by a CLI number.

import { spawn } from "node:child_process";

/** Floor for the stream-json CLI. Matches the protocol grammar our driver
 *  and the event mapping rely on; older agy predates verified fields. */
export const MIN_AGY_VERSION = "1.1.22";

const VERSION_TIMEOUT_MS = 5_000;

export type AgyVersionStatus =
	| "ok"
	| "unsupported"
	| "development"
	| "invalid"
	| "unavailable";

export interface AgyVersionCheck {
	status: AgyVersionStatus;
	/** Extracted triple when status is ok/unsupported; raw dev token for development. */
	version?: string;
	/** Full --version output, for doctor detail. */
	raw: string;
}

/** Pull the first strict triple (`1.2.10`) out of arbitrary version output.
 *  Prefixed forms like "agy_acp_server_1.1.1" and banner text both match;
 *  anything without a triple is not a version we can gate on. */
export function parseAgyVersionTriple(text: string): string | undefined {
	return /\d+\.\d+\.\d+/.exec(text)?.[0];
}

/** Numeric triple compare; 1.10.0 > 1.9.9, unlike string compare. */
export function compareVersionTuples(a: string, b: string): number {
	const pa = a.split(".").map(Number);
	const pb = b.split(".").map(Number);
	for (let i = 0; i < 3; i++) {
		const d = (pa[i] ?? 0) - (pb[i] ?? 0);
		if (d !== 0) return d;
	}
	return 0;
}

/** Classify raw `--version` output against a floor. Pure: unit-tested for
 *  every status; checkAgyCliVersion wraps this with the subprocess. */
export function agyVersionVerdict(
	raw: string,
	floor: string = MIN_AGY_VERSION,
): AgyVersionCheck {
	// Development builds (agy from source) self-identify as dev, HEAD, or the
	// spelled-out word; never gate any of them.
	if (/\b(dev|head|development)\b/i.test(raw))
		return { status: "development", version: "dev", raw };
	const triple = parseAgyVersionTriple(raw);
	if (!triple) return { status: "invalid", raw };
	if (compareVersionTuples(triple, floor) < 0) return { status: "unsupported", version: triple, raw };
	return { status: "ok", version: triple, raw };
}

const checkCache = new Map<string, Promise<AgyVersionCheck>>();

/** Run `binary --version` and classify the result. Memoized per binary for
 *  the process lifetime (resetAgyVersionCache clears it for tests). Fail
 *  paths: spawn error (ENOENT etc.) and watchdog timeout are "unavailable",
 *  a distinct status so doctor can say "could not run" instead of blaming
 *  the version string. */
export function checkAgyCliVersion(binary: string = "agy"): Promise<AgyVersionCheck> {
	const cached = checkCache.get(binary);
	if (cached) return cached;
	const run = new Promise<AgyVersionCheck>((resolve) => {
		let out = "";
		let done = false;
		const finish = (check: AgyVersionCheck) => {
			if (done) return;
			done = true;
			clearTimeout(watchdog);
			resolve(check);
		};
		let proc: ReturnType<typeof spawn>;
		try {
			proc = spawn(binary, ["--version"], { stdio: ["ignore", "pipe", "ignore"], shell: false });
		} catch {
			finish({ status: "unavailable", raw: "" });
			return;
		}
		proc.stdout?.setEncoding("utf8");
		proc.stdout?.on("data", (d: string) => (out = (out + d).slice(0, 4096)));
		proc.on("error", () => finish({ status: "unavailable", raw: "" }));
		// Exit code is ignored on purpose: `agy --version` failures print to
		// stderr (ignored) and leave junk or empty stdout, which classifies as
		// invalid — close enough in effect to unavailable for a warn-only gate.
		proc.on("close", () => finish(agyVersionVerdict(out)));
		const watchdog = setTimeout(() => {
			try {
				proc.kill("SIGKILL");
			} catch {
				/* already gone */
			}
			finish({ status: "unavailable", raw: out });
		}, VERSION_TIMEOUT_MS);
	});
	checkCache.set(binary, run);
	return run;
}

/** Test seam: drop all memoized checks. */
export function resetAgyVersionCache(): void {
	checkCache.clear();
}

/** One-line doctor rendering. */
export function describeAgyVersionCheck(check: AgyVersionCheck): string {
	switch (check.status) {
		case "ok":
			return check.version ?? "ok";
		case "unsupported":
			return `${check.version} TOO OLD`;
		case "development":
			return "development build";
		case "invalid":
			return "unreadable version output";
		case "unavailable":
			return "could not run --version";
	}
}
