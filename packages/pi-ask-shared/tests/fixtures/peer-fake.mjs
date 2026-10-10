// Fake peer CLI for run.ts characterization tests. Invoked as
// `node peer-fake.mjs <mode> [arg]` with process.execPath as the binary.
import fs from "node:fs";

const mode = process.argv[2];
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// Synchronous fd-1 writes: bytes are in the kernel pipe before exit(), so
// any loss downstream is the parent failing to drain, not the child.
const writeSync1 = (s) => fs.writeSync(1, s);

switch (mode) {
	case "lines": {
		const n = Number(process.argv[3] ?? 3);
		let out = "";
		for (let i = 1; i <= n; i++) out += `line-${i}\n`;
		writeSync1(out);
		process.exit(0);
	}
	case "stream-delay": {
		process.stdout.write("early\n");
		await sleep(50);
		process.stdout.write("trailing-no-newline");
		process.exit(0);
	}
	case "raw": {
		process.stdout.write("raw output ");
		await sleep(20);
		process.stdout.write("continues");
		process.exit(0);
	}
	case "stdin-echo": {
		const chunks = [];
		for await (const c of process.stdin) chunks.push(c);
		const bytes = Buffer.concat(chunks).length;
		process.stdout.write(`GOT:${bytes}\n`);
		process.exit(0);
	}
	case "stdin-no-read":
		process.exit(0);
	case "hang": {
		await sleep(Number(process.argv[3] ?? 5000));
		process.exit(0);
	}
	case "stderr-flood": {
		process.stderr.write("e".repeat(100_000));
		process.exit(0);
	}
	case "big-line": {
		writeSync1("x".repeat(Number(process.argv[3] ?? 1_100_000)));
		process.exit(0);
	}
	case "exit-code":
		process.exit(Number(process.argv[3] ?? 3));
	// Emits the real claude stream-json event grammar (init, assistant text,
	// result) with ANSI noise around the answer, reading the prompt from stdin.
	case "claude-consult": {
		const chunks = [];
		for await (const c of process.stdin) chunks.push(c);
		const prompt = Buffer.concat(chunks).toString();
		if (process.env.FAKE_PROMPTFILE) fs.writeFileSync(process.env.FAKE_PROMPTFILE, prompt);
		if (!prompt.trim()) {
			process.stderr.write("no prompt on stdin\n");
			process.exit(4);
		}
		const events = [
			{ type: "system", subtype: "init", session_id: "11111111-2222-3333-4444-555555555555" },
			{ type: "assistant", message: { role: "assistant", content: [{ type: "text", text: "\x1b[2mthinking\x1b[0m" }] } },
			{ type: "result", subtype: "success", session_id: "11111111-2222-3333-4444-555555555555", result: "\x1b[32mREVIEW VERDICT\x1b[0m: ship it", is_error: false, num_turns: 2, total_cost_usd: 0.01 },
		];
		writeSync1(events.map((e) => JSON.stringify(e)).join("\n") + "\n");
		process.exit(0);
	}
	// Emits the real codex exec --json grammar (thread.started, agent_message),
	// asserting the prompt arrived as the trailing positional argv item, with
	// the time-budget notice allowed as a suffix appended by the consult core.
	case "codex-consult": {
		const prompt = process.argv[process.argv.length - 1] ?? "";
		if (process.env.FAKE_PROMPTFILE) fs.writeFileSync(process.env.FAKE_PROMPTFILE, prompt);
		if (!prompt.startsWith("review this diff")) {
			process.stderr.write(`bad positional: ${prompt}\n`);
			process.exit(4);
		}
		const events = [
			{ type: "thread.started", thread_id: "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee" },
			{ type: "item.completed", item: { type: "agent_message", text: "codex says: LGTM" } },
		];
		writeSync1(events.map((e) => JSON.stringify(e)).join("\n") + "\n");
		process.exit(0);
	}
	// Records the trailing positional (the agy prompt) to argv[3] as a file, so
	// tests can assert what the peer actually received.
	case "promptdump": {
		fs.writeFileSync(process.argv[3], process.argv[process.argv.length - 1]);
		writeSync1("ok\n");
		process.exit(0);
	}
	// Raw stdout with ANSI SGR + OSC sequences and CRLF noise.
	case "ansi": {
		writeSync1("\x1b[?25l\x1b[31mverdict\x1b[0m: \x1b]0;title\x07go\r\n");
		process.exit(0);
	}
	default:
		process.exit(9);
}
