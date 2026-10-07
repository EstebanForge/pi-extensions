#!/usr/bin/env node
// Fake agy for background-mode tests. Plain-text stdout after an optional
// delay, then exit 0. `models` answers empty (discovery failure is non-fatal).
const args = process.argv.slice(2);
if (args.includes("models")) {
	process.exit(0);
}
const delay = Number.parseInt(process.env.FAKE_DELAY_MS || "0", 10);
setTimeout(() => {
	process.stdout.write("FAKE AGY OUTPUT\n");
	process.exit(0);
}, delay);
