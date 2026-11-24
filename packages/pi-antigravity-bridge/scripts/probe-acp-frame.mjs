// Live probe: how large an OUTBOUND session/prompt frame does the ACP
// transport actually accept? MAX_FRAME_BYTES (32 MiB) is only our inbound
// line-buffer cap; nothing proves the engine accepts outbound frames that
// large. Escalating ladder 1 -> 4 -> 16 MiB (AGY_PROBE_FRAME_SIZES to
// override, comma-separated MiB values).
//
//   AGY_ACP_LIVE=1 npx tsx scripts/probe-acp-frame.mjs
//
// Classification per size:
//   ok          - turn completed; the model read the block
//   semantic    - the transport delivered it and the ENGINE rejected it
//                 (context length, quota, ...) - a graceful refusal
//   transport   - the frame itself failed (EPIPE, JSON/protocol error,
//                 timeout) - the size ceiling this probe looks for
// Exit 0 when no size hit the transport class.

import { AcpDriver } from "../src/acp/driver.js";

if (process.env.AGY_ACP_LIVE !== "1") {
	console.error("refusing to run: set AGY_ACP_LIVE=1 (spends quota)");
	process.exit(1);
}

const bin = process.env.AGY_BIN || "agy";
const SIZES_MIB = (process.env.AGY_PROBE_FRAME_SIZES || "1,4,16").split(",").map((s) => Number(s.trim()));
const NEEDLE = "FRAME-NEEDLE-c81e4d";

const TRANSPORT_MARKERS = ["EPIPE", "ECONNRESET", "parse error", "invalid json", "frame", "timeout", "inactivity", "closed"];
const SEMANTIC_MARKERS = ["exceed", "too long", "context", "token", "resource_exhausted", "quota", "invalid argument", "length"];

const filler = "Rack inventory: torque spec, lacing gauge, fan curve, ledger delta. ";
function buildBlock(targetBytes) {
	const unit = Buffer.byteLength(filler, "utf8");
	const parts = [`Probe header. Needle: ${NEEDLE}. `];
	let bytes = Buffer.byteLength(parts[0], "utf8");
	while (bytes < targetBytes - unit) {
		parts.push(filler);
		bytes += unit;
	}
	parts.push(`Final needle: ${NEEDLE}.`);
	return parts.join("");
}

const driver = new AcpDriver({
	bin,
	binArgs: ["acp"],
	isolateHome: true,
	log: (msg, data) => console.error(`[acp] ${msg}${data !== undefined ? " " + JSON.stringify(data) : ""}`),
});

const results = [];
for (const mib of SIZES_MIB) {
	const target = mib * 1024 * 1024;
	const contextText = buildBlock(target);
	const bytes = Buffer.byteLength(contextText, "utf8");
	console.log(`[probe] size=${mib}MiB chars=${contextText.length} bytes=${bytes}`);
	let verdict = "transport";
	let detail = "";
	try {
		const handle = await driver.run({
			cwd: process.cwd(),
			model: "gemini-4-hydrogen-medium",
			effort: "low",
			mode: "accept-edits",
			skipPermissions: true,
			prompt:
				"A reference document follows as an embedded resource. Read it, then answer with ONLY the exact needle string it contains. No tools.",
			contextBlock: { uri: "urn:pi-bridge:probe/frame", text: contextText },
			signal: AbortSignal.timeout(8 * 60_000),
			timeoutMin: 8,
			inactivityMin: 6,
		});
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
		detail = `status=${outcome.status} reply=${JSON.stringify(joined.slice(0, 120))} usage=${JSON.stringify(outcome.usage ?? null)}`;
		if (outcome.status === "OK") {
			verdict = "ok";
		} else {
			const msg = String(outcome.error ?? joined).toLowerCase();
			verdict = SEMANTIC_MARKERS.some((m) => msg.includes(m)) ? "semantic" : "transport";
		}
	} catch (err) {
		const msg = String(err instanceof Error ? err.message : err);
		detail = msg.slice(0, 200);
		verdict = TRANSPORT_MARKERS.some((m) => msg.toLowerCase().includes(m)) ? "transport" : "semantic";
	}
	console.log(`[probe] size=${mib}MiB verdict=${verdict} ${detail}`);
	results.push({ mib, bytes, verdict });
	if (verdict === "transport") break; // found the ceiling; stop escalating
}

await driver.close("shutdown");
console.log(`[probe] REPORT ${JSON.stringify(results, null, 2)}`);
process.exit(results.some((r) => r.verdict === "transport") ? 1 : 0);
