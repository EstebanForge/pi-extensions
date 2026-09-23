#!/usr/bin/env node
// Fake `agy` for web-tools tests: emits scripted NDJSON frames per FIXTURE_MODE.
// Modes: ok, ok-read, no-search (answer with no tool step), drift-ok (state OK
// + result OK, older-build spelling), unexpected (disallowed tool fires),
// fail (result ERROR), slow (answers after the host deadline).
import { appendFileSync, existsSync } from "node:fs";

const args = process.argv.slice(2);
const get = (flag) => {
	const i = args.indexOf(flag);
	return i >= 0 ? args[i + 1] : undefined;
};
const agent = get("--agent");
const mode = process.env.FIXTURE_MODE ?? "ok";
const record = process.env.FIXTURE_RECORD;
const root = process.env.FIXTURE_ROOT ?? "";

const dirOf = () => `${root}/${agent}`;
const note = (dirExists) => {
	if (record) appendFileSync(record, `${JSON.stringify({ agent, dirExists })}\n`);
};

const line = (obj) => process.stdout.write(`${JSON.stringify(obj)}\n`);
const step = (tool, state) =>
	line({ event: "step_update", step_update: { step_index: 2, state, step_type: "tool", tool_name: tool } });

note(existsSync(dirOf()));

if (mode === "slow") {
	setTimeout(() => {
		line({ event: "result", result: { status: "SUCCESS", response: "TOO LATE" } });
	}, 400);
} else {
	line({ event: "init", init: { cwd: process.cwd(), agent, tools: ["search_web", "read_url_content"] } });
	const tool = mode === "ok-read" || mode === "read-no-fetch" ? "read_url_content" : "search_web";
	if (mode === "ok" || mode === "ok-read") {
		step(tool, "ACTIVE");
		step(tool, "DONE");
	}
	if (mode === "drift-ok") step(tool, "OK");
	if (mode === "unexpected") step("run_command", "ACTIVE");
	note(existsSync(dirOf()));
	const status = mode === "drift-ok" ? "OK" : mode === "fail" ? "ERROR" : "SUCCESS";
	line({ event: "result", result: { status, response: status === "ERROR" ? "" : "FAKE ANSWER" } });
}
