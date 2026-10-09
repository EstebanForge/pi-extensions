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
	default:
		process.exit(9);
}
