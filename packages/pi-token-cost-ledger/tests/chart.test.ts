import { afterEach, describe, expect, it } from "vitest";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync, existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { tmpdir } from "node:os";
import { spawnSync } from "node:child_process";
import factory from "../extensions/index.js";

// Exercises /token-usage chart end-to-end through the real factory + handler.
// Each test isolates the ledger to a fresh temp dir (PI_COST_LEDGER) so the
// real ledger is never touched. PNG assertions are conditional on a converter
// being on PATH (absent in CI is fine — those branches self-skip).

const pad = (n: number) => String(n).padStart(2, "0");

function localDay(offset: number): Date {
	const now = new Date();
	const d = new Date(now.getFullYear(), now.getMonth(), now.getDate());
	d.setDate(d.getDate() - offset);
	return d;
}

function writeDay(root: string, date: Date, lines: string[]): void {
	const p = join(root, String(date.getFullYear()), pad(date.getMonth() + 1), pad(date.getDate()) + ".jsonl");
	mkdirSync(dirname(p), { recursive: true });
	writeFileSync(p, lines.join("\n") + "\n");
}

function rec(ts: number, provider: string, model: string, tok: number): string {
	return JSON.stringify({
		ts,
		provider,
		model,
		tokens: { input: tok, output: 0, cacheRead: 0, cacheWrite: 0 },
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
	});
}

/** Narrow pi mock: only the documented surface is allowed; any other property
 *  access throws so a future refactor that calls a new pi method fails loudly. */
function makePi(commands: Record<string, (a: string, c: any) => Promise<void>>): any {
	const known = {
		registerFlag: () => {},
		on: () => {},
		getFlag: () => undefined,
		registerCommand: (name: string, def: any) => {
			if (def?.handler) commands[name] = def.handler;
		},
	};
	return new Proxy(known, {
		get(t, p) {
			if (p in t) return (t as any)[p];
			throw new Error(`unexpected pi.${String(p)} access in test mock`);
		},
	});
}

function hasConverter(): boolean {
	for (const bin of ["rsvg-convert", "inkscape"]) {
		if (spawnSync(bin, ["--version"], { timeout: 5000 }).status === 0) return true;
	}
	return false;
}

describe("/token-usage chart", () => {
	const prevLedger = process.env.PI_COST_LEDGER;
	const roots: string[] = [];

	afterEach(() => {
		if (prevLedger === undefined) delete process.env.PI_COST_LEDGER;
		else process.env.PI_COST_LEDGER = prevLedger;
		for (const r of roots.splice(0)) rmSync(r, { recursive: true, force: true });
	});

	it("renders an SVG dashboard with per-model + unified charts (ranged window)", async () => {
		const root = mkdtempSync(join(tmpdir(), "tcl-chart-"));
		roots.push(root);
		process.env.PI_COST_LEDGER = root;
		writeDay(root, localDay(0), [
			rec(localDay(0).getTime() + 1000, "zai", "glm-5.2", 1_000_000),
			rec(localDay(0).getTime() + 2000, "minimax", "MiniMax-M3", 500_000),
		]);
		writeDay(root, localDay(3), [rec(localDay(3).getTime() + 1000, "zai", "glm-5.2", 2_000_000)]);

		const commands: Record<string, (a: string, c: any) => Promise<void>> = {};
		await factory(makePi(commands));
		const captured: string[] = [];
		const ctx = { mode: "tui", ui: { notify: (m: string) => void captured.push(m) }, reload: async () => {} };

		await commands["token-usage"]("chart days 7", ctx);

		const notify = captured.join("\n");
		expect(notify).toMatch(/Chart: .*\.svg/);
		const svgPath = notify.match(/Chart: (.*\.svg)/)![1];
		const svg = readFileSync(svgPath, "utf8");
		expect(svg).toContain("<svg");
		expect(svg).toContain("Token usage");
		expect(svg).toContain("By model");
		expect(svg).toContain("Total (all models combined)");
		// 7-day window → dates.length=7 > 1 → polyline path (not the n===1 circle).
		// 2 model lines + 1 unified line = 3 polylines.
		expect((svg.match(/<polyline/g) || []).length).toBe(3);
		expect(svg).toContain("Total Token Consumption");
		// KPI box 3 = 2nd most-used model (MiniMax-M3, 500k), NOT the top provider.
		// glm-5.2 (3M) is top; MiniMax-M3 (500k) is 2nd.
		expect(svg).toContain("glm-5.2 Consumption");
		expect(svg).toContain("MiniMax-M3 Consumption");
	});

	it("emits a friendly empty state when the period has no records", async () => {
		const root = mkdtempSync(join(tmpdir(), "tcl-empty-"));
		roots.push(root);
		process.env.PI_COST_LEDGER = root; // no fixture files → zero records

		const commands: Record<string, (a: string, c: any) => Promise<void>> = {};
		await factory(makePi(commands));
		const captured: string[] = [];
		const ctx = { mode: "tui", ui: { notify: (m: string) => void captured.push(m) }, reload: async () => {} };

		await commands["token-usage"]("chart days 7", ctx);

		const svgPath = captured.join("\n").match(/Chart: (.*\.svg)/)![1];
		const svg = readFileSync(svgPath, "utf8");
		// Early-return path: no charts, just the empty-state message. Guards a
		// regression where the empty path would emit NaN coords.
		expect(svg).toContain("No usage recorded for this period.");
		expect(svg).not.toContain("<polyline");
		expect(svg).not.toContain("<polygon");
	});

	it("uses the sparse dateList=null path for `chart all`", async () => {
		const root = mkdtempSync(join(tmpdir(), "tcl-all-"));
		roots.push(root);
		process.env.PI_COST_LEDGER = root;
		// Records on 3 distinct days (not contiguous) → `all` collects exactly
		// those days, no zero-filled gaps (the ranged-path behavior).
		writeDay(root, localDay(1), [rec(localDay(1).getTime() + 1, "zai", "glm-5.2", 100_000)]);
		writeDay(root, localDay(5), [rec(localDay(5).getTime() + 1, "zai", "glm-5.2", 200_000)]);
		writeDay(root, localDay(10), [rec(localDay(10).getTime() + 1, "zai", "glm-5.2", 300_000)]);

		const commands: Record<string, (a: string, c: any) => Promise<void>> = {};
		await factory(makePi(commands));
		const captured: string[] = [];
		const ctx = { mode: "tui", ui: { notify: (m: string) => void captured.push(m) }, reload: async () => {} };

		await commands["token-usage"]("chart all", ctx);

		const notify = captured.join("\n");
		const svgPath = notify.match(/Chart: (.*\.svg)/)![1];
		const svg = readFileSync(svgPath, "utf8");
		expect(svg).toContain("all history"); // range.label for the `all` sentinel
		expect(svg).toContain("<polyline");
	});

	const pngIt = hasConverter() ? it : it.skip;
	pngIt("emits a PNG alongside the SVG when a converter is on PATH", async () => {
		const root = mkdtempSync(join(tmpdir(), "tcl-png-"));
		roots.push(root);
		process.env.PI_COST_LEDGER = root;
		writeDay(root, localDay(0), [rec(localDay(0).getTime() + 1, "zai", "glm-5.2", 1_000_000)]);

		const commands: Record<string, (a: string, c: any) => Promise<void>> = {};
		await factory(makePi(commands));
		const captured: string[] = [];
		const ctx = { mode: "tui", ui: { notify: (m: string) => void captured.push(m) }, reload: async () => {} };

		await commands["token-usage"]("chart days 7", ctx);

		const notify = captured.join("\n");
		expect(notify).toMatch(/PNG : .*\.png/);
		const pngPath = notify.match(/PNG: (.*\.png)/)?.[1] ?? notify.match(/PNG : (.*\.png)/)![1];
		expect(existsSync(pngPath)).toBe(true);
		// PNG must be a real raster, not a zero-byte stub — a failed render that
		// touched the file would still exist but be tiny/empty.
		expect(statSize(pngPath)).toBeGreaterThan(1000);
	});
});

function statSize(p: string): number {
	return readFileSync(p).length;
}
