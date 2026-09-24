// Unit tests for the subagent roster (src/subagent-roster.ts).
//
// The roster folds DriverActivity — the engine-agnostic contract — so the
// same fold must serve stream-json (stepId-keyed) and ACP (no stepId,
// name-matched) shapes. Never persisted; error-swallowing fold is pinned.

import assert from "node:assert/strict";
import { test } from "vitest";
import {
	formatSubagentRoster,
	SubagentRoster,
	type SubagentEntry,
} from "../src/subagent-roster.js";
import type { DriverActivity } from "../src/driver-types.js";

const start = (name: string, args: Record<string, unknown>, stepId?: number): DriverActivity => ({
	type: "tool_start",
	...(stepId !== undefined ? { stepId } : {}),
	name,
	args,
});
const done = (name: string, stepId?: number): DriverActivity => ({
	type: "tool_done",
	...(stepId !== undefined ? { stepId } : {}),
	name,
	args: {},
});
const fail = (name: string, message: string, stepId?: number): DriverActivity => ({
	type: "tool_error",
	...(stepId !== undefined ? { stepId } : {}),
	name,
	message,
});

test("roster: spawn tool opens a running entry with name and detail", () => {
	const r = new SubagentRoster();
	r.fold(start("invoke_subagent", { name: "reviewer", task: "review the diff" }, 7));
	const [e] = r.snapshot();
	assert.equal(e.name, "reviewer");
	assert.equal(e.status, "running");
	assert.equal(e.detail, "review the diff");
	assert.equal(e.messages, 0);
	assert.equal(r.runningCount(), 1);
});

test("roster: stream-json done/error close by stepId", () => {
	const r = new SubagentRoster();
	r.fold(start("run_subagent", { name: "planner" }, 3));
	r.fold(done("run_subagent", 3));
	assert.equal(r.snapshot()[0]?.status, "done");
	r.fold(start("run_subagent", { name: "builder" }, 4));
	r.fold(fail("run_subagent", "blew up", 4));
	const [err] = r.snapshot().filter((e) => e.name === "builder");
	assert.equal(err?.status, "error");
	assert.equal(err?.error, "blew up");
});

test("roster: ACP shape (toolCallId, no stepId) closes by protocol id", () => {
	const r = new SubagentRoster();
	r.fold({ type: "tool_start", name: "invoke_subagent", args: { subagent_name: "writer" }, toolCallId: "call-9" });
	r.fold({ type: "tool_done", name: "invoke_subagent", args: {}, toolCallId: "call-9" });
	assert.equal(r.snapshot()[0]?.status, "done");
	// A done under an unknown id never touches other entries.
	r.fold({ type: "tool_start", name: "invoke_subagent", args: { name: "second" }, toolCallId: "call-10" });
	r.fold({ type: "tool_error", name: "invoke_subagent", message: "x", toolCallId: "unknown" });
	assert.equal(r.snapshot()[1]?.status, "running");
});

test("roster: id-less engines close the oldest running entry", () => {
	const r = new SubagentRoster();
	r.fold(start("invoke_subagent", { name: "first" }));
	r.fold(start("invoke_subagent", { name: "second" }));
	r.fold({ type: "tool_done", name: "invoke_subagent", args: {} });
	assert.equal(r.snapshot()[0]?.status, "done");
	assert.equal(r.snapshot()[1]?.status, "running");
});

test("roster: send_message increments the named entry", () => {
	const r = new SubagentRoster();
	r.fold(start("invoke_subagent", { name: "reviewer" }, 1));
	r.fold(start("send_message", { subagent: "reviewer", text: "go" }, 2));
	r.fold(start("send_message", { subagent: "reviewer", text: "again" }, 3));
	assert.equal(r.snapshot()[0]?.messages, 2);
	// send_message steps themselves never become roster entries.
	assert.equal(r.snapshot().length, 1);
});

test("roster: manage_subagents kill marks running entries killed", () => {
	const r = new SubagentRoster();
	r.fold(start("invoke_subagent", { name: "a" }, 1));
	r.fold(start("invoke_subagent", { name: "b" }, 2));
	r.fold(done("invoke_subagent", 1));
	r.fold(start("manage_subagents", { action: "kill", agent: "b" }, 3));
	assert.equal(r.snapshot().find((e) => e.name === "a")?.status, "done");
	assert.equal(r.snapshot().find((e) => e.name === "b")?.status, "killed");
});

test("roster: unknown tools and non-tool activities are ignored", () => {
	const r = new SubagentRoster();
	r.fold({ type: "text", delta: "hi" });
	r.fold({ type: "usage", usage: { total_tokens: 1 } });
	r.fold(start("read_file", { path: "/x" }, 1));
	assert.equal(r.snapshot().length, 0);
});

test("roster: a throwing fold target cannot fail the caller", () => {
	const r = new SubagentRoster();
	// An args object that throws on enumeration simulates corrupted state;
	// fold must swallow instead of failing the turn.
	const evilArgs = new Proxy(
		{},
		{ ownKeys: () => { throw new Error("boom"); } },
	) as Record<string, unknown>;
	assert.doesNotThrow(() => r.fold(start("invoke_subagent", evilArgs, 1)));
});

test("roster: fallback name and long-detail truncation", () => {
	const r = new SubagentRoster();
	r.fold(start("invoke_subagent", { task: "x".repeat(300) }, 1));
	const [e] = r.snapshot();
	assert.equal(e.name, "subagent");
	assert.equal((e as SubagentEntry).detail.length, 121); // 120 + ellipsis
});

test("formatSubagentRoster: header counts and per-entry lines", () => {
	const r = new SubagentRoster();
	r.fold(start("invoke_subagent", { name: "reviewer", task: "look" }, 1));
	r.fold(start("invoke_subagent", { name: "planner" }, 2));
	r.fold(done("invoke_subagent", 2));
	const out = formatSubagentRoster(r.snapshot());
	assert.match(out, /2 tracked, 1 running/);
	assert.match(out, /reviewer · running ·/);
	assert.match(out, /planner · done ·/);
});

test("formatSubagentRoster: empty roster renders the zero header", () => {
	assert.match(formatSubagentRoster([]), /0 tracked, 0 running/);
});
