#!/usr/bin/env node
import { writeFileSync } from "node:fs";
// Fake claude for background-mode tests. Emits stream-json events after an
// optional delay, then exits 0. `--version` answers immediately (availability check).
const args = process.argv.slice(2);
if (args.includes("--version")) {
	console.log("claude 1.0.0-fake (Claude Code)");
	process.exit(0);
}
const delay = Number.parseInt(process.env.FAKE_DELAY_MS || "0", 10);
const emit = (o) => process.stdout.write(JSON.stringify(o) + "\n");
// Kill-assertion support: tests read the pid and verify the tree actually died.
if (process.env.FAKE_PIDFILE) {
	writeFileSync(process.env.FAKE_PIDFILE, String(process.pid));
}
emit({ type: "system", subtype: "init", session_id: "11111111-2222-3333-4444-555555555555" });
setTimeout(() => {
	emit({ type: "assistant", message: { content: [{ type: "text", text: "partial thought" }] } });
	emit({
		type: "result",
		subtype: "success",
		is_error: false,
		result: "FAKE ANSWER",
		num_turns: 1,
		usage: { input_tokens: 10, output_tokens: 5, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 },
	});
	process.exit(0);
}, delay);
