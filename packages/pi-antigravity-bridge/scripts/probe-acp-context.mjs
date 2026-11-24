// Live probe: does the ACP embeddedContext resource block survive and stay
// readable past the sizes the digest cap assumes? Gated: AGY_ACP_LIVE=1
// (spends quota on a real inference).
//
//   AGY_ACP_LIVE=1 npx tsx scripts/probe-acp-context.mjs
//
// Sends one ~120k-char embeddedContext block carrying three recall needles
// (start / middle / end), asks the model for the END needle, then follows up
// on the same conversation asking for the START needle. Turn 1 proves the
// transport accepts and the model reads a >100k block; turn 2 proves the
// block persisted into the conversation's history rather than being read
// once and discarded. Output drives the DIGEST_MAX_CHARS raise decision
// (8k -> 24k) and bounds the fresh-fallback digest size.

import { AcpDriver } from "../src/acp/driver.js";

if (process.env.AGY_ACP_LIVE !== "1") {
	console.error("refusing to run: set AGY_ACP_LIVE=1 (spends quota)");
	process.exit(1);
}

const bin = process.env.AGY_BIN || "agy";
const TARGET_CHARS = Number(process.env.AGY_PROBE_CHARS || 120_000);
const NEEDLE_START = "NEEDLE-START-7f3a91";
const NEEDLE_MID = "NEEDLE-MID-2b94cd";
const NEEDLE_END = "NEEDLE-END-d41e08";

const filler = "The supply ledger lists bolt torque, cable lacing, and fan curves per rack. ";
const blocks = [];
let size = 0;
const mid = Math.floor(TARGET_CHARS / 2);
const end = TARGET_CHARS - 400;
while (size < TARGET_CHARS) {
	if (size < 400) blocks.push(`CONTEXT HEADER. First needle: ${NEEDLE_START}. `);
	else if (size >= mid - 400 && size < mid) blocks.push(`Middle needle: ${NEEDLE_MID}. `);
	else if (size >= end) blocks.push(`Final needle: ${NEEDLE_END}. `);
	blocks.push(filler);
	size = blocks.join("").length;
}
const contextText = blocks.join("");
console.log(`[probe] context: ${contextText.length} chars, ${Buffer.byteLength(contextText, "utf8")} bytes`);

const driver = new AcpDriver({
	bin,
	binArgs: ["acp"],
	isolateHome: true,
	log: (msg, data) => console.error(`[acp] ${msg}${data !== undefined ? " " + JSON.stringify(data) : ""}`),
});

const controller = new AbortController();
async function drain(handle, label) {
	const text = [];
	const collecting = (async () => {
		for (;;) {
			const activity = await handle.next();
			if (activity === null) return;
			if (activity.type === "text") text.push(activity.delta);
		}
	})();
	const outcome = await handle.outcome;
	await collecting;
	const joined = text.join("");
	console.log(
		`[probe] ${label}: status=${outcome.status} usage=${JSON.stringify(outcome.usage ?? null)}`,
	);
	console.log(`[probe] ${label} reply: ${joined.slice(0, 600)}`);
	return { outcome, joined };
}

const t1 = await drain(
	await driver.run({
		cwd: process.cwd(),
		model: "gemini-4-hydrogen-medium",
		effort: "low",
		mode: "accept-edits",
		skipPermissions: true,
		prompt:
			"A reference document follows as an embedded resource. Read it, then answer with ONLY the exact final needle string it contains. No tools.",
		contextBlock: { uri: "urn:pi-bridge:probe/context", text: contextText },
		signal: controller.signal,
		timeoutMin: 6,
		inactivityMin: 4,
	}),
	"turn1-end-recall",
);

const t2 = await drain(
	await driver.run({
		cwd: process.cwd(),
		model: "gemini-4-hydrogen-medium",
		effort: "low",
		mode: "accept-edits",
		skipPermissions: true,
		conversationId: t1.outcome.conversationId,
		prompt:
			"From the reference document you read last turn, answer with ONLY the exact first needle string it contains. No tools.",
		signal: controller.signal,
		timeoutMin: 4,
		inactivityMin: 3,
	}),
	"turn2-start-recall",
);

await driver.close("shutdown");

const report = {
	chars: contextText.length,
	bytes: Buffer.byteLength(contextText, "utf8"),
	turn1Status: t1.outcome.status,
	turn1EndRecall: t1.joined.includes(NEEDLE_END),
	turn1Usage: t1.outcome.usage ?? null,
	turn1Conversation: t1.outcome.conversationId ?? null,
	turn2Status: t2.outcome.status,
	turn2StartRecall: t2.joined.includes(NEEDLE_START),
	turn2Usage: t2.outcome.usage ?? null,
};
console.log(`[probe] REPORT ${JSON.stringify(report, null, 2)}`);
process.exit(report.turn1Status === "OK" && report.turn2Status === "OK" ? 0 : 1);
