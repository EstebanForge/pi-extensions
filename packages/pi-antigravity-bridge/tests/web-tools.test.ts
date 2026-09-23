// web-tools tests: gated one-shot agy web runs against a scripted fake `agy`
// binary, plus the sweep hygiene, registration surface, and config gate.

import { spawnSync } from "node:child_process";
import {
	chmodSync,
	existsSync,
	mkdirSync,
	mkdtempSync,
	readFileSync,
	readdirSync,
	rmSync,
	utimesSync,
	writeFileSync,
} from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, test } from "vitest";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { loadConfig } from "../src/config.js";
import { registerWebTools, runWebAgent, sweepStaleWebAgents, WEB_AGENT_PREFIX } from "../src/web-tools.js";
import type { WebRunOptions, WebRunResult } from "../src/web-tools.js";

const FIXTURE = fileURLToPath(new URL("./helpers/fake-agy-web.mjs", import.meta.url));

let tmp = "";
let root = "";
let record = "";

beforeAll(() => {
	tmp = mkdtempSync(path.join(os.tmpdir(), "agy-web-tools-test-"));
	root = path.join(tmp, "agents");
	mkdirSync(root, { recursive: true });
	chmodSync(FIXTURE, 0o755);
	record = path.join(tmp, "record.ndjson");
});

afterAll(() => {
	delete process.env.FIXTURE_MODE;
	delete process.env.FIXTURE_RECORD;
	delete process.env.FIXTURE_ROOT;
	rmSync(tmp, { recursive: true, force: true });
});

async function runFixture(mode: string, opts: Partial<WebRunOptions> = {}): Promise<WebRunResult> {
	process.env.FIXTURE_MODE = mode;
	process.env.FIXTURE_RECORD = record;
	process.env.FIXTURE_ROOT = root;
	try {
		return await runWebAgent({
			prompt: "q",
			gatedTool: "search_web",
			bin: FIXTURE,
			cwd: tmp,
			agentsRoot: root,
			...opts,
		});
	} finally {
		delete process.env.FIXTURE_MODE;
		delete process.env.FIXTURE_RECORD;
		delete process.env.FIXTURE_ROOT;
	}
}

function listBridgeDirs(): string[] {
	try {
		return readdirSync(root).filter((e) => e.startsWith(WEB_AGENT_PREFIX));
	} catch {
		return [];
	}
}

function fakePi(): { api: ExtensionAPI; registered: Array<{ name: string; description: string; execute: Function }> } {
	const registered: Array<{ name: string; description: string; execute: Function }> = [];
	const api = { registerTool: (t: never) => registered.push(t) } as unknown as ExtensionAPI;
	return { api, registered };
}

describe("runWebAgent gate", () => {
	test("observed search_web DONE + result SUCCESS returns the answer and removes the agent dir", async () => {
		const run = await runFixture("ok");
		expect(run.ok).toBe(true);
		if (run.ok) expect(run.response).toBe("FAKE ANSWER");
		expect(listBridgeDirs()).toEqual([]);
		const lines = readFileSync(record, "utf8")
			.trim()
			.split("\n")
			.map((l) => JSON.parse(l) as { dirExists: boolean });
		expect(lines[0].dirExists).toBe(true);
		// The fixture's last check happens mid-run, before the host's finally:
		// the dir must still exist then. Post-run removal is proven above.
		expect(lines.at(-1)?.dirExists).toBe(true);
	});

	test("answer with no observed search_web step is refused as unverified", async () => {
		const run = await runFixture("no-search");
		expect(run.ok).toBe(false);
		if (!run.ok) expect(run.error).toContain("without an observed search_web step");
	});

	test("answer with no observed read_url_content step is refused on the read tool", async () => {
		const run = await runFixture("no-search", { gatedTool: "read_url_content" });
		expect(run.ok).toBe(false);
		if (!run.ok) expect(run.error).toContain("without an observed read_url_content step");
	});

	test("a disallowed tool step fails the run", async () => {
		const run = await runFixture("unexpected");
		expect(run.ok).toBe(false);
		if (!run.ok) expect(run.error).toContain("disallowed tool: run_command");
	});

	test("older-build enum spelling (state OK, result OK) still passes the gate", async () => {
		const run = await runFixture("drift-ok");
		expect(run.ok).toBe(true);
		if (run.ok) expect(run.response).toBe("FAKE ANSWER");
	});

	test("read_url_content observed step passes the read gate", async () => {
		const run = await runFixture("ok-read", { gatedTool: "read_url_content" });
		expect(run.ok).toBe(true);
	});

	test("result ERROR fails the run", async () => {
		const run = await runFixture("fail");
		expect(run.ok).toBe(false);
		if (!run.ok) expect(run.error).toContain("status ERROR");
	});

	test("a run past the deadline is killed and fails", async () => {
		const run = await runFixture("slow", { timeoutMs: 150 });
		expect(run.ok).toBe(false);
	});
});

describe("sweepStaleWebAgents", () => {
	test("removes dead-pid and old marker-less dirs, keeps live-pid, fresh marker-less, and foreign dirs", () => {
		const dead = spawnSync("true");
		const deadPid = dead.pid ?? 0;
		expect(deadPid).toBeGreaterThan(0);

		const mk = (name: string, pid?: string) => {
			const dir = path.join(root, name);
			mkdirSync(dir, { recursive: true });
			if (pid !== undefined) writeFileSync(path.join(dir, ".pid"), `${pid}\n`);
			return dir;
		};
		const deadDir = mk(`${WEB_AGENT_PREFIX}dead`, `${deadPid}`);
		const aliveDir = mk(`${WEB_AGENT_PREFIX}alive`, `${process.pid}`);
		const oldDir = mk(`${WEB_AGENT_PREFIX}old`);
		utimesSync(oldDir, new Date(Date.now() - 25 * 3600_000), new Date(Date.now() - 25 * 3600_000));
		const freshDir = mk(`${WEB_AGENT_PREFIX}fresh`);
		const foreignDir = mk("user-agent", "999999999");

		sweepStaleWebAgents(root);

		expect(existsSync(deadDir)).toBe(false);
		expect(existsSync(oldDir)).toBe(false);
		expect(existsSync(aliveDir)).toBe(true);
		expect(existsSync(freshDir)).toBe(true);
		expect(existsSync(foreignDir)).toBe(true);
	});

	test("a missing agents root is a no-op", () => {
		expect(() => sweepStaleWebAgents(path.join(tmp, "does-not-exist"))).not.toThrow();
	});
});

describe("registerWebTools", () => {
	test("registers agy_web_search and agy_read_url with quota disclosures", () => {
		const { api, registered } = fakePi();
		registerWebTools(api, { bin: FIXTURE, cwd: tmp });
		expect(registered.map((t) => t.name)).toEqual(["agy_web_search", "agy_read_url"]);
		expect(registered[0].description).toContain("quota");
		expect(registered[1].description).toContain("quota");
	});

	test("query validation refuses empty and over-long queries without spawning", async () => {
		const { api, registered } = fakePi();
		registerWebTools(api, { bin: FIXTURE, cwd: tmp });
		const search = registered[0];
		const empty = await search.execute("id", { query: "   " }, undefined);
		expect(empty.isError).toBe(true);
		const long = await search.execute("id", { query: "x".repeat(2001) }, undefined);
		expect(long.isError).toBe(true);
	});

	test("url validation refuses non-URLs and non-http schemes without spawning", async () => {
		const { api, registered } = fakePi();
		registerWebTools(api, { bin: FIXTURE, cwd: tmp });
		const read = registered[1];
		expect((await read.execute("id", { url: "not a url" }, undefined)).isError).toBe(true);
		expect((await read.execute("id", { url: "file:///etc/passwd" }, undefined)).isError).toBe(true);
		expect((await read.execute("id", { url: "javascript:alert(1)" }, undefined)).isError).toBe(true);
	});
});

describe("webTools config gate", () => {
	test("defaults off, file opt-in works, env overrides the file", () => {
		const cfgPath = path.join(tmp, "config.json");
		writeFileSync(cfgPath, "{}");
		expect(loadConfig(cfgPath).webTools).toBe(false);

		writeFileSync(cfgPath, JSON.stringify({ webTools: true }));
		expect(loadConfig(cfgPath).webTools).toBe(true);

		process.env.AGY_WEB_TOOLS = "0";
		try {
			expect(loadConfig(cfgPath).webTools).toBe(false);
		} finally {
			delete process.env.AGY_WEB_TOOLS;
		}
	});
});
