import { AcpConnection } from "./connection.js";
import { mapUpdate } from "./events.js";
import { hasAcpToken, writeAcpAuthVerified } from "./setup.js";

// Explicit sign-in (/agy auth): spawn a short-lived server, send
// `authenticate` (the RPC that fires the loopback listener + browser OAuth
// flow), and wait for the token to land in the shared acp_token.json. A
// dedicated process keeps the minutes-scale login ritual away from live
// turns; the next driver connection picks the token up. The real server
// blocks until the browser round-trip completes; the observed window is
// minutes-scale (one flow timed out at ~8.5 minutes), so the timeout is
// generous.
//
// Token-absent after an OK reply is NOT always a failure: server 1.1.1 can
// authenticate from legacy ~/.gemini credential artifacts and never writes
// acp_token.json (observed on darwin/arm64 2026-10-13). A live session/new
// probe separates that from a hollow accept: probe success = signed in
// (recorded in the bridge-side verified marker), probe failure = the server
// holds no usable credentials.

export const AUTH_TIMEOUT_MS = 10 * 60_000;

export interface AcpAuthOptions {
	bin: string;
	binArgs?: string[];
	cwd?: string;
	extraEnv?: Record<string, string>;
	authUrlFile?: string;
	/** Directory holding acp_token.json. Default: ~/.gemini/antigravity-acp.
	 *  Tests point this at a fixture dir; production callers use the default. */
	tokenDir?: string;
	/** The server is expected to have written acp_token.json by the time
	 *  authenticate replies, but write-after-reply is unverified; after a
	 *  successful reply the run polls for the token up to this long before
	 *  SIGTERM, so a laggard write is never killed mid-flight. A token that
	 *  never appears is verified through a live session probe instead of
	 *  failing outright. */
	tokenGraceMs?: number;
	/** Bridge-side verified-sign-in marker. Written on every verified
	 *  success (token file or live session probe). Default is the real
	 *  bridge path; tests point this at a fixture. */
	authVerifiedFile?: string;
	timeoutMs?: number;
	log?: (msg: string, data?: unknown) => void;
}

export interface AcpAuthResult {
	ok: boolean;
	/** Present when verified through the session probe: the server
	 *  authenticated from existing credentials without writing a local
	 *  token file. Absent on the normal token-file path and on failure. */
	note?: string;
	/** Failure reason (spawn, timeout, -32000 family, concurrent run). Absent when ok. */
	error?: string;
}

/** Google returns account-disablement as a normal session/prompt reply
 *  (stopReason end_turn) carrying this text, not a -32000 auth error, so a
 *  session/new probe alone cannot tell "authenticated" from "entitled". */
const ACCOUNT_DISABLED_RE = /disabled in this account|violation of\s+Terms of Service|submit an appeal/i;

/** Bounds the probe's session/prompt. A real first token normally lands well
 *  under this; a hollow or hung server hits the cap and fails auth. */
const PROBE_PROMPT_TIMEOUT_MS = 30_000;

/** Live credential probe for the token-absent branch. session/new alone is
 *  too shallow: a ToS-disabled account passes it. So the probe sends one
 *  trivial session/prompt and inspects the streamed reply (collected by the
 *  caller's onUpdate into `sink`): the disablement notice means the account
 *  is blocked (distinct from a hollow accept). Returns "usable" only when
 *  the prompt completes without that notice. Closes the probe session; the
 *  caller kills the connection either way. */
async function probeUsableCredentials(
	conn: AcpConnection,
	sink: { text: string },
	log: (event: string, data?: unknown) => void,
	cwd?: string,
): Promise<"usable" | "disabled" | "unusable"> {
	let timer: NodeJS.Timeout | undefined;
	try {
		const s = await conn.newSession(cwd ?? process.cwd());
		try {
			sink.text = "";
			// conn.prompt has no timeout by design (driver timers govern real
			// turns). The probe runs during interactive auth, so bound it: a
			// hollow server that accepts session/new but never answers the
			// prompt must fail, not hang /agy auth and the authInFlight lock.
			await Promise.race([
				conn.prompt(s.sessionId, "ping"),
				new Promise<never>((_, reject) => {
					timer = setTimeout(() => reject(new Error("probe prompt timed out")), PROBE_PROMPT_TIMEOUT_MS);
				}),
			]);
		} finally {
			clearTimeout(timer);
			await conn.closeSession(s.sessionId).catch(() => {});
		}
		// Log the reply head so a change in Google's disablement wording (which
		// would silently regress the regex to "usable") is diagnosable.
		log("auth-probe-reply", { head: sink.text.slice(0, 200) });
		return ACCOUNT_DISABLED_RE.test(sink.text) ? "disabled" : "usable";
	} catch {
		return "unusable";
	}
}

let authInFlight: Promise<AcpAuthResult> | null = null;

export function runAcpAuth(opts: AcpAuthOptions): Promise<AcpAuthResult> {
	// Collects streamed reply text so the credential probe can detect an
	// account-disablement notice (which arrives as normal prompt content).
	const probeSink = { text: "" };
	const conn = new AcpConnection({
		bin: opts.bin,
		binArgs: opts.binArgs,
		cwd: opts.cwd ?? process.cwd(),
		extraEnv: opts.extraEnv,
		authUrlFile: opts.authUrlFile,
		log: opts.log ?? (() => {}),
		onUpdate: (_sessionId, update) => {
			const mapped = mapUpdate(update);
			if (mapped?.kind === "text") probeSink.text += mapped.delta;
		},
		onExit: () => {},
	});
	const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));
	const grace = opts.tokenGraceMs ?? 5_000;
	const run = async (): Promise<AcpAuthResult> => {
		try {
			await conn.start();
			await conn.request("authenticate", { methodId: "oauth-personal" }, opts.timeoutMs ?? AUTH_TIMEOUT_MS);
			const deadline = Date.now() + grace;
			while (!hasAcpToken(opts.tokenDir) && Date.now() < deadline) await sleep(200);
			if (!hasAcpToken(opts.tokenDir)) {
				// authenticate replied but no token file: either the server
				// authenticated from artifacts outside antigravity-acp, or the
				// reply is hollow. A live session prompt separates the two.
				const probe = await probeUsableCredentials(conn, probeSink, opts.log ?? (() => {}), opts.cwd);
				if (probe === "disabled") {
					return {
						ok: false,
						error: "this Google account is disabled for the Antigravity service (Terms of Service). Signing in again will not help; submit an appeal with Google to restore access.",
					};
				}
				if (probe !== "usable") {
					return {
						ok: false,
						error: `the server accepted the sign-in but holds no usable credentials (session probe failed; token file absent in ${opts.tokenDir ?? "~/.gemini/antigravity-acp"}). Finish the Google sign-in if a browser opened, then retry /agy auth.`,
					};
				}
				writeAcpAuthVerified(opts.authVerifiedFile);
				return { ok: true, note: "the server authenticated from existing credentials; no browser sign-in was needed" };
			}
			// Token present (normal browser sign-in): no entitlement probe. A
			// ToS-disabled account that completes a real sign-in still verifies
			// here and surfaces the disablement on its first real prompt. The
			// prompt probe is scoped to the token-absent branch (issue #9's
			// `agy acp` shim path) to avoid a model call on every sign-in.
			writeAcpAuthVerified(opts.authVerifiedFile);
			return { ok: true };
		} catch (err) {
			return { ok: false, error: err instanceof Error ? err.message : String(err) };
		} finally {
			conn.kill();
		}
	};
	// One sign-in at a time: two concurrent runs would race the OAuth loopback
	// and the token write. A second invocation fails fast instead.
	if (authInFlight) return Promise.resolve({ ok: false, error: "a sign-in is already running; wait for it to finish" });
	authInFlight = run();
	return authInFlight.finally(() => {
		authInFlight = null;
	});
}
