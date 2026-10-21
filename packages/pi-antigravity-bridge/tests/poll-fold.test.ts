// Unit tests for the bridge_poll_result display fold: consecutive poll
// events collapse into ONE counted transcript entry instead of flooding it
// (observed live 2026-10-21: 60 "Poll git_commit" entries from one wait).

import { describe, test } from "vitest";
import assert from "node:assert/strict";
import { PollRunFolder } from "../src/poll-fold.js";

const at = (iso: string) => new Date(iso);

describe("poll-fold", () => {
	test("folds consecutive polls of one target into a single counted run", () => {
		const f = new PollRunFolder();
		assert.ok(f.open === undefined);
		assert.equal(f.add("git_commit", "running", at("2026-10-21T16:07:20Z")), undefined);
		assert.equal(f.add("git_commit", "running", at("2026-10-21T16:07:50Z")), undefined);
		assert.equal(f.add("git_commit", "running", at("2026-10-21T16:08:30Z")), undefined);
		assert.deepEqual(f.flush(), {
			target: "git_commit",
			count: 3,
			state: "running",
			firstAt: "2026-10-21T16:07:20.000Z",
			lastAt: "2026-10-21T16:08:30.000Z",
		});
	});

	test("a target switch closes the open run and folds the new target", () => {
		const f = new PollRunFolder();
		f.add("git_commit", "running", at("2026-10-21T16:07:20Z"));
		f.add("git_commit", "done", at("2026-10-21T16:08:00Z"));
		const closed = f.add("ask_user_question", "done", at("2026-10-21T16:09:00Z"));
		assert.deepEqual(closed, {
			target: "git_commit",
			count: 2,
			state: "done",
			firstAt: "2026-10-21T16:07:20.000Z",
			lastAt: "2026-10-21T16:08:00.000Z",
		});
		assert.deepEqual(f.flush(), {
			target: "ask_user_question",
			count: 1,
			state: "done",
			firstAt: "2026-10-21T16:09:00.000Z",
			lastAt: "2026-10-21T16:09:00.000Z",
		});
	});

	test("terminal states stick: running after done does not downgrade, failed wins", () => {
		const f = new PollRunFolder();
		f.add("read", "done", at("2026-10-21T16:00:00Z"));
		f.add("read", "running", at("2026-10-21T16:00:10Z"));
		assert.equal(f.open?.state, "done");
		f.add("read", "failed", at("2026-10-21T16:00:20Z"));
		assert.equal(f.open?.state, "failed");
		f.add("read", "running", at("2026-10-21T16:00:30Z"));
		assert.equal(f.open?.state, "failed");
	});

	test("flush is idempotent and open exposes the live run for the status line", () => {
		const f = new PollRunFolder();
		assert.equal(f.flush(), undefined);
		f.add("git_commit", "running", at("2026-10-21T16:07:20Z"));
		// Fresh getter read: TS property narrowing from an earlier assert on
		// f.open survives the f.add() call, so assert the property only after
		// this point.
		const open = f.open;
		assert.ok(open);
		assert.equal(open.count, 1);
		assert.equal(open.target, "git_commit");
		assert.ok(f.flush());
		assert.equal(f.flush(), undefined);
		assert.ok(f.open === undefined);
	});

	test("unresolvable-target polls fold together under their fallback label", () => {
		const f = new PollRunFolder();
		f.add("unknown call", "failed", at("2026-10-21T16:00:00Z"));
		f.add("unknown call", "failed", at("2026-10-21T16:00:05Z"));
		const run = f.flush();
		assert.equal(run?.count, 2);
		assert.equal(run?.state, "failed");
	});
});
