import { AcpConnection } from "./connection.js";
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

/** Live credential probe for the token-absent branch: a server with usable
 *  credentials answers session/new; a hollow accept starts (or wants) a
 *  browser flow and the request times out or errors. Closes the probe
 *  session; the caller kills the connection either way. */
async function probeUsableCredentials(conn: AcpConnection, cwd?: string): Promise<boolean> {
	try {
		const s = await conn.newSession(cwd ?? process.cwd());
		await conn.closeSession(s.sessionId).catch(() => {});
		return true;
	} catch {
		return false;
	}
}

let authInFlight: Promise<AcpAuthResult> | null = null;

export function runAcpAuth(opts: AcpAuthOptions): Promise<AcpAuthResult> {
	const conn = new AcpConnection({
		bin: opts.bin,
		binArgs: opts.binArgs,
		cwd: opts.cwd ?? process.cwd(),
		extraEnv: opts.extraEnv,
		authUrlFile: opts.authUrlFile,
		log: opts.log ?? (() => {}),
		onUpdate: () => {},
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
				// reply is hollow. A live session/new separates the two.
				if (!(await probeUsableCredentials(conn, opts.cwd))) {
					return {
						ok: false,
						error: `the server accepted the sign-in but holds no usable credentials (session probe failed; token file absent in ${opts.tokenDir ?? "~/.gemini/antigravity-acp"}). Finish the Google sign-in if a browser opened, then retry /agy auth.`,
					};
				}
				writeAcpAuthVerified(opts.authVerifiedFile);
				return { ok: true, note: "the server authenticated from existing credentials; no browser sign-in was needed" };
			}
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
