#!/usr/bin/env node
// Fake codex for background-mode tests. Emits --json events after an optional
// delay, then exits 0. `--version` answers with a codex-branded string (the
// availability probe requires /codex/i); `models` answers empty (discovery).
const args = process.argv.slice(2);
if (args.includes("--version")) {
	console.log("codex-cli 0.0.0-fake");
	process.exit(0);
}
if (args.includes("models")) {
	process.exit(0);
}
const delay = Number.parseInt(process.env.FAKE_DELAY_MS || "0", 10);
const emit = (o) => process.stdout.write(JSON.stringify(o) + "\n");
emit({ type: "thread.started", thread_id: "99999999-8888-7777-6666-555555555555" });
setTimeout(() => {
	emit({ type: "item.started", item: { type: "command_execution", command: "ls" } });
	emit({ type: "item.completed", item: { type: "agent_message", text: "FAKE CODEX ANSWER" } });
	emit({
		type: "turn.completed",
		usage: { input_tokens: 7, output_tokens: 3, reasoning_output_tokens: 0 },
	});
	process.exit(0);
}, delay);
