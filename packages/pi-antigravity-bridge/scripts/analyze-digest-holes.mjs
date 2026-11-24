// Offline hole-rate analysis: how often does a fresh-conversation handoff
// digest (bound:false) truncate, and how big is the lost span, on REAL pi
// session histories? Pure function, no agy calls, no quota.
//
//   npx tsx scripts/analyze-digest-holes.mjs [--all | --sample N] [--min-chars C]
//
// Reads pi session JSONL trees (~/.pi/agent/sessions), walks each file's
// active branch (leaf chain), and replays the handoff build a fresh agy
// conversation would receive: watermark 0, bound false, trailing user run
// reserved. Reports, per cap level, how many handoffs truncate, the hole
// span (chars between windowStart and deliveredFrom), and token-ish cost
// estimates for what ships.

import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import readline from "node:readline";
import { buildContextDigestResult } from "../src/provider.js";

const args = process.argv.slice(2);
const sampleN = args.includes("--sample") ? Number(args[args.indexOf("--sample") + 1]) : 40;
const useAll = args.includes("--all");
const minChars = args.includes("--min-chars") ? Number(args[args.indexOf("--min-chars") + 1]) : 4000;
const CAPS = [24_000, 60_000, 120_000];

const home = path.join(os.homedir(), ".pi", "agent", "sessions");
function* jsonlFiles(dir) {
	for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
		const p = path.join(dir, e.name);
		if (e.isDirectory()) yield* jsonlFiles(p);
		else if (e.name.endsWith(".jsonl")) yield p;
	}
}

/** Active-branch Message[] from a pi session tree: leaf chain, oldest first.
 *  Streams the file: some sessions exceed Node's max string length. */
async function activeBranch(file) {
	const rl = readline.createInterface({ input: fs.createReadStream(file, { encoding: "utf8" }), crlfDelay: Infinity });
	const meta = new Map(); // id -> {parentId, isMessage, message?}
	const entries = [];
	for await (const line of rl) {
		if (!line) continue;
		let e;
		try {
			e = JSON.parse(line);
		} catch {
			continue;
		}
		entries.push(e);
		meta.set(e.id, e);
	}
	const children = new Set();
	for (const e of entries) {
		if (e.parentId && meta.has(e.parentId)) children.add(e.parentId);
	}
	let leaf = null;
	for (let i = entries.length - 1; i >= 0; i--) {
		if (entries[i].type === "message" && !children.has(entries[i].id)) {
			leaf = entries[i];
			break;
		}
	}
	if (!leaf) return [];
	const chain = [];
	for (let cur = leaf; cur; cur = cur.parentId ? meta.get(cur.parentId) : undefined) {
		if (cur.type === "message") chain.unshift(cur.message);
	}
	return chain;
}

function toDigestMessage(m) {
	// pi-ai Message shape as the provider receives it; provider + toolName
	// ride through for the own-turn skip and toolResult rendering.
	return { ...m };
}

function trailingUserRunStart(messages) {
	let i = messages.length;
	while (i > 0 && messages[i - 1]?.role === "user") i--;
	return i;
}

function contentChars(content) {
	// Text-length accounting: the digest renders text blocks and capped tool
	// args, so image binaries and exotic blocks contribute ~nothing to what
	// would ship. Avoids JSON.stringify blowups on multi-MB sessions.
	if (typeof content === "string") return content.length;
	let n = 0;
	for (const b of content ?? []) {
		if (b && typeof b.text === "string") n += b.text.length;
		else if (b && b.type === "toolCall") n += (b.name?.length ?? 0) + JSON.stringify(b.arguments ?? {}).length;
	}
	return n;
}

function totalChars(messages) {
	let n = 0;
	for (const m of messages) n += contentChars(m.content);
	return n;
}

const files = [];
for (const f of jsonlFiles(home)) {
	const st = fs.statSync(f);
	if (st.size >= minChars) files.push({ f, size: st.size, mtime: st.mtimeMs });
}
files.sort((a, b) => b.mtime - a.mtime);
const selected = useAll ? files : files.slice(0, sampleN);
console.error(`[holes] sessions considered: ${files.length}, analyzing: ${selected.length}`);

const BUCKETS = [
	{ label: "<24k", min: 0, max: 24_000 },
	{ label: "24k-60k", min: 24_000, max: 60_000 },
	{ label: "60k-120k", min: 60_000, max: 120_000 },
	{ label: "120k-1M", min: 120_000, max: 1_000_000 },
	{ label: ">1M", min: 1_000_000, max: Infinity },
];
const buckets = BUCKETS.map((b) => ({ ...b, count: 0 }));
const stats = CAPS.map((cap) => ({ cap, handoffs: 0, holes: 0, holeChars: 0, maxHole: 0, emptyWindows: 0, windowChars: 0, deliveredChars: 0 }));
const skips = { noMessages: 0, wholeIsRun: 0, emptyWindow: 0 };
let biggest = null;
for (const { f } of selected) {
	const messages = await activeBranch(f);
	if (messages.length === 0) {
		skips.noMessages += 1;
		continue;
	}
	const runStart = trailingUserRunStart(messages);
	if (runStart === 0) {
		skips.wholeIsRun += 1;
		continue; // no digest window: whole transcript is the trailing run
	}
	const windowChars = totalChars(messages.slice(0, runStart));
	if (windowChars === 0) {
		skips.emptyWindow += 1;
		continue;
	}
	buckets.find((b) => windowChars >= b.min && windowChars < b.max).count += 1;
	for (let c = 0; c < CAPS.length; c++) {
		const s = stats[c];
		s.handoffs += 1;
		s.windowChars += windowChars;
		const r = buildContextDigestResult(messages, 0, {
			bound: false,
			maxChars: CAPS[c],
			end: runStart,
		});
		if (!r.text) {
			s.emptyWindows += 1;
			continue;
		}
		s.deliveredChars += totalChars(messages.slice(r.deliveredFrom, runStart));
		const hole = totalChars(messages.slice(r.windowStart, r.deliveredFrom));
		if (r.deliveredFrom > r.windowStart) {
			s.holes += 1;
			s.holeChars += hole;
			if (hole > s.maxHole) s.maxHole = hole;
			if (CAPS[c] === 24_000 && (!biggest || hole > biggest.hole)) {
				biggest = { file: path.basename(f), hole, windowChars, msgs: messages.length };
			}
		}
	}
}

console.log(`skips: ${JSON.stringify(skips)}`);
console.log("\nwindow-size buckets (handoffs): " + buckets.map((b) => `${b.label}:${b.count}`).join("  "));
console.log("\ncap      handoffs  holes  hole-rate  mean-hole-chars  max-hole  mean-delivered-share");
for (const s of stats) {
	const rate = s.handoffs ? (s.holes / s.handoffs).toFixed(3) : "n/a";
	const mean = s.holes ? Math.round(s.holeChars / s.holes) : 0;
	const share = s.windowChars ? ((s.deliveredChars / s.windowChars) * 100).toFixed(1) + "%" : "n/a";
	console.log(
		`${String(s.cap).padEnd(8)} ${String(s.handoffs).padEnd(9)} ${String(s.holes).padEnd(6)} ${String(rate).padEnd(10)} ${String(mean).padEnd(16)} ${String(s.maxHole).padEnd(9)} ${share}`,
	);
}
if (biggest) {
	console.log(`\nbiggest 24k hole: ${biggest.hole} chars of ${biggest.windowChars} (${biggest.msgs} msgs) in ${biggest.file}`);
}
