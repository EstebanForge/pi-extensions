// Live handoff smoke (live parity): proves through the REAL
// provider + REAL engine what the issue-25 unit suite pins with fakes.
//
//   1. Backlog handoff (the mohwald repro): the FIRST bridge turn after
//      switching into the model carries the pre-switch backlog as a
//      bound:false digest into a fresh conversation - the needle planted
//      before the switch must be recallable afterwards.
//   2. Model switch keeps the warm session: a second turn on a different
//      model slug reuses the same conversation and stays recallable.
//   3. Cancel then recovery: an aborted turn leaves the binding usable.
//   4. Sync handoff (AGY_HANDOFF=sync): the checkpoint/plan owns
//      continuity - turn 1 rebuilds with the whole transcript as framed
//      history, turn 2 continues warm and ships only the foreign delta,
//      and the record persists the zeroed contract with sync state.
//
//   AGY_ACP_LIVE=1 npx tsx scripts/smoke-handoff.mjs
//
// Gated: AGY_ACP_LIVE=1 (spends quota on ~5 small turns).

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { normalizeContext } from "@earendil-works/pi-ai";
import { AcpDriver } from "../src/acp/driver.js";
import { ToolRoundTrips, createStreamSimple } from "../src/provider.js";
import { SessionStore } from "../src/sessions.js";

if (process.env.AGY_ACP_LIVE !== "1") {
	console.error("refusing to run: set AGY_ACP_LIVE=1 (spends quota)");
	process.exit(1);
}

const model = {
	id: "m-flash",
	name: "Probe Flash",
	api: "agy-bridge",
	provider: "antigravity",
	baseUrl: "agy-bridge://antigravity",
	reasoning: false,
	input: ["text"],
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
};
const modelHydro = { ...model, id: "m-hydro", name: "Probe Hydrogen" };
const zeroUsage = () => ({ input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { total: 0 } });

const user = (content, ts) => ({ role: "user", content, timestamp: ts });
const ownTurn = (text, ts) => ({
	role: "assistant",
	content: [{ type: "text", text }],
	api: "agy-bridge",
	provider: "antigravity",
	model: "m-flash",
	usage: zeroUsage(),
	stopReason: "stop",
	timestamp: ts,
});

// Isolated agent dir (SessionStore never touches real bindings) with the
// digest on and the system prompt off, so scenario 1 exercises exactly the
// fresh-fallback digest shape.
const fakeAgentRoot = fs.mkdtempSync(path.join(os.tmpdir(), "agy-handoff-home-"));
process.env.PI_CODING_AGENT_DIR = path.join(fakeAgentRoot, ".pi", "agent");
process.env.AGY_DIGEST = "1";
process.env.AGY_SYSTEM_PROMPT = "off";

const logs = [];
const driver = new AcpDriver({
	bin: process.env.AGY_BIN || "agy",
	binArgs: ["acp"],
	isolateHome: true,
	log: () => {},
});
const dir = fs.mkdtempSync(path.join(os.tmpdir(), "agy-handoff-"));
const store = new SessionStore(path.join(dir, "sessions.json"));
const streamSimple = createStreamSimple({
	entries: [
		{ id: "m-flash", full: "gemini-3.8-flash" },
		{ id: "m-hydro", full: "gemini-4-hydrogen-medium" },
	],
	store,
	driver,
	acpDriver: driver,
	engine: "acp",
	roundTrips: new ToolRoundTrips(driver),
	log: (event, data, level) => logs.push({ event, data, level }),
});

let clock = Date.now();
async function turn(m, messages, signal, sessionId = "s-1") {
	const ctx = normalizeContext({ messages });
	const stream = streamSimple(m, ctx, { cwd: dir, sessionId, signal });
	const text = [];
	let status = "UNKNOWN";
	let conversationId;
	try {
		for await (const ev of stream) {
			if (ev.type === "text_delta") text.push(ev.delta);
			if (ev.type === "done") {
				const joined = ev.message.content
					.filter((b) => b.type === "text")
					.map((b) => b.text)
					.join("");
				if (joined && !text.length) text.push(joined);
			}
		}
		status = "OK";
	} catch (err) {
		status = err instanceof Error && err.name === "AbortError" ? "ABORTED" : `ERROR:${String(err).slice(0, 120)}`;
	}
	await store.flush();
	const raw = JSON.parse(fs.readFileSync(path.join(dir, "sessions.json"), "utf8"));
	conversationId = Object.values(raw)[0]?.conversationId;
	clock += 1000;
	return { text: text.join(""), conversationId, status };
}

const results = [];
const check = (name, pass, note = "") => {
	results.push({ check: name, pass, note });
	console.log(`[smoke] ${pass ? "PASS" : "FAIL"} ${name}${note ? ` — ${note}` : ""}`);
};

// --- Scenario 1: backlog handoff on the first bridge turn -------------------
const CODE = "AMBER-7-7-3-4";
// Backlog that predates the switch (as if the user ran these on another
// provider), then the first bridge turn's question.
const t1 = await turn(model, [
	user(`Session prep: the access code for later is ${CODE}. Confirm by replying with just: staged`, clock + 1),
	ownTurn("staged", clock + 2),
	user(`Use the access code from the session prep above. Reply with ONLY the code now.`, clock + 3),
]);
check("turn1 (first bridge turn) completed", t1.status === "OK" && t1.text.includes(CODE), `status=${t1.status} reply=${JSON.stringify(t1.text.slice(0, 60))}`);
const digestDrops = logs.filter((l) => l.event === "digest" && l.data?.shipped === false);
check("no digest was dropped on turn1", digestDrops.length === 0, JSON.stringify(digestDrops));

// --- Scenario 2: model switch keeps the warm session ------------------------
const convAfterT1 = t1.conversationId;
const t2 = await turn(modelHydro, [
	user(`Session prep: the access code for later is ${CODE}. Confirm by replying with just: staged`, clock + 4),
	ownTurn("staged", clock + 5),
	user("Use the access code from the session prep above. Reply with ONLY the code now.", clock + 6),
	ownTurn(CODE, clock + 7),
	user("Switching models now. Reply with just: switched", clock + 8),
]);
check("turn2 (model switch) completed", t2.status === "OK" && t2.text.includes("switched"));
check(
	"model switch kept the same conversation",
	!!convAfterT1 && t2.conversationId === convAfterT1,
	`conv=${t2.conversationId}`,
);

// --- Scenario 3: cancel then recovery ---------------------------------------
const controller = new AbortController();
setTimeout(() => controller.abort(), 2500).unref();
const t3 = await turn(
	modelHydro,
	[
		user(`Session prep: the access code for later is ${CODE}. Confirm by replying with just: staged`, clock + 9),
		ownTurn("staged", clock + 10),
		user("Use the access code from the session prep above. Reply with ONLY the code now.", clock + 11),
		ownTurn(CODE, clock + 12),
		user("Count slowly from 1 to 60, one number per line, then reply done.", clock + 13),
	],
	controller.signal,
);
check("turn3 aborted cleanly", t3.status === "ABORTED" || t3.status === "OK", `status=${t3.status}`);

const t4 = await turn(modelHydro, [
	user(`Session prep: the access code for later is ${CODE}. Confirm by replying with just: staged`, clock + 14),
	ownTurn("staged", clock + 15),
	user("Use the access code from the session prep above. Reply with ONLY the code now.", clock + 16),
	ownTurn(CODE, clock + 17),
	user("Count slowly from 1 to 60, one number per line, then reply done.", clock + 18),
	user("Cancelled turns happen. Ignore the counting request and reply with just: recovered", clock + 19),
]);
check("turn4 recovered after the cancel", t4.status === "OK" && t4.text.includes("recovered"), `status=${t4.status}`);

// --- Scenario 4: sync handoff (checkpoint/plan owns continuity) -------------
process.env.AGY_HANDOFF = "sync";
const SDELTA = "DELTA-5-5-5";
// Turn 1 over session "s-sync" (no stored record): the plan is a rebuild,
// the whole backlog ships as framed history, and the needle planted BEFORE
// the first bridge turn must be recallable from the fresh conversation.
const s1 = await turn(
	model,
	[
		user(`Session prep: the access code for later is ${CODE}. Confirm by replying with just: staged`, clock + 20),
		ownTurn("staged", clock + 21),
		user("Use the access code from the session prep above. Reply with ONLY the code now.", clock + 22),
	],
	undefined,
	"s-sync",
);
check("sync turn1 (rebuild) completed with backlog recall", s1.status === "OK" && s1.text.includes(CODE), `status=${s1.status} reply=${JSON.stringify(s1.text.slice(0, 60))}`);
const syncPlan1 = logs.filter((l) => l.event === "sync-plan" && l.data?.kind === "rebuild");
check("sync turn1 planned a rebuild", syncPlan1.length >= 1);

// Turn 2: the transcript grew FOREIGN-provider turns (another model ran in
// between) plus a new user question. The plan must be a warm continue that
// ships ONLY the delta - the needle lives exclusively in the delta, so
// recall proves the framed history reached the warm conversation.
const s2 = await turn(
	model,
	[
		user(`Session prep: the access code for later is ${CODE}. Confirm by replying with just: staged`, clock + 23),
		ownTurn("staged", clock + 24),
		user("Use the access code from the session prep above. Reply with ONLY the code now.", clock + 25),
		ownTurn(s1.text.trim() || CODE, clock + 26),
		user(`Another model ran meanwhile. Memorize the word ${SDELTA}, then answer its filler question: reply teal.`, clock + 27),
		ownTurn("teal", clock + 28),
		user("What was the memorized word from the color step? Reply with ONLY the word.", clock + 29),
	],
	undefined,
	"s-sync",
);
check("sync turn2 (warm continue) recalled the delta needle", s2.status === "OK" && s2.text.includes(SDELTA), `status=${s2.status} reply=${JSON.stringify(s2.text.slice(0, 60))}`);
check("sync turn2 kept the warm conversation", !!s1.conversationId && s2.conversationId === s1.conversationId, `conv=${s2.conversationId}`);
const syncPlan2 = logs.filter((l) => l.event === "sync-plan" && l.data?.kind === "continue");
check("sync turn2 planned a continue", syncPlan2.length >= 1);
const syncSettles = logs.filter((l) => l.event === "sync-settle" && l.data?.settled === "terminal");
check("sync settles checkpointed", syncSettles.length >= 2, JSON.stringify(syncSettles.map((l) => l.data?.reason ?? "terminal")));
const syncRaw = JSON.parse(fs.readFileSync(path.join(dir, "sessions.json"), "utf8"));
const syncRec = Object.entries(syncRaw).find(([k]) => k.startsWith("sid:s-sync"))?.[1];
check(
	"sync record holds the zeroed contract with sync state",
	!!syncRec && syncRec.lastMessageCount === 0 && !!syncRec.sync?.checkpoint && !!syncRec.conversationId,
	`count=${syncRec?.lastMessageCount} checkpoint=${!!syncRec?.sync?.checkpoint} conv=${syncRec?.conversationId}`,
);

console.log(`\n[smoke] ${results.filter((r) => r.pass).length}/${results.length} checks passed`);
console.log("[smoke] sync events:", JSON.stringify(logs.filter((l) => l.event.startsWith("sync")), null, 1));
await driver.close("shutdown");
fs.rmSync(dir, { recursive: true, force: true });
fs.rmSync(fakeAgentRoot, { recursive: true, force: true });
process.exit(results.every((r) => r.pass) ? 0 : 1);
