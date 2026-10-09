// Consult-core characterization: runConsult composes the per-peer argv
// builders, runProcess, and the stream-event parsers into one {answer,
// sessionId} result for consumer extensions (pi-unblock consults). The peer
// fake emits the real CLI grammars pinned in the peers-* suites.
import { execFile } from "node:child_process";
import { join } from "node:path";
import { promisify } from "node:util";
import { describe, expect, it } from "vitest";
import { ConsultError, runConsult, sanitizeReviewerOutput } from "../src/consult.js";

const execFileAsync = promisify(execFile);
const FIXTURE = join(import.meta.dirname, "fixtures", "peer-fake.mjs");
const binary = process.execPath;

async function fixtureArg(): Promise<string> {
	// peer-fake.mjs needs its absolute path as the script argument after the
	// node binary; verify the fixture runs before pinning behaviors.
	await execFileAsync(process.execPath, [FIXTURE, "exit-code", "0"]);
	return FIXTURE;
}

describe("sanitizeReviewerOutput", () => {
	it("strips SGR, OSC, and cursor-control sequences", () => {
		const dirty = "\x1b[?25l\x1b[31mverdict\x1b[0m: \x1b]0;title\x07go";
		expect(sanitizeReviewerOutput(dirty)).toBe("verdict: go");
	});

	it("normalizes CRLF and trims surrounding whitespace", () => {
		expect(sanitizeReviewerOutput("  a\r\nb\r\n  ")).toBe("a\nb");
	});

	it("leaves plain text and newlines untouched", () => {
		expect(sanitizeReviewerOutput("line one\nline two")).toBe("line one\nline two");
	});
});

describe("runConsult: claude (stdin transport, JSONL events)", () => {
	it("returns the sanitized result text plus the init session id", async () => {
		const fixture = await fixtureArg();
		const r = await runConsult({
			peer: "claude",
			binary,
			args: [fixture, "claude-consult"],
			prompt: "review this diff",
			timeoutMs: 10_000,
		});
		expect(r.answer).toBe("REVIEW VERDICT: ship it");
		expect(r.sessionId).toBe("11111111-2222-3333-4444-555555555555");
		expect(r.exitCode).toBe(0);
		expect(r.timedOut).toBe(false);
		expect(r.aborted).toBe(false);
	});

	it("delivers the prompt via stdin (never argv)", async () => {
		const fixture = await fixtureArg();
		// The fixture exits 4 with stderr when stdin is empty, proving the
		// transport; a huge prompt would E2BIG if it traveled as argv.
		const big = "x".repeat(250_000);
		const r = await runConsult({
			peer: "claude",
			binary,
			args: [fixture, "claude-consult"],
			prompt: big,
			timeoutMs: 10_000,
		});
		expect(r.exitCode).toBe(0);
	});

	it("fails visibly when no answer event arrives", async () => {
		const fixture = await fixtureArg();
		await expect(
			runConsult({
				peer: "claude",
				binary,
				args: [fixture, "lines", "2"],
				prompt: "review",
				timeoutMs: 10_000,
			}),
		).rejects.toSatisfy((e: unknown) => e instanceof ConsultError && e.reason === "empty-answer");
	});
});

describe("runConsult: codex (positional transport, JSONL events)", () => {
	it("returns the agent message plus the thread id", async () => {
		const fixture = await fixtureArg();
		const r = await runConsult({
			peer: "codex",
			binary,
			args: [fixture, "codex-consult"],
			prompt: "review this diff",
			timeoutMs: 10_000,
		});
		expect(r.answer).toBe("codex says: LGTM");
		expect(r.sessionId).toBe("aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee");
		expect(r.exitCode).toBe(0);
	});
});

describe("runConsult: agy (raw transport)", () => {
	it("returns sanitized trimmed stdout with no session handle", async () => {
		const fixture = await fixtureArg();
		const r = await runConsult({
			peer: "agy",
			binary,
			args: [fixture, "ansi"],
			prompt: "review this diff",
			timeoutMs: 10_000,
		});
		expect(r.answer).toBe("verdict: go");
		expect(r.sessionId).toBeNull();
		expect(r.exitCode).toBe(0);
	});
});

describe("runConsult: failure surfaces", () => {
	it("maps nonzero exit to ConsultError(nonzero-exit) carrying stderr", async () => {
		const fixture = await fixtureArg();
		const promise = runConsult({
			peer: "agy",
			binary,
			args: [fixture, "exit-code", "3"],
			prompt: "review",
			timeoutMs: 10_000,
		});
		await expect(promise).rejects.toSatisfy((e: unknown) => {
			if (!(e instanceof ConsultError)) return false;
			return e.reason === "nonzero-exit" && e.exitCode === 3;
		});
	});

	it("maps timeout expiry to ConsultError(timeout)", async () => {
		const fixture = await fixtureArg();
		await expect(
			runConsult({
				peer: "agy",
				binary,
				args: [fixture, "hang", "10000"],
				prompt: "review",
				timeoutMs: 150,
			}),
		).rejects.toSatisfy((e: unknown) => e instanceof ConsultError && e.reason === "timeout");
	});

	it("maps a pre-aborted signal to ConsultError(aborted)", async () => {
		const fixture = await fixtureArg();
		const ac = new AbortController();
		ac.abort();
		await expect(
			runConsult({
				peer: "agy",
				binary,
				args: [fixture, "lines", "2"],
				prompt: "review",
				timeoutMs: 10_000,
				signal: ac.signal,
			}),
		).rejects.toSatisfy((e: unknown) => e instanceof ConsultError && e.reason === "aborted");
	});

	it("maps a missing binary to ConsultError(spawn)", async () => {
		await expect(
			runConsult({
				peer: "agy",
				binary: "/nonexistent/peer-binary-xyz",
				args: [],
				prompt: "review",
				timeoutMs: 10_000,
			}),
		).rejects.toSatisfy((e: unknown) => {
			if (!(e instanceof ConsultError)) return false;
			return e.reason === "spawn" && e.message.length > 0;
		});
	});
});
