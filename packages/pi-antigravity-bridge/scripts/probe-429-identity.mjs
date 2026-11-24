// Live probe: does pi's default leading identity sentence (or pi's codemode
// docs-index entry) trigger RESOURCE_EXHAUSTED 429 on current agy? An
// independent bridge build replaces/strips exactly these strings, but our
// earlier probe (scripts/probe-sysprompt-429.mjs, agy 1.5.12) could not
// reproduce any 429 with a synthetic carrier body. This probe sends those
// EXACT trigger strings, one factor per turn, with a control.
//
//   AGY_ACP_LIVE=1 npx tsx scripts/probe-429-identity.mjs
//
// Three tiny fresh-conversation ACP turns on the default model, effort low:
//   A  control: plain task, no trigger strings
//   B  exact pi default identity sentence leading the prompt
//   C  identity sentence + a pi-shaped codemode docs-index entry

import { AcpDriver } from "../src/acp/driver.js";

if (process.env.AGY_ACP_LIVE !== "1") {
	console.error("refusing to run: set AGY_ACP_LIVE=1 (spends quota)");
	process.exit(1);
}

const IDENTITY =
	"You are a coding assistant running inside pi, a coding agent harness.";
const CODEMODE_DOCS = `[docs]
- codemode: run JS against loaded tools with tools.<name>(...). Index of callable namespaces: tools.bash, tools.read, tools.edit, tools.grep. Call tools.codemode({code}) to execute.[/docs]`;

const variants = [
	{ id: "A-control", prompt: "Reply with the single word: ok" },
	{ id: "B-identity", prompt: `${IDENTITY}\n\nReply with the single word: ok` },
	{ id: "C-identity-docs", prompt: `${IDENTITY}\n\n${CODEMODE_DOCS}\n\nReply with the single word: ok` },
];

const driver = new AcpDriver({
	bin: process.env.AGY_BIN || "agy",
	binArgs: ["acp"],
	isolateHome: true,
	log: () => {},
});

let failure = false;
for (const v of variants) {
	const controller = new AbortController();
	let out = "";
	const handle = await driver.run({
		cwd: process.cwd(),
		model: "gemini-4-hydrogen-medium",
		effort: "low",
		mode: "accept-edits",
		skipPermissions: true,
		prompt: v.prompt,
		signal: controller.signal,
		timeoutMin: 4,
		inactivityMin: 3,
	});
	const collecting = (async () => {
		for (;;) {
			const activity = await handle.next();
			if (activity === null) return;
			if (activity.type === "text") out += activity.delta;
			if (activity.type === "error") out += ` [error:${JSON.stringify(activity.error).slice(0, 200)}]`;
		}
	})();
	const outcome = await handle.outcome;
	await collecting;
	const bad = outcome.status !== "OK" || /429|RESOURCE_EXHAUSTED|exhausted/i.test(out + JSON.stringify(outcome.error ?? ""));
	if (bad) failure = true;
	console.log(
		`[probe] ${v.id}: status=${outcome.status} 429ish=${bad} usage=${outcome.usage?.total_tokens ?? "?"} reply=${JSON.stringify(out.slice(0, 60))}`,
	);
}

await driver.close("shutdown");
console.log(failure ? "[probe] VERDICT: a trigger variant failed - inspect above" : "[probe] VERDICT: no 429 reproduced on this agy version");
process.exit(failure ? 1 : 0);
