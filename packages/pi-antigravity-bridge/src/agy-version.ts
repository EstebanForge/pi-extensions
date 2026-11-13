// agy CLI version gate.
//
// An agy older than MIN_AGY_VERSION fails stream-json turns with raw stream
// errors that look like bridge bugs, so we detect it once per process and
// say so plainly (session-start warning + /agy doctor) instead of letting
// users debug parse noise. Pure functions here; the only subprocess is
// `agy --version`, memoized per binary because discovery already spawns agy
// once per load and the version will not change mid-process.
//
// The ACP server reports the CLI version at initialize. agy acp has its own
// floor because older CLI releases do not ship the subcommand.

import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

/** Floor for the stream-json CLI. Matches the protocol grammar our driver
 *  and the event mapping rely on; older agy predates verified fields. */
export const MIN_AGY_VERSION = "1.1.22";
export const MIN_AGY_ACP_VERSION = "1.5.3";
/** Highest agy release where the top-level --gemini_dir flag was
 *  live-verified to isolate MCP discovery (issue #14 work, 2026-11-13).
 *  The flag is undocumented upstream and may change shape in future
 *  releases; the parse probe catches removal, but a flag that parses yet is
 *  IGNORED cannot be probed without quota - versions above this floor warn
 *  so a silent G9 tool drop gets noticed. */
export const MIN_GEMINI_DIR_VERSION = "1.5.8";

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

// --- --gemini_dir capability probe (issue #14) -------------------------------

export interface GeminiDirProbe {
	/** True when the running agy parses --gemini_dir on the default run path
	 *  (the stream-json spawn shape). Refusal means fall back to global MCP
	 *  registration plus the suppression machinery. */
	supported: boolean;
	version?: string;
	/** Supported but the version is above MIN_GEMINI_DIR_VERSION (or
	 *  unreadable): the parse probe cannot detect a flag that is accepted but
	 *  ignored, so the caller should warn once. */
	unverifiedVersion: boolean;
	/** Why the probe said no (absent when supported). Distinguishes an agy
	 *  that refuses the flag from one the probe could not run at all. */
	detail?: "refused" | "timeout" | "spawn-failure";
}

/** How the stream-json engine should deliver MCP (issue #14). */
export type StreamHomeMode = "isolated" | "override-skip" | "legacy";

/** Decide the stream-json MCP-home mode BEFORE any probe spawn. The
 *  AGY_AGENTS_ROOT sandbox override wins over everything: carriers stage
 *  outside the staged home's live agents view, so isolation would silently
 *  drop the system-prompt carrier regardless of what the probe says. */
export function resolveStreamHomeMode(input: {
	engine: string;
	agentsRootOverride: boolean;
	probe: GeminiDirProbe | undefined;
}): StreamHomeMode {
	if (input.engine !== "stream-json") return "legacy";
	if (input.agentsRootOverride) return "override-skip";
	return input.probe?.supported ? "isolated" : "legacy";
}

export interface ProbeGeminiDirOptions {
	/** Parent dir for the probe home (tests inject an unwritable root). */
	tmpRoot?: string;
	/** Probe watchdog budget (tests shrink the 5s default). */
	watchdogMs?: number;
	/** Extra env for the spawned probe (tests select fixture behaviors). */
	env?: Record<string, string>;
}

const probeCache = new Map<string, Promise<GeminiDirProbe>>();

/** One spawn answers BOTH questions: `agy --gemini_dir <tmp> --version`
 *  prints the version when the flag parses, and a Go flag-package refusal
 *  ("flag provided but not defined", nonzero exit, empty stdout) when it
 *  does not. The default run path parses the underscore form; the acp
 *  subcommand takes the hyphen form (both live-verified 2026-11-13 on agy
 *  1.5.8). Memoized per binary until resetGeminiDirProbeCache. */
export function probeGeminiDirFlag(binary: string = "agy", opts: ProbeGeminiDirOptions = {}): Promise<GeminiDirProbe> {
	const cached = probeCache.get(binary);
	if (cached) return cached;
	const run = new Promise<GeminiDirProbe>((resolve) => {
		let tmp: string;
		try {
			tmp = fs.mkdtempSync(path.join(opts.tmpRoot ?? os.tmpdir(), "agy-geminidir-probe-"));
		} catch {
			// Cannot even stage the probe home: the flag is unproven, fall back.
			resolve({ supported: false, unverifiedVersion: false, detail: "spawn-failure" });
			return;
		}
		let out = "";
		let err = "";
		let code: number | null = null;
		let done = false;
		const finish = () => {
			if (done) return;
			done = true;
			clearTimeout(watchdog);
			fs.rmSync(tmp, { recursive: true, force: true });
			// Exit 0 wins: a CLI can print arbitrary warnings (including text
			// that happens to contain "not defined") on a successful probe.
			if (code === 0) {
				const verdict = agyVersionVerdict(out);
				if (verdict.status === "development") {
					resolve({ supported: true, version: "dev", unverifiedVersion: true });
					return;
				}
				const version = verdict.version;
				resolve({
					supported: true,
					version,
					unverifiedVersion:
						!version || compareVersionTuples(version, MIN_GEMINI_DIR_VERSION) > 0,
				});
				return;
			}
			const detail: NonNullable<GeminiDirProbe["detail"]> = /not defined/.test(err)
				? "refused"
				: code === null
					? "timeout"
					: "spawn-failure";
			resolve({ supported: false, unverifiedVersion: false, detail });
		};
		let proc: ReturnType<typeof spawn>;
		try {
			proc = spawn(binary, ["--gemini_dir", tmp, "--version"], {
				stdio: ["ignore", "pipe", "pipe"],
				shell: false,
				env: opts.env ? { ...process.env, ...opts.env } : process.env,
			});
		} catch {
			fs.rmSync(tmp, { recursive: true, force: true });
			resolve({ supported: false, unverifiedVersion: false, detail: "spawn-failure" });
			return;
		}
		proc.stdout?.setEncoding("utf8");
		proc.stderr?.setEncoding("utf8");
		proc.stdout?.on("data", (d: string) => (out = (out + d).slice(0, 4096)));
		proc.stderr?.on("data", (d: string) => (err = (err + d).slice(0, 4096)));
		proc.on("error", () => {
			code = code ?? -1;
			finish();
		});
		proc.on("close", (c) => {
			code = c;
			finish();
		});
		const watchdog = setTimeout(() => {
			try {
				proc.kill("SIGKILL");
			} catch {
				/* already gone */
			}
		}, opts.watchdogMs ?? 5_000);
	});
	probeCache.set(binary, run);
	return run;
}

/** Test seam: drop the memoized gemini_dir probes. */
export function resetGeminiDirProbeCache(): void {
	probeCache.clear();
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
