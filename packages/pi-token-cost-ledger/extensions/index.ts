/**
 * pi-token-cost-ledger — Token & cost ledger for Pi.
 *
 * One extension replaces the former 3-part setup (@ctogg/pi-cost-counter +
 * api-equiv.sh + tokens.zsh). Owns the full lifecycle:
 *
 *   1. CAPTURE — forks @ctogg's message_end hook. Appends one JSONL record
 *      per assistant message to ~/.pi/extensions-data/estebanforge/pi-token-cost-ledger/YYYY/MM/DD.jsonl.
 *      Format is byte-compatible with the existing ledger, so ~20 prior
 *      files are valid day one (zero migration).
 *   2. QUERY   — /token-usage command. Periods: today | day | week | month |
 *      year | all, plus `model <name>`. Shows BOTH real USD (from the
 *      provider's own cost) AND api-equivalent USD (what the same tokens
 *      cost pay-as-you-go on GLM), because on a flat plan the marginal
 *      cost is $0 and only the API-equiv axis is comparable across vendors.
 *
 * Prices are query-time computed (reprice semantics): history always
 * reflects the current prices.json, never a stale snapshot. The default
 * prices ship as a sibling asset; ~/.pi/extensions-data/estebanforge/pi-token-cost-ledger/prices.json overrides
 * if present (preserves the single-file-edit convention). Run
 * `/token-cost-ledger refresh` to regenerate that override from the live
 * models.dev catalog (updates tracked models' costs; preserves extras).
 *   3. REFRESH — /token-cost-ledger [refresh]. Pulls https://models.dev/catalog.json,
 *      updates the override prices.json in place (atomic). Update-only for
 *      tracked models; meta + hand-curated extras + _tier_note preserved.
 *
 * Multi-root: reads ~/.pi/extensions-data/estebanforge/pi-token-cost-ledger/roots.conf (one path/line, # comments,
 * first = primary write target). Construct sandbox and any other producers
 * are unioned read-only; ledgers are disjoint so no dedup is needed.
 *
 * Record shape (unchanged from @ctogg):
 *   {ts, provider, model,
 *    tokens:{input,output,cacheRead,cacheWrite},
 *    cost:{input,output,cacheRead,cacheWrite,total}}
 */
import {
	getAgentDir,
	getSelectListTheme,
	getSettingsListTheme,
	type ExtensionAPI,
	type ExtensionCommandContext,
	type Theme,
} from "@earendil-works/pi-coding-agent";
import { Container, SelectList, SettingsList, Text, type SelectItem, type SettingItem } from "@earendil-works/pi-tui";
import { appendFile, mkdir, readdir, rename, stat, unlink, writeFile } from "node:fs/promises";
import { createReadStream, existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { createInterface } from "node:readline";
import { spawnSync } from "node:child_process";
import { join } from "node:path";
import { homedir } from "node:os";
import { fileURLToPath } from "node:url";
import path from "node:path";

// ── Paths ────────────────────────────────────────────────────────────────────

// Ledger dir lives under the scoped extensions-data convention:
//   ~/.pi/extensions-data/<author>/<extension>/
// Derived from pi's getAgentDir() (~/.pi/agent/, honors PI_CODING_AGENT_DIR),
// so rebranded distros resolve correctly. GitHub-style namespace = collision-proof
// and self-documenting. Capture writes here; prices.json override + roots.conf
// live here too.
function ledgerDir(): string {
	return join(path.dirname(getAgentDir()), "extensions-data", "estebanforge", "pi-token-cost-ledger");
}

// Construct-cli sandbox ledger path. Only meaningful when THIS extension is
// running on the HOST (where a separate sandbox home exists at the fixed path
// below). Inside the sandbox itself, homedir() IS the overlay root, so the
// constant's "construct-cli/home" segment would build a phantom nested path
// (absent → silent skip). We detect host-vs-sandbox by checking whether
// homedir() already points inside a construct overlay; if so, there is no
// separate sandbox to union — return "" (disabled).
const CONSTRUCT_LEDGER = (() => {
	const home = homedir();
	if (home.includes("/construct-cli/home")) return ""; // we ARE the sandbox
	return join(home, ".config", "construct-cli", "home", ".pi", "extensions-data", "estebanforge", "pi-token-cost-ledger");
})();

// ── Types ────────────────────────────────────────────────────────────────────

interface CostRecord {
	ts: number;
	provider: string;
	model: string;
	tokens: {
		input: number;
		output: number;
		cacheRead: number;
		cacheWrite: number;
	};
	cost: {
		input: number;
		output: number;
		cacheRead: number;
		cacheWrite: number;
		total: number;
	};
}

export interface PriceTier {
	i: number; // input per 1M
	c: number; // cache-read per 1M
	o: number; // output per 1M
	_tier_note?: string; // optional manual annotation (higher-tier pricing, etc.)
}

export type Prices = Record<string, PriceTier>;

/**
 * Case-insensitive price index. Ledger model strings come from whatever the
 * provider reports (e.g. "MiniMax-M3" mixed case, "mimo-v2.5-pro" lowercase);
 * prices.json keys are canonical lowercase. This index normalizes both sides
 * to lowercase so a casing drift never silently reports $0.00. Built once per
 * query from the loaded Prices.
 */
interface PriceIndex {
	byLower: Map<string, PriceTier>;
}

export function buildPriceIndex(prices: Prices): PriceIndex {
	const byLower = new Map<string, PriceTier>();
	for (const [k, v] of Object.entries(prices)) {
		if (k.startsWith("_")) continue; // skip _doc / _refresh / _tier_note meta keys
		byLower.set(k.toLowerCase(), v);
	}
	return { byLower };
}

export function lookupPrice(model: string, idx: PriceIndex): PriceTier | undefined {
	const key = (model ?? "").toLowerCase();
	const exact = idx.byLower.get(key);
	if (exact) return exact;
	// z.ai Coding Plan 1M-context routes append "[1m]" to the model id
	// (e.g. glm-5.3-flash[1m]): same model, same price — a routing suffix,
	// not a SKU, and the models.dev catalog never lists it. Ledger records
	// carry msg.model verbatim, so strip ONE trailing bracket group and
	// retry. Exact match always wins first; unknown models still miss.
	const stripped = key.replace(/\[[^\]]*\]$/, "");
	return stripped !== key ? idx.byLower.get(stripped) : undefined;
}

interface Bucket {
	calls: number;
	tokIn: number;
	tokOut: number;
	tokCache: number;
	tokCacheW: number;
	realUsd: number;
	equivUsd: number;
	unpricedCalls: number; // records whose model had no entry in prices.json
	unpricedTok: number; // tokens from those records (for the warning line)
}

const emptyBucket = (): Bucket => ({
	calls: 0,
	tokIn: 0,
	tokOut: 0,
	tokCache: 0,
	tokCacheW: 0,
	realUsd: 0,
	equivUsd: 0,
	unpricedCalls: 0,
	unpricedTok: 0,
});

// ── Date helpers (all LOCAL time — matches the file-partitioning scheme) ─────

function pad2(n: number): string {
	return String(n).padStart(2, "0");
}

function dateParts(d: Date): { year: string; month: string; day: string } {
	return {
		year: String(d.getFullYear()),
		month: pad2(d.getMonth() + 1),
		day: pad2(d.getDate()),
	};
}

/** YYYY-MM-DD local. */
function dayKey(d: Date): string {
	const { year, month, day } = dateParts(d);
	return `${year}-${month}-${day}`;
}

/** YYYY-MM local. */
function monthKey(d: Date): string {
	const { year, month } = dateParts(d);
	return `${year}-${month}`;
}

/** Absolute path to a root's JSONL for a given date. */
function dayFilePath(root: string, d: Date): string {
	const { year, month, day } = dateParts(d);
	return join(root, year, month, `${day}.jsonl`);
}

/** Enumerate local-midnight dates from start to end inclusive. */
function dateRange(start: Date, end: Date): Date[] {
	const out: Date[] = [];
	const cur = new Date(start.getFullYear(), start.getMonth(), start.getDate());
	const last = new Date(end.getFullYear(), end.getMonth(), end.getDate());
	while (cur <= last) {
		out.push(new Date(cur));
		cur.setDate(cur.getDate() + 1);
	}
	return out;
}

/** Monday (local) of the week containing `d`. getDay: 0=Sun..6=Sat. */
function mondayOf(d: Date): Date {
	const day = d.getDay();
	const diff = day === 0 ? -6 : 1 - day; // back up to Monday
	const m = new Date(d.getFullYear(), d.getMonth(), d.getDate());
	m.setDate(m.getDate() + diff);
	return m;
}

// ── Config: prices + roots ───────────────────────────────────────────────────

let _bundledPrices: Prices | null = null;
function loadBundledPrices(): Prices {
	if (_bundledPrices !== null) return _bundledPrices;
	try {
		const here = path.dirname(fileURLToPath(import.meta.url));
		_bundledPrices = JSON.parse(readFileSync(join(here, "prices.json"), "utf8")) as Prices;
	} catch {
		_bundledPrices = {};
	}
	return _bundledPrices;
}

/**
 * Override precedence: <baseDir>/prices.json > bundled default.
 * Refreshed on every query so an edit to the override file takes effect
 * immediately (no reload), matching the old `api-equiv.sh` behavior.
 */
function loadPrices(baseDir: string): Prices {
	try {
		const override = join(baseDir, "prices.json");
		if (existsSync(override)) {
			return JSON.parse(readFileSync(override, "utf8")) as Prices;
		}
	} catch {
		// fall through to bundled
	}
	return loadBundledPrices();
}

// ── Refresh: pull live costs from models.dev into the override file ──────────

// The catalog URL and the first-party provider scope. Mirrors the `_doc` /
// `_refresh` meta already in prices.json: only canonical first-party providers
// (no resellers), so a refresh never replaces a real price with a routed one.
const MODELS_DEV_URL = "https://models.dev/catalog.json";
const FIRST_PARTY_PROVIDERS = ["zai", "anthropic", "minimax", "google", "openai"];

// Catalog cost object shape (per 1M tokens, USD). models.dev returns null for
// free / bundled-plan models; those are skipped (matches the `_refresh` jq
// `select(.value.cost != null)`).
interface CatalogCost {
	input?: number;
	output?: number;
	cache_read?: number;
	cache_write?: number;
}

/** Build model-key → cost from the first-party providers in the catalog. */
function buildCatalogIndex(catalog: unknown): Map<string, CatalogCost> {
	const idx = new Map<string, CatalogCost>();
	const providers = (catalog as { providers?: Record<string, { models?: Record<string, { cost?: CatalogCost | null }> }> } | null)?.providers;
	if (!providers) return idx;
	for (const p of FIRST_PARTY_PROVIDERS) {
		const models = providers[p]?.models;
		if (!models) continue;
		for (const [key, def] of Object.entries(models)) {
			if (def?.cost) idx.set(key, def.cost);
		}
	}
	return idx;
}

interface RefreshResult {
	ok: true;
	updated: string[]; // model keys whose price changed
	unchanged: number; // tracked models found in catalog at the same price
	missing: string[]; // tracked models the catalog no longer lists (left as-is)
	wrote: string; // override path written
}
interface RefreshError {
	ok: false;
	error: string;
}

/**
 * Pull live costs from models.dev and update the override prices.json.
 *
 * Semantic: UPDATE-ONLY for models already in the effective prices (override
 * if present, else bundled). Does NOT add the 100+ catalog models the user
 * doesn't track — refresh keeps the curated set stable and only refreshes
 * prices, which is what "something changed" means in practice. New models
 * arrive via bundled-file releases (the `_refresh` jq recipe), not here.
 *
 * Preserves: meta keys (`_doc`/`_refresh`/`_intro_pricing`), hand-curated
 * extras from non-first-party providers (grok/deepseek/mimo), and per-model
 * `_tier_note` annotations. On success writes `<baseDir>/prices.json`
 * atomically (tmp + rename) so a crash mid-write can't corrupt it. On ANY
 * fetch/parse failure, returns `{ok:false}` and leaves existing files untouched.
 */
async function refreshPrices(baseDir: string): Promise<RefreshResult | RefreshError> {
	// Fetch with a hard timeout. A hung connection must never wedge the command.
	let resp: Response;
	try {
		const ctrl = new AbortController();
		const timer = setTimeout(() => ctrl.abort(), 15_000);
		try {
			resp = await fetch(MODELS_DEV_URL, { signal: ctrl.signal });
		} finally {
			clearTimeout(timer);
		}
	} catch (err) {
		return { ok: false, error: `fetch failed: ${err instanceof Error ? err.message : String(err)}` };
	}
	if (!resp.ok) return { ok: false, error: `models.dev returned HTTP ${resp.status}` };

	let catalog: unknown;
	try {
		catalog = await resp.json();
	} catch (err) {
		return { ok: false, error: `could not parse catalog JSON: ${err instanceof Error ? err.message : err}` };
	}
	const idx = buildCatalogIndex(catalog);
	if (idx.size === 0) return { ok: false, error: "catalog parsed but listed no first-party models — schema changed?" };

	// Output holds the file we'll write: meta strings (_doc/_refresh/etc.)
	// + model tiers. Modeled as Record<string, unknown> because meta values
	// are strings, not PriceTier — the `Prices` type's white lie only holds for
	// model keys. Shallow copy is safe: we replace updated entries wholesale,
	// never mutate entry fields, so the bundled cache stays pristine.
	const effective = loadPrices(baseDir);
	const out: Record<string, unknown> = {};
	for (const [k, v] of Object.entries(effective)) out[k] = v;

	const updated: string[] = [];
	let unchanged = 0;
	const missing: string[] = [];

	for (const [key, raw] of Object.entries(effective)) {
		if (key.startsWith("_")) continue; // meta — preserved as-is, untouched
		const tier = raw as PriceTier;
		const cost = idx.get(key);
		if (!cost) {
			missing.push(key); // not in first-party catalog (extra, or deprecated) — keep as-is
			continue;
		}
		const next: PriceTier = {
			i: typeof cost.input === "number" ? cost.input : tier.i,
			c: typeof cost.cache_read === "number" ? cost.cache_read : tier.c,
			o: typeof cost.output === "number" ? cost.output : tier.o,
		};
		if (tier._tier_note) next._tier_note = tier._tier_note; // preserve manual annotation
		if (next.i !== tier.i || next.c !== tier.c || next.o !== tier.o) {
			updated.push(key);
			out[key] = next;
		} else {
			unchanged++;
		}
	}

	// Stamp the fetch date into `_doc` so a later reader knows freshness.
	// Keep the existing `_refresh` jq recipe + `_intro_pricing` verbatim.
	const today = new Date().toISOString().slice(0, 10);
	if (typeof out._doc === "string") {
		out._doc = out._doc.replace(/Fetched \d{4}-\d{2}-\d{2}/, `Fetched ${today}`);
	}

	const target = join(baseDir, "prices.json");
	const tmp = `${target}.tmp`;
	try {
		await mkdir(baseDir, { recursive: true });
		await writeFile(tmp, JSON.stringify(out, null, 2) + "\n", "utf8");
		await rename(tmp, target); // atomic on POSIX (same filesystem)
	} catch (err) {
		// Clean up the orphan tmp so a retry doesn't accumulate debris. Best-effort:
		// if writeFile itself failed, tmp may not exist (ENOENT) — swallow that.
		await unlink(tmp).catch(() => {});
		return { ok: false, error: `write failed: ${err instanceof Error ? err.message : err}` };
	}
	return { ok: true, updated, unchanged, missing, wrote: target };
}

/**
 * Ledger roots. Precedence mirrors the old scripts:
 *   PI_COST_LEDGER (single) > PI_COST_LEDGERS (colon-sep) > roots.conf > default
 * First root is PRIMARY (the capture write target + override location).
 * Default unions the base dir with the construct-cli sandbox ledger IF it exists
 * (soft-fail: absent = silent skip, no error). Disjoint ledgers, no dedup.
 */
function loadRoots(): { roots: string[]; primary: string } {
	const baseDir = ledgerDir();
	const envSingle = process.env.PI_COST_LEDGER;
	if (envSingle) return { roots: [envSingle], primary: envSingle };
	const envMulti = process.env.PI_COST_LEDGERS;
	if (envMulti) {
		const roots = envMulti.split(":").filter(Boolean);
		if (roots.length) return { roots, primary: roots[0] };
	}
	const conf = join(baseDir, "roots.conf");
	if (existsSync(conf)) {
		const roots: string[] = [];
		for (const line of readFileSync(conf, "utf8").split("\n")) {
			const trimmed = line.replace(/#.*$/, "").trim();
			if (trimmed) roots.push(trimmed);
		}
		if (roots.length) return { roots, primary: roots[0] };
	}
	// Default: base dir + construct sandbox (auto-detected, soft-fail if absent).
	const roots = existsSync(CONSTRUCT_LEDGER) ? [baseDir, CONSTRUCT_LEDGER] : [baseDir];
	return { roots, primary: baseDir };
}

// ── Number-style persistence (settings.json in the primary ledger root) ───────
// pi has no built-in disk store for extension flags, and `pi config set` is
// not a real command (only `-l/--approve/--no-approve`). So the chosen number
// style persists in our own settings.json next to prices.json — same dir, same
// pattern. Loaded at factory time to seed registerFlag's default; written on
// every set. Env TOKEN_COST_LEDGER_NUMBERS still overrides per-session.
const NUMBER_STYLES_ALL = ["auto", "comma", "dot"] as const;
type NumberStylePref = (typeof NUMBER_STYLES_ALL)[number];
const SETTINGS_FILE = "settings.json";

function isNumberStyle(v: unknown): v is NumberStylePref {
	return typeof v === "string" && (NUMBER_STYLES_ALL as readonly string[]).includes(v);
}

/** Read persisted number style. Missing/corrupt file → "auto". */
function loadNumberStyleSetting(): NumberStylePref {
	try {
		const raw = readFileSync(join(loadRoots().primary, SETTINGS_FILE), "utf8");
		const parsed = JSON.parse(raw) as { numbers?: unknown };
		return isNumberStyle(parsed.numbers) ? parsed.numbers : "auto";
	} catch {
		return "auto";
	}
}

/** Persist number style atomically (mkdir + writeFileSync into primary root). */
function saveNumberStyleSetting(value: NumberStylePref): void {
	const dir = loadRoots().primary;
	try {
		mkdirSync(dir, { recursive: true });
		writeFileSync(join(dir, SETTINGS_FILE), JSON.stringify({ numbers: value }, null, 2) + "\n", "utf8");
	} catch {
		// Non-fatal: the subsequent ctx.reload() re-seeds the flag from disk
		// (registerFlag default), so the value still applies this session.
	}
}

/** Cache convention, same knob as the old scripts. Default separate. */
function cacheConv(): "separate" | "included" {
	return process.env.CACHE_CONV === "included" ? "included" : "separate";
}

// ── Cost math (ported from api-equiv.sh jq) ──────────────────────────────────

// Cost math is inlined into addRecord below (single price lookup per record).

function addRecord(b: Bucket, r: CostRecord, idx: PriceIndex, conv: "separate" | "included"): void {
	b.calls += 1;
	b.tokIn += r.tokens.input ?? 0;
	b.tokOut += r.tokens.output ?? 0;
	b.tokCache += r.tokens.cacheRead ?? 0;
	b.tokCacheW += r.tokens.cacheWrite ?? 0;
	b.realUsd += r.cost?.total ?? 0;
	// Single price lookup per record (inlined; was two via equivCost + isPriced).
	const tier = lookupPrice(r.model, idx);
	if (tier) {
		const noncached =
			conv === "included" ? Math.max(0, (r.tokens.input ?? 0) - (r.tokens.cacheRead ?? 0)) : r.tokens.input ?? 0;
		b.equivUsd += (noncached * tier.i + (r.tokens.cacheRead ?? 0) * tier.c + (r.tokens.output ?? 0) * tier.o) / 1e6;
	} else {
		b.unpricedCalls += 1;
		b.unpricedTok += (r.tokens.input ?? 0) + (r.tokens.output ?? 0) + (r.tokens.cacheRead ?? 0);
	}
}

// ── Record reading (streaming, across roots, bounded to a date list) ─────────

/** True only if `r` has the shape we can aggregate without crashing. */
function isCostRecord(r: unknown): r is CostRecord {
	if (typeof r !== "object" || r === null) return false;
	const o = r as Record<string, unknown>;
	return (
		typeof o.ts === "number" &&
		typeof o.model === "string" &&
		!!o.tokens &&
		typeof o.tokens === "object"
	);
}

/**
 * Stream records from one JSONL file. Tolerant: malformed lines, unreadable
 * files, and records missing the expected shape are skipped rather than
 * crashing the whole query. Matches the old jq tolerant-of-bad-JSON behavior
 * but also guards against partial/corrupt records (e.g. legacy producers).
 */
async function readRecordsFromFile(file: string, into: CostRecord[]): Promise<void> {
	let stream;
	try {
		stream = createReadStream(file, { encoding: "utf8" });
	} catch {
		return; // unreadable (permissions, etc.) — skip
	}
	const rl = createInterface({ input: stream, crlfDelay: Infinity });
	try {
		for await (const line of rl) {
			const s = line.trim();
			if (!s) continue;
			try {
				const parsed = JSON.parse(s);
				if (isCostRecord(parsed)) into.push(parsed);
			} catch {
				// skip malformed line
			}
		}
	} catch {
		// mid-read failure (file rotated/permissions flipped) — what we have is fine
	} finally {
		stream.destroy();
	}
}

/**
 * Read records whose LOCAL file date is in `dates`. Streams line-by-line to
 * avoid loading huge files into memory. Roots are unioned disjointly.
 */
async function readRecords(roots: string[], dates: Date[]): Promise<CostRecord[]> {
	const targets = new Set<string>();
	for (const root of roots) {
		for (const d of dates) targets.add(dayFilePath(root, d));
	}
	const out: CostRecord[] = [];
	for (const file of targets) {
		if (!existsSync(file)) continue;
		await readRecordsFromFile(file, out);
	}
	return out;
}

/** Read ALL records across roots (for `all` / `model` queries). */
async function readAllRecords(roots: string[]): Promise<CostRecord[]> {
	const files = new Set<string>();
	for (const root of roots) {
		if (!existsSync(root)) continue;
		await collectJsonl(root, files);
	}
	const out: CostRecord[] = [];
	for (const file of files) {
		await readRecordsFromFile(file, out);
	}
	return out;
}

async function collectJsonl(dir: string, into: Set<string>): Promise<void> {
	let entries: string[];
	try {
		entries = await readdir(dir);
	} catch {
		return;
	}
	for (const name of entries) {
		const full = join(dir, name);
		// Recurse into dirs; collect *.jsonl files. Symlinks are followed by
		// readdir+stat semantics, which is fine for the ledger layout.
		const st = await stat(full).catch(() => null);
		if (!st) continue;
		if (st.isDirectory()) {
			await collectJsonl(full, into);
		} else if (name.endsWith(".jsonl")) {
			into.add(full);
		}
	}
}

// ── Number formatting ───────────────────────────────────────────────────────
//
// Three styles via the `token-cost-ledger-numbers` flag (env TOKEN_COST_LEDGER_NUMBERS):
//   "auto"    detect from terminal locale (LC_NUMERIC > LC_ALL > LANG), via Intl.
//   "comma"   Latin/European: '.' thousands, ',' decimal  (e.g. $1.148,23)
//   "dot"     Anglo:           ',' thousands, '.' decimal  (e.g. $1,148.23)
// Default "auto" respects each user's locale; override for a fixed style.

/** Resolve LC_ALL/LC_NUMERIC/LANG (POSIX precedence) to an Intl tag, sans codeset. */
function detectLocaleTag(): string {
	// POSIX precedence: LC_ALL overrides everything, then category-specific
	// LC_NUMERIC, then LANG as the default. Empty string is falsy, so an
	// explicit `LC_ALL=` ("use defaults") falls through correctly.
	const raw = process.env.LC_ALL || process.env.LC_NUMERIC || process.env.LANG || "en_US";
	return raw.replace(/\.[A-Za-z0-9-]+$/, "").replace(/_/g, "-");
}

interface NumberStyle {
	group: string; // thousands separator
	decimal: string; // decimal separator
}

/** Detect the terminal's group/decimal separators via Intl + POSIX locale env. */
function detectStyle(): NumberStyle {
	try {
		const parts = new Intl.NumberFormat(detectLocaleTag()).formatToParts(1234567.89);
		const group = parts.find((p) => p.type === "group")?.value ?? ",";
		const decimal = parts.find((p) => p.type === "decimal")?.value ?? ".";
		return { group, decimal };
	} catch {
		return { group: ",", decimal: "." };
	}
}

/** Build a formatter from an explicit style ("comma" | "dot") or a detected one. */
function resolveStyle(setting: "auto" | "comma" | "dot"): NumberStyle {
	if (setting === "comma") return { group: ".", decimal: "," };
	if (setting === "dot") return { group: ",", decimal: "." };
	return detectStyle();
}

/** Format a number with the given style and decimal precision. */
function formatNum(n: number, decimals: number, s: NumberStyle): string {
	const neg = n < 0;
	const fixed = Math.abs(n).toFixed(decimals);
	const [intPart, decPart] = fixed.split(".");
	const intFmt = intPart.replace(/\B(?=(\d{3})+(?!\d))/g, s.group);
	const body = decPart ? `${intFmt}${s.decimal}${decPart}` : intFmt;
	return (neg ? "-" : "") + body;
}

interface Formatter {
	money: (n: number) => string; // USD, 2 decimals
	tok: (n: number) => string; // tokens, K/M suffix
	int: (n: number) => string; // plain count
}

/** Build a formatter for a given style. One per query (cheap). */
function makeFormatter(s: NumberStyle): Formatter {
	return {
		money: (n) => `$${formatNum(n, 2, s)}`,
		tok: (n) => {
			if (n >= 1_000_000) return `${formatNum(n / 1_000_000, 1, s)}M`;
			if (n >= 1_000) return `${formatNum(n / 1_000, 1, s)}K`;
			return formatNum(n, 0, s);
		},
		int: (n) => formatNum(n, 0, s),
	};
}

/** Read the number-style setting: env TOKEN_COST_LEDGER_NUMBERS > flag > "auto". */
function numberStyleSetting(pi: ExtensionAPI): "auto" | "comma" | "dot" {
	const env = process.env.TOKEN_COST_LEDGER_NUMBERS?.trim().toLowerCase();
	if (env === "comma" || env === "dot" || env === "auto") return env;
	const flagVal = (pi.getFlag("token-cost-ledger-numbers") as string | undefined)?.trim().toLowerCase();
	if (flagVal === "comma" || flagVal === "dot" || flagVal === "auto") return flagVal;
	return "auto";
}

// ── Period parsing ───────────────────────────────────────────────────────────

interface Range {
	start: Date;
	end: Date;
	subtotalKey: "day" | "month"; // how to break down within the range
	label: string;
}

function localToday(): Date {
	const n = new Date();
	return new Date(n.getFullYear(), n.getMonth(), n.getDate());
}

function parseRange(args: string): Range | null {
	const parts = args.trim().split(/\s+/).filter(Boolean);
	const now = localToday();
	const kind = parts[0] ?? "today";

	const monthRegex = /^(\d{4})-(\d{2})$/;
	const dateRegex = /^(\d{4})-(\d{2})-(\d{2})$/;
	const yearRegex = /^(\d{4})$/;

	if (kind === "today" || parts.length === 0) {
		return { start: now, end: now, subtotalKey: "day", label: `today (${dayKey(now)})` };
	}
	if (kind === "day") {
		// Parse the YYYY-MM-DD groups ourselves. `new Date("2026-07-19")` would
		// be parsed as UTC midnight, and the local getters used downstream
		// would then shift it to the previous day west of UTC.
		if (parts[1]) {
			const m = parts[1].match(dateRegex);
			if (!m) return null;
			const day = new Date(+m[1], +m[2] - 1, +m[3]);
			return { start: day, end: day, subtotalKey: "day", label: dayKey(day) };
		}
		return { start: now, end: now, subtotalKey: "day", label: dayKey(now) };
	}
	if (kind === "week") {
		const n = parts[1] ? parseInt(parts[1], 10) : 0;
		if (isNaN(n) || n < 0) return null;
		const mon = mondayOf(now);
		mon.setDate(mon.getDate() - n * 7);
		const sun = new Date(mon);
		sun.setDate(mon.getDate() + 6);
		return { start: mon, end: sun, subtotalKey: "day", label: `week (${dayKey(mon)} → ${dayKey(sun)})` };
	}
	if (kind === "month") {
		let y = now.getFullYear();
		let m = now.getMonth();
		if (parts[1]) {
			// Validate the month component is 01-12, not just digit shape.
			const mt = parts[1].match(monthRegex);
			if (!mt) return null;
			y = +mt[1]; m = +mt[2] - 1;
			if (m < 0 || m > 11) return null;
		}
		const start = new Date(y, m, 1);
		const end = new Date(y, m + 1, 0);
		return { start, end, subtotalKey: "day", label: `${y}-${pad2(m + 1)}` };
	}
	if (kind === "year") {
		const y = parts[1] && yearRegex.test(parts[1]) ? parseInt(parts[1], 10) : now.getFullYear();
		return {
			start: new Date(y, 0, 1),
			end: new Date(y, 11, 31),
			subtotalKey: "month",
			label: String(y),
		};
	}
	if (kind === "all") {
		// Sentinel handled by the caller via readAllRecords (directory walk).
		// No date range is materialized here, so there's no hardcoded floor year
		// pretending to be "all history".
		return { start: now, end: now, subtotalKey: "month", label: "all history" };
	}
	if (kind === "days") {
		// Rolling N-day window ending today (inclusive). `week`/`month`/`year`
		// are calendar-bound; `days` is the rolling-window counterpart the
		// quick-range menu needs (last 7 / 30 / 365). Default 30 if bare.
		// Subtotal by day for short spans, month once it would overflow a screen.
		const n = parts[1] ? parseInt(parts[1], 10) : 30;
		if (isNaN(n) || n < 1) return null;
		if (n > 3650) return null; // sanity cap (~10y): typed path only; menu uses fixed 7/30/365
		const end = now;
		const start = new Date(now);
		start.setDate(start.getDate() - (n - 1)); // include today
		const subtotalKey = n > 31 ? "month" : "day";
		return { start, end, subtotalKey, label: `last ${n} days (${dayKey(start)} → ${dayKey(end)})` };
	}
	return null;
}

// ── Aggregation ──────────────────────────────────────────────────────────────

interface Aggregate {
	total: Bucket;
	byModel: Map<string, Bucket>;
	byPeriod: Map<string, Bucket>; // keyed by day or month
}

function aggregate(records: CostRecord[], idx: PriceIndex, conv: "separate" | "included", subtotalKey: "day" | "month"): Aggregate {
	const total = emptyBucket();
	const byModel = new Map<string, Bucket>();
	const byPeriod = new Map<string, Bucket>();
	for (const r of records) {
		addRecord(total, r, idx, conv);
		const mk = r.model ?? "unknown";
		if (!byModel.has(mk)) byModel.set(mk, emptyBucket());
		addRecord(byModel.get(mk)!, r, idx, conv);
		const d = new Date(r.ts);
		const pk = subtotalKey === "day" ? dayKey(d) : monthKey(d);
		if (!byPeriod.has(pk)) byPeriod.set(pk, emptyBucket());
		addRecord(byPeriod.get(pk)!, r, idx, conv);
	}
	return { total, byModel, byPeriod };
}

// ── Rendering ────────────────────────────────────────────────────────────────

function renderTable(theme: Theme, range: Range, agg: Aggregate, conv: "separate" | "included", fmt: Formatter): string {
	const bold = theme.bold.bind(theme);
	const fg = theme.fg.bind(theme);
	const pad = (s: string, n: number) => s.padEnd(n);

	const lines: string[] = [];
	lines.push(bold(fg("accent", `Token usage — ${range.label}`)));
	lines.push(fg("dim", `  cache convention: ${conv} (input ${conv === "included" ? "includes" : "excludes"} cacheRead)`));
	lines.push("");

	const tokTotal = agg.total.tokIn + agg.total.tokOut + agg.total.tokCache + agg.total.tokCacheW;
	lines.push(
		`  ${fg("success", "Total")}: ${bold(fmt.money(agg.total.realUsd))} real  ·  ${bold(
			fmt.money(agg.total.equivUsd),
		)} api-equiv   ${fg("dim", `${fmt.tok(tokTotal)} tok · ${fmt.int(agg.total.calls)} calls`)}`,
	);
	lines.push("");

	// By model
	if (agg.byModel.size > 0) {
		lines.push(fg("accent", "  By model"));
		lines.push(fg("dim", "  " + "─".repeat(64)));
		const models = [...agg.byModel.entries()].sort((a, b) => b[1].equivUsd + b[1].realUsd - (a[1].equivUsd + a[1].realUsd));
		for (const [model, b] of models) {
			const mt = b.tokIn + b.tokOut + b.tokCache + b.tokCacheW;
			lines.push(
				`  ${fg("dim", pad(model, 26))} ${bold(pad(fmt.money(b.realUsd), 8))} · ${pad(
					fmt.money(b.equivUsd),
					8,
				)}  ${fg("dim", `${fmt.tok(mt)} tok · ${fmt.int(b.calls)}`)}`,
			);
		}
		lines.push("");
	}

	// By period (skip when the range is a single day — redundant with the total)
	const periods = [...agg.byPeriod.entries()].sort((a, b) => (a[0] < b[0] ? -1 : 1));
	if (periods.length > 1) {
		lines.push(fg("accent", `  By ${range.subtotalKey}`));
		lines.push(fg("dim", "  " + "─".repeat(64)));
		for (const [key, b] of periods) {
			const mt = b.tokIn + b.tokOut + b.tokCache + b.tokCacheW;
			lines.push(
				`  ${fg("dim", pad(key, 26))} ${bold(pad(fmt.money(b.realUsd), 8))} · ${pad(
					fmt.money(b.equivUsd),
					8,
				)}  ${fg("dim", `${fmt.tok(mt)} tok · ${fmt.int(b.calls)}`)}`,
			);
		}
		lines.push("");
	}

	if (agg.total.calls === 0) {
		lines.push(fg("dim", "  No usage recorded for this period."));
	} else if (agg.total.unpricedCalls > 0) {
		lines.push(
			fg("warning", `  ⚠ ${fmt.int(agg.total.unpricedCalls)} calls (${fmt.tok(agg.total.unpricedTok)} tok) had no price entry — shown as ${fmt.money(0)} api-equiv`),
		);
	}
	return lines.join("\n");
}

function renderModel(theme: Theme, modelName: string, records: CostRecord[], idx: PriceIndex, conv: "separate" | "included", fmt: Formatter): string {
	const bold = theme.bold.bind(theme);
	const fg = theme.fg.bind(theme);

	// Case-insensitive match so a typo or casing drift doesn't silently miss.
	const want = modelName.toLowerCase();
	const filtered = records.filter((r) => (r.model ?? "unknown").toLowerCase() === want);
	const agg = aggregate(filtered, idx, conv, "month");
	const lines: string[] = [];
	lines.push(bold(fg("accent", `Token usage — model: ${modelName}`)));
	lines.push("");
	if (filtered.length === 0) {
		// Suggest the distinct model names that DO exist, so a typo is obvious.
		const known = [...new Set(records.map((r) => r.model ?? "unknown"))].sort();
		lines.push(fg("dim", `  No records for model "${modelName}".`));
		lines.push(fg("dim", `  Known models: ${known.join(", ")}`));
		return lines.join("\n");
	}
	// Reuse the table, but force a per-month breakdown regardless.
	const tokTotal = agg.total.tokIn + agg.total.tokOut + agg.total.tokCache + agg.total.tokCacheW;
	lines.push(
		`  ${fg("success", "Total")}: ${bold(fmt.money(agg.total.realUsd))} real  ·  ${bold(
			fmt.money(agg.total.equivUsd),
		)} api-equiv   ${fg("dim", `${fmt.tok(tokTotal)} tok · ${fmt.int(agg.total.calls)} calls`)}`,
	);
	lines.push("");
	const periods = [...agg.byPeriod.entries()].sort((a, b) => (a[0] < b[0] ? -1 : 1));
	if (periods.length > 0) {
		lines.push(fg("accent", "  By month"));
		lines.push(fg("dim", "  " + "─".repeat(64)));
		for (const [key, b] of periods) {
			const mt = b.tokIn + b.tokOut + b.tokCache + b.tokCacheW;
			lines.push(
				`  ${fg("dim", key.padEnd(26))} ${bold(fmt.money(b.realUsd).padStart(8))} · ${fmt.money(b.equivUsd).padStart(
					8,
				)}  ${fg("dim", `${fmt.tok(mt)} tok · ${fmt.int(b.calls)}`)}`,
			);
		}
	}
	return lines.join("\n");
}

// ── Chart generation (SVG dashboard, optional PNG via system converter) ─────
//
// /token-usage chart [period] renders a Z.ai-style usage dashboard as a
// self-contained SVG: KPI row + per-model multi-line chart + a second
// unified single-line chart (all models summed). Zero npm deps — SVG is pure
// string templating. PNG is emitted too when rsvg-convert or inkscape is on
// PATH (best-effort; no native binary ships with the package). Matches the
// no-cruft / no-new-dep philosophy.

// Distinct, dark-theme-friendly series colors. Assigned by usage rank so the
// busiest model always lands on the amber (matching the reference's dominant
// line). Cycle wraps for >10 models (rare; long tail falls into legend "+N").
const SERIES_COLORS = [
	"#F59E0B", // amber
	"#A855F7", // purple
	"#3B82F6", // blue
	"#22C55E", // green
	"#EC4899", // pink
	"#06B6D4", // cyan
	"#EAB308", // yellow
	"#EF4444", // red
	"#14B8A6", // teal
	"#8B5CF6", // violet
];

interface ChartSeries {
	name: string;
	color: string;
	values: number[]; // one value per day, aligned to `dates`
	fill?: boolean; // fill area under the line (used for the unified total)
}

interface ChartData {
	dates: string[]; // sorted day keys (the X axis)
	models: string[]; // sorted by total tokens desc
	modelColor: Map<string, string>;
	modelProvider: Map<string, string>; // dominant provider per model (for legend)
	modelTotal: Map<string, number>;
	matrix: Map<string, number[]>; // model -> tokens per day
	totalPerDay: number[]; // all models summed per day (unified chart)
	grandTotal: number;
	providerTotal: Map<string, number>;
	spanStart: Date;
	spanEnd: Date;
}

/** Sum all token buckets of a record (matches renderTable's tokTotal). Coerces
 *  non-numeric fields to 0 — a corrupt/legacy line with string token values
 *  would otherwise concatenate into the matrix and surface as NaN SVG coords. */
function recTokens(r: CostRecord): number {
	const num = (v: unknown) => (typeof v === "number" && Number.isFinite(v) ? v : 0);
	return num(r.tokens.input) + num(r.tokens.output) + num(r.tokens.cacheRead) + num(r.tokens.cacheWrite);
}

/**
 * Build per-day-per-model series from records.
 * `dateList` non-null → ranged query: X axis = every day in the range (zeros
 * included, so the line is continuous like the reference). `dateList` null →
 * `all` query: X axis = only the days that have records (sparse by intent).
 */
function buildChartData(records: CostRecord[], dateList: Date[] | null): ChartData {
	let dates: string[];
	let spanStart: Date;
	let spanEnd: Date;
	if (dateList) {
		dates = dateList.map(dayKey);
		spanStart = dateList[0];
		spanEnd = dateList[dateList.length - 1];
	} else {
		const set = new Set<string>();
		let min = Number.POSITIVE_INFINITY;
		let max = Number.NEGATIVE_INFINITY;
		for (const r of records) {
			set.add(dayKey(new Date(r.ts)));
			if (r.ts < min) min = r.ts;
			if (r.ts > max) max = r.ts;
		}
		dates = [...set].sort();
		spanStart = new Date(min === Number.POSITIVE_INFINITY ? Date.now() : min);
		spanEnd = new Date(max === Number.NEGATIVE_INFINITY ? Date.now() : max);
	}
	const idx = new Map<string, number>();
	dates.forEach((d, i) => idx.set(d, i));

	const matrix = new Map<string, number[]>();
	const modelTotal = new Map<string, number>();
	const providerTotal = new Map<string, number>();
	const providerCounts = new Map<string, Map<string, number>>(); // model -> provider -> call count
	const totalPerDay = new Array<number>(dates.length).fill(0);
	let grandTotal = 0;

	for (const r of records) {
		const i = idx.get(dayKey(new Date(r.ts)));
		if (i === undefined) continue; // outside range (clock skew / `all` recompute) — skip
		const m = r.model ?? "unknown";
		const p = r.provider ?? "unknown";
		const t = recTokens(r);
		if (!matrix.has(m)) {
			matrix.set(m, new Array(dates.length).fill(0));
			modelTotal.set(m, 0);
			providerCounts.set(m, new Map());
		}
		matrix.get(m)![i] += t;
		modelTotal.set(m, modelTotal.get(m)! + t);
		providerTotal.set(p, (providerTotal.get(p) ?? 0) + t);
		providerCounts.get(m)!.set(p, (providerCounts.get(m)!.get(p) ?? 0) + 1);
		totalPerDay[i] += t;
		grandTotal += t;
	}

	const models = [...matrix.keys()].sort((a, b) => modelTotal.get(b)! - modelTotal.get(a)!);
	const modelColor = new Map<string, string>();
	models.forEach((m, i) => modelColor.set(m, SERIES_COLORS[i % SERIES_COLORS.length]));
	// A model can surface under multiple provider strings (e.g. MiniMax-M3 via
	// "minimax" and a clean-room "minimax-m3-clean"). Legend shows the DOMINANT
	// one so the label stays stable and honest.
	const modelProvider = new Map<string, string>();
	for (const m of models) {
		let best = "";
		let bestN = -1;
		for (const [p, c] of providerCounts.get(m)!) if (c > bestN) (bestN = c), (best = p);
		modelProvider.set(m, best);
	}

	return { dates, models, modelColor, modelProvider, modelTotal, matrix, totalPerDay, grandTotal, providerTotal, spanStart, spanEnd };
}

/** Round a max value up to a 1/2/5 × 10^n nice number for clean axis ticks. */
function niceMax(v: number): number {
	if (v <= 0) return 1;
	const pow = Math.pow(10, Math.floor(Math.log10(v)));
	const n = v / pow;
	const nice = n <= 1 ? 1 : n <= 2 ? 2 : n <= 5 ? 5 : 10;
	return nice * pow;
}

/** Compact token count for axis labels (no locale — M/K/B is conventional). */
function compactAxis(n: number): string {
	const trim = (x: number) => String(Math.round(x * 10) / 10);
	if (n >= 1e9) return trim(n / 1e9) + "B";
	if (n >= 1e6) return trim(n / 1e6) + "M";
	if (n >= 1e3) return trim(n / 1e3) + "K";
	return String(Math.round(n));
}

function xmlEscape(s: string): string {
	return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

/** Draw one line chart (title + optional legend + grid + axes + series). Returns SVG fragment. */
function lineChartFragment(box: { x: number; y: number; w: number; h: number }, title: string, series: ChartSeries[], dates: string[], single: boolean): string {
	const { x, y, w, h } = box;
	const plotL = x + 64;
	const plotR = x + w - 28;
	const plotW = plotR - plotL;
	const titleY = y + 18;
	const legendY = y + 40;
	const plotTop = single ? y + 34 : y + 56;
	const plotBottom = y + h - 26;
	const plotH = plotBottom - plotTop;
	const n = dates.length;
	const out: string[] = [];

	out.push(`<text x="${x}" y="${titleY}" fill="#FFFFFF" font-size="15" font-weight="700">${xmlEscape(title)}</text>`);

	// Legend: single wrapped row, ellipsized with "+N more" when it overflows.
	// Approx char width 6.4 keeps it simple; SVG text metrics aren't available
	// without a layout pass, which would need a dep.
	if (!single) {
		let lx = x;
		for (let i = 0; i < series.length; i++) {
			const s = series[i];
			const itemW = s.name.length * 6.4 + 22;
			if (lx + itemW > x + w) {
				out.push(`<text x="${lx.toFixed(0)}" y="${legendY}" fill="#8E8E8E" font-size=\"11\">+${series.length - i} more</text>`);
				break;
			}
			out.push(`<circle cx="${(lx + 5).toFixed(0)}" cy="${legendY - 4}" r="4" fill="${s.color}"/>`);
			out.push(`<text x="${(lx + 14).toFixed(0)}" y="${legendY}" fill="#B3B3B3" font-size="11">${xmlEscape(s.name)}</text>`);
			lx += itemW;
		}
	}

	// yMax across all series, snapped to a nice number for clean ticks.
	let yMaxRaw = 0;
	for (const s of series) for (const v of s.values) if (v > yMaxRaw) yMaxRaw = v;
	const yMax = niceMax(yMaxRaw);
	const ticks = 5;

	for (let t = 0; t <= ticks; t++) {
		const val = (yMax * t) / ticks;
		const gy = plotBottom - (val / yMax) * plotH;
		out.push(`<line x1="${plotL}" y1="${gy.toFixed(1)}" x2="${plotR}" y2="${gy.toFixed(1)}" stroke="#3A3A40" stroke-width="1"/>`);
		out.push(`<text x="${plotL - 8}" y="${(gy + 3).toFixed(1)}" fill="#8E8E8E" font-size="10" text-anchor="end">${compactAxis(val)}</text>`);
	}

	// X labels thinned to ~8 across, anchored to actual date positions.
	if (n > 0) {
		const step = Math.max(1, Math.ceil(n / 8));
		for (let i = 0; i < n; i += step) {
			const px = n > 1 ? plotL + (i * plotW) / (n - 1) : plotL + plotW / 2;
			out.push(`<text x="${px.toFixed(0)}" y="${plotBottom + 16}" fill="#8E8E8E" font-size="10" text-anchor="middle">${dates[i]}</text>`);
		}
	}

	const sx = (i: number) => (n > 1 ? plotL + (i * plotW) / (n - 1) : plotL + plotW / 2);
	const sy = (v: number) => plotBottom - (v / yMax) * plotH;
	for (const s of series) {
		if (n === 1) {
			// Single-day window: a point, not a line.
			out.push(`<circle cx="${sx(0).toFixed(1)}" cy="${sy(s.values[0] ?? 0).toFixed(1)}" r="3" fill="${s.color}"/>`);
			continue;
		}
		const pts = s.values.map((v, i) => `${sx(i).toFixed(1)},${sy(v).toFixed(1)}`).join(" ");
		if (s.fill) {
			const area = `${sx(0).toFixed(1)},${plotBottom.toFixed(1)} ${pts} ${sx(n - 1).toFixed(1)},${plotBottom.toFixed(1)}`;
			out.push(`<polygon points="${area}" fill="url(#areaGrad)"/>`);
		}
		out.push(`<polyline points="${pts}" fill="none" stroke="${s.color}" stroke-width="2" stroke-linejoin="round" stroke-linecap="round"/>`);
	}
	return out.join("\n");
}

/** Assemble the full dashboard SVG document. */
function buildUsageSVG(range: Range, data: ChartData, fmt: Formatter): string {
	const W = 1240;
	const H = 760;
	const parts: string[] = [];
	parts.push(`<?xml version="1.0" encoding="UTF-8"?>`);
	parts.push(
		`<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}" viewBox="0 0 ${W} ${H}" font-family="ui-sans-serif, system-ui, -apple-system, 'Segoe UI', Roboto, sans-serif">`,
	);
	parts.push(
		`<defs><linearGradient id="areaGrad" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#3B82F6" stop-opacity="0.28"/><stop offset="1" stop-color="#3B82F6" stop-opacity="0"/></linearGradient></defs>`,
	);
	parts.push(`<rect width="${W}" height="${H}" fill="#202022"/>`);

	// Header + subtitle (cache convention + generation timestamp).
	parts.push(`<text x="32" y="40" fill="#FFFFFF" font-size="22" font-weight="700">Token usage — ${xmlEscape(range.label)}</text>`);
	const gen = new Date().toISOString().slice(0, 16).replace("T", " ");
	parts.push(`<text x="32" y="60" fill="#8E8E8E" font-size="11">cache convention: ${cacheConv()} · generated ${gen}</text>`);

	if (data.grandTotal === 0 || data.models.length === 0) {
		parts.push(`<text x="${W / 2}" y="${H / 2}" fill="#8E8E8E" font-size="14" text-anchor="middle">No usage recorded for this period.</text>`);
		parts.push(`</svg>`);
		return parts.join("\n");
	}

	// KPI row: total / top model / 2nd model. The provider axis was dropped
	// because the top provider is almost always the top model's owner (zai owns
	// glm-5.2), so a "top provider" box just duplicated the top model's number.
	// The 2nd model adds real signal. Falls back to top provider only when there
	// is a single model (degenerate: nothing else to show).
	const topModel = data.models[0];
	const topModelTotal = data.modelTotal.get(topModel)!;
	const cellW = (W - 64) / 3;
	const kpi = (i: number, color: string, label: string, value: string): string => {
		const cx = 32 + i * cellW;
		const f: string[] = [];
		if (i > 0) f.push(`<line x1="${32 + i * cellW}" y1="80" x2="${32 + i * cellW}" y2="138" stroke="#3A3A40" stroke-width="1"/>`);
		f.push(`<circle cx="${cx + 14}" cy="104" r="5" fill="${color}"/>`);
		f.push(`<text x="${cx + 28}" y="100" fill="#8E8E8E" font-size="11">${xmlEscape(label)}</text>`);
		f.push(`<text x="${cx + 28}" y="126" fill="#FFFFFF" font-size="24" font-weight="700">${xmlEscape(value)}</text>`);
		return f.join("\n");
	};
	parts.push(`<line x1="32" y1="74" x2="${W - 32}" y2="74" stroke="#2E2E33" stroke-width="1"/>`);
	parts.push(kpi(0, "#3B82F6", "Total Token Consumption", fmt.tok(data.grandTotal)));
	parts.push(kpi(1, data.modelColor.get(topModel)!, `${topModel} Consumption`, fmt.tok(topModelTotal)));
	if (data.models.length >= 2) {
		const second = data.models[1];
		parts.push(kpi(2, data.modelColor.get(second)!, `${second} Consumption`, fmt.tok(data.modelTotal.get(second)!)));
	} else {
		// Single-model ledger: no 2nd model, so surface the provider dimension.
		let topProvider = "";
		let topProviderTotal = 0;
		for (const [p, t] of data.providerTotal) if (t > topProviderTotal) ((topProviderTotal = t), (topProvider = p));
		parts.push(kpi(2, "#A855F7", `${topProvider} Consumption`, fmt.tok(topProviderTotal)));
	}
	parts.push(`<line x1="32" y1="142" x2="${W - 32}" y2="142" stroke="#2E2E33" stroke-width="1"/>`);

	// Chart A: per-model multi-line (the reference layout).
	const seriesA: ChartSeries[] = data.models.map((m) => ({
		name: `${data.modelProvider.get(m)}:${m}`,
		color: data.modelColor.get(m)!,
		values: data.matrix.get(m)!,
	}));
	parts.push(lineChartFragment({ x: 24, y: 152, w: W - 48, h: 268 }, "By model", seriesA, data.dates, false));

	// Chart B: unified total across ALL models (single line + area fill).
	const seriesB: ChartSeries[] = [{ name: "Total", color: "#3B82F6", values: data.totalPerDay, fill: true }];
	parts.push(lineChartFragment({ x: 24, y: 436, w: W - 48, h: 300 }, "Total (all models combined)", seriesB, data.dates, true));

	parts.push(`</svg>`);
	return parts.join("\n");
}

/** Detect a system SVG→PNG converter on PATH. None → SVG-only output. */
function detectPngConverter(): { bin: string; kind: "rsvg" | "inkscape" } | null {
	for (const [bin, kind] of [
		["rsvg-convert", "rsvg"],
		["inkscape", "inkscape"],
	] as const) {
		// --version with a hard timeout: spawnSync blocks the Node event loop, so a
		// hung or slow binary (inkscape GUI boot, unreachable DISPLAY) must never
		// freeze the whole pi process. status!=0 (incl. timeout SIGTERM) → skip.
		const r = spawnSync(bin, ["--version"], { encoding: "utf8", timeout: 5000 });
		if (r.status === 0) return { bin, kind };
	}
	return null;
}

/** Run the detected converter. rsvg-convert is fastest and headless-native.
 *  inkscape flags below are 1.0+ syntax (--export-type/--export-filename);
 *  pre-1.0 inkscape (-e/--export-png) will fail and the error is surfaced. */
function renderPng(conv: { bin: string; kind: "rsvg" | "inkscape" }, svgPath: string, pngPath: string, width: number): { ok: boolean; error?: string } {
	const args =
		conv.kind === "rsvg"
			? ["-w", String(width), svgPath, "-o", pngPath]
			: [svgPath, "--export-type=png", `--export-filename=${pngPath}`, "-w", String(width)];
	// 30s cap: a small SVG rasterizes in well under a second; anything longer is
	// a hang. Blocks the event loop, so the timeout is mandatory, not optional.
	const r = spawnSync(conv.bin, args, { encoding: "utf8", timeout: 30_000 });
	if (r.status === 0) return { ok: true };
	if (r.error) return { ok: false, error: r.error.message };
	if (r.signal) return { ok: false, error: `killed by ${r.signal} (timeout?)` };
	return { ok: false, error: `exit ${r.status}` };
}

// ── Extension ────────────────────────────────────────────────────────────────

export default function (pi: ExtensionAPI) {
	// Register the number-style flag at factory load time. registerFlag is static
	// setup; calling it per session would clobber user preferences on every /new
	// or /reload. Default is seeded from the persisted settings.json so the
	// choice survives pi restarts; CLI --flag and env TOKEN_COST_LEDGER_NUMBERS
	// still override per-invocation / per-session. Values: "auto" | "comma" | "dot".
	const persistedStyle = loadNumberStyleSetting();
	pi.registerFlag("token-cost-ledger-numbers", {
		description:
			"Number format for /token-usage reports: \"auto\" (detect from terminal locale, default) | \"comma\" (1.148,23) | \"dot\" (1,148.23).",
		type: "string",
		default: persistedStyle,
	});

	// ── OPTIONS: /token-cost-ledger — interactive menu (sets the number-style flag) ─
	// Mirrors pi-glm-tweaks's /glm-tweaks: bare command opens an interactive
	// SettingsList the user cycles with Enter/Space (no typing required);
	// `<value>` or `set <value>` is kept as a one-shot shorthand. Outside TUI
	// (RPC/headless), falls back to the read-only status panel — custom
	// components are terminal-only.
	const NUMBER_STYLES = ["auto", "comma", "dot"] as const;
	type NumberStyleName = (typeof NUMBER_STYLES)[number];
	const STYLE_SAMPLES: Record<NumberStyleName, string> = {
		auto: "locale-detected",
		comma: "1.148,23",
		dot: "1,148.23",
	};

	// The flag value this extension controls — NOT the env-overridden
	// effective value (that's numberStyleSetting). The menu reads/writes the
	// flag; env (TOKEN_COST_LEDGER_NUMBERS) is a separate per-session override
	// the menu can't touch, surfaced in the header when it's masking the flag.
	function flagNumberStyle(): NumberStyleName {
		const v = (pi.getFlag("token-cost-ledger-numbers") as string | undefined)?.trim().toLowerCase();
		return (NUMBER_STYLES as readonly string[]).includes(v ?? "") ? (v as NumberStyleName) : "auto";
	}

	function renderStatusPanel(): string {
		const current = numberStyleSetting(pi);
		const lines = [
			"pi-token-cost-ledger — options",
			"",
			"  number format (token-cost-ledger-numbers):",
			...NUMBER_STYLES.map(
				(s) => `    ${current === s ? "[x]" : "[ ]"} ${s.padEnd(8)} ${STYLE_SAMPLES[s]}`,
			),
			"",
			"  set:    /token-cost-ledger <auto|comma|dot>",
			"  env:    TOKEN_COST_LEDGER_NUMBERS=<value> (per-session override)",
			"",
			"  refresh: /token-cost-ledger refresh  (pull latest costs from models.dev)",
		];
		return lines.join("\n");
	}

	/** Detect env TOKEN_COST_LEDGER_NUMBERS overriding the flag; true when set and differs. */
	function envOverrideState(): { masked: boolean; envOverride: string | undefined } {
		const envOverride = process.env.TOKEN_COST_LEDGER_NUMBERS?.trim().toLowerCase();
		const masked =
			(envOverride === "auto" || envOverride === "comma" || envOverride === "dot") &&
			envOverride !== flagNumberStyle();
		return { masked, envOverride };
	}

	/**
	 * Warn (single shared notify) when env is masking the flag the user just
	 * changed. Used by both the direct-set shorthand and the menu path so the
	 * wording stays in one place. No-op when nothing is masked.
	 */
	function warnIfEnvMasked(ctx: ExtensionCommandContext): void {
		const { masked, envOverride } = envOverrideState();
		if (!masked || !envOverride) return;
		ctx.ui.notify(
			`Note: env TOKEN_COST_LEDGER_NUMBERS=${envOverride} is still overriding the flag this session.`,
			"warning",
		);
	}

	/** Last-refresh date for the menu row label, from the override file's mtime. */
	function refreshLabel(baseDir: string): string {
		try {
			const st = statSync(join(baseDir, "prices.json"));
			return `last ${st.mtime.toISOString().slice(0, 10)}`;
		} catch {
			return "never";
		}
	}

	/** Human-readable summary of a refresh for the success notify. */
	function formatRefreshResult(r: RefreshResult): string {
		const parts = [`${r.updated.length} updated`, `${r.unchanged} unchanged`];
		if (r.missing.length > 0) parts.push(`${r.missing.length} preserved`);
		return `Refreshed prices from models.dev — ${parts.join(", ")}.`;
	}

	pi.registerCommand("token-cost-ledger", {
		description:
			"pi-token-cost-ledger options: open the menu (number format / refresh prices), or set directly. Usage: /token-cost-ledger [auto|comma|dot|refresh]",
		getArgumentCompletions: (prefix: string) => {
			const trailingSpace = /\s$/.test(prefix);
			const tokens = prefix.trim().split(/\s+/).filter(Boolean);
			const partial = trailingSpace ? "" : (tokens[tokens.length - 1] ?? "");
			// After `set` (with space or partial value), suggest values; else suggest
			// `set` + bare values as shorthand.
			const setComplete =
				(tokens.length === 1 && tokens[0] === "set") ||
				(tokens.length >= 2 && tokens[0] === "set");
			if (setComplete || tokens.length <= 1) {
				const hits = (setComplete ? NUMBER_STYLES : (["set", "refresh", ...NUMBER_STYLES] as const)).filter((v) =>
					v.startsWith(partial),
				);
				return hits.length ? hits.map((v) => ({ value: v, label: v })) : null;
			}
			return null;
		},
		handler: async (args, ctx) => {
			const trimmed = (args ?? "").trim().toLowerCase();

			// `/token-cost-ledger refresh` — pull live costs from models.dev into the
			// override. Network call; no reload needed (loadPrices re-reads per
			// query). Handled before the direct-set path so "refresh" isn't mistaken
			// for a number-style value.
			if (trimmed === "refresh") {
				const { primary } = loadRoots();
				ctx.ui.notify("Refreshing prices from models.dev...", "info");
				const res = await refreshPrices(primary);
				if (!res.ok) {
					ctx.ui.notify(`Failed to refresh prices: ${res.error}`, "error");
				} else {
					ctx.ui.notify(formatRefreshResult(res), "info");
				}
				return;
			}

			// Direct set: `/token-cost-ledger <value>` or `/token-cost-ledger set <value>`.
			// One-shot persist (settings.json) then reload — shorthand for users
			// who know what they want. Bare `set` (no value) falls through to menu.
			if (trimmed !== "" && trimmed !== "status" && trimmed !== "set") {
				const tokens = trimmed.split(/\s+/).filter(Boolean);
				const value = (tokens[0] === "set" ? tokens[1] : tokens[0]) as NumberStyleName | undefined;
				if (!value || !NUMBER_STYLES.includes(value)) {
					ctx.ui.notify(
						`Unknown value "${value ?? ""}". Valid: ${NUMBER_STYLES.join(", ")}.`,
						"warning",
					);
					return;
				}
				saveNumberStyleSetting(value);
				ctx.ui.notify(`token-cost-ledger-numbers: ${flagNumberStyle()} → ${value}. Reloading...`, "info");
				warnIfEnvMasked(ctx);
				await ctx.reload();
				return;
			}

			// Menu mode. Outside TUI (RPC/headless), fall back to the read-only
			// status panel — custom components are terminal-only.
			if (ctx.mode !== "tui") {
				ctx.ui.notify(renderStatusPanel(), "info");
				return;
			}

			const effective = numberStyleSetting(pi);
			const flagVal = flagNumberStyle();
			const { masked, envOverride } = envOverrideState();

			const { primary } = loadRoots();
			const pending = new Map<string, string>();
			const items: SettingItem[] = [
				{
					id: "token-cost-ledger-numbers",
					label: "Number format",
					description: "Thousands/decimal separators for /token-usage reports. Enter/Space cycles.",
					currentValue: flagVal,
					values: [...NUMBER_STYLES],
				},
				{
					// Refresh is an ACTION, not a setting. SettingsList has no "fire on
					// Enter" affordance beyond cycling values, so it's modeled as a
					// no/yes toggle: cycle to "yes" → staged, applied on close. Net-zero
					// (cycled back to "no") drops it, matching the number-format row's
					// back-out semantics. `/token-cost-ledger refresh` is the no-menu
					// keyword shortcut.
					id: "refresh-prices",
					label: "Refresh prices now",
					description: `Pull latest costs from models.dev. Last: ${refreshLabel(primary)}.`,
					currentValue: "no",
					values: ["no", "yes"],
				},
			];

			const header = masked
				? `pi-token-cost-ledger — options  (env TOKEN_COST_LEDGER_NUMBERS=${envOverride} is overriding the flag; effective=${effective})`
				: `pi-token-cost-ledger — options  (effective=${effective})`;

			await ctx.ui.custom((tui, theme, _kb, done) => {
				const container = new Container();
				container.addChild(new Text(theme.fg("accent", theme.bold(header)), 1, 1));

				const settingsList = new SettingsList(
					items,
					Math.min(items.length + 2, 15),
					getSettingsListTheme(),
					(id, newValue) => {
						// Stage the change; persist + reload on close, not here.
						// (SettingsList already refreshed its own display before
						// calling us — activateItem mutates item.currentValue.)
						pending.set(id, newValue);
					},
					() => done(undefined),
				);
				container.addChild(settingsList);

				return {
					render: (w: number) => container.render(w),
					invalidate: () => container.invalidate(),
					handleInput: (data: string) => {
						settingsList.handleInput(data);
						tui.requestRender();
					},
				};
			});

			// Dialog closed. ctx is still valid here (reload is the only staleness
			// trigger, and we haven't called it yet).
			//
			// Two independent intents may be staged: a number-format change (needs
			// settings.json + reload) and a refresh (writes prices.json, no reload).
			// Run refresh first so its notify lands before any reload; apply the
			// flag change last because reload ends this ctx.
			const refreshWanted = pending.get("refresh-prices") === "yes";
			const numValue = pending.get("token-cost-ledger-numbers");
			const numChanged = numValue !== undefined && numValue !== flagNumberStyle();

			if (refreshWanted) {
				const res = await refreshPrices(primary);
				if (!res.ok) {
					ctx.ui.notify(`Failed to refresh prices: ${res.error}`, "error");
				} else {
					ctx.ui.notify(formatRefreshResult(res), "info");
				}
			}

			if (!numChanged) return;

			// pending values come from the SettingsList row (NUMBER_STYLES), so any
			// non-empty value here is a valid style; narrow for the typed helper.
			if (!isNumberStyle(numValue)) return;
			saveNumberStyleSetting(numValue);
			ctx.ui.notify(`token-cost-ledger-numbers: ${flagVal} → ${numValue}. Reloading...`, "info");
			warnIfEnvMasked(ctx);
			await ctx.reload();
		},
	});

	// ── CAPTURE: append one record per assistant message (forks @ctogg) ──────
	// Best-effort: a logging side-channel must never break the chat session,
	// so any fs error (ENOSPC, EACCES, race) is swallowed.
	pi.on("message_end", async (event, _ctx) => {
		try {
			const msg = event.message as { role?: string; usage?: any; provider?: string; model?: string };
			if (msg.role !== "assistant") return;
			const usage = msg.usage;
			if (!usage?.cost) return;

			// Coerce to number; a provider returning a string field would otherwise
			// silently corrupt downstream sums via string concatenation.
			const num = (v: unknown) => (typeof v === "number" ? v : 0);

			const record: CostRecord = {
				ts: Date.now(),
				provider: msg.provider ?? "unknown",
				model: msg.model ?? "unknown",
				tokens: {
					input: num(usage.input),
					output: num(usage.output),
					cacheRead: num(usage.cacheRead),
					cacheWrite: num(usage.cacheWrite),
				},
				cost: {
					input: num(usage.cost.input),
					output: num(usage.cost.output),
					cacheRead: num(usage.cost.cacheRead),
					cacheWrite: num(usage.cost.cacheWrite),
					total: num(usage.cost.total),
				},
			};

			const { primary } = loadRoots();
			const file = dayFilePath(primary, new Date());
			await mkdir(path.dirname(file), { recursive: true });
			// O_APPEND makes a single-line write atomic under POSIX; concurrent
			// host writers (two pi tabs) are safe as long as each record is one
			// write(2) under PIPE_BUF, which a JSON line is.
			await appendFile(file, JSON.stringify(record) + "\n", "utf8");
		} catch (err) {
			// Swallow: never let the cost logger disrupt the chat. Logged to stderr
			// (not the pi UI) so a recurring failure is visible without being noisy.
			console.error("pi-token-cost-ledger: capture failed:", err instanceof Error ? err.message : err);
		}
	});

	// ── QUERY: /token-usage — quick-range menu (bare, TUI) or typed period ─
	// Bare command in TUI opens a SelectList picker; `<period>` skips the menu.
	// Both paths funnel through runQuery, so each menu item's value IS the
	// typed equivalent — the menu doubles as documentation of what to type.
	const QUICK_RANGES: readonly SelectItem[] = [
		{ value: "today", label: "Today", description: "Today only" },
		{ value: "days 7", label: "Last 7 days", description: "Rolling week incl. today" },
		{ value: "month", label: "This month", description: "Current calendar month" },
		{ value: "days 30", label: "Last 30 days", description: "Rolling 30 days incl. today" },
		{ value: "year", label: "This year", description: "Current calendar year" },
		{ value: "days 365", label: "Last 365 days", description: "Rolling year incl. today" },
		{ value: "all", label: "All history", description: "Everything in the ledger" },
	];
	const RANGE_LAYOUT = { minPrimaryColumnWidth: 12, maxPrimaryColumnWidth: 24 };

	// CHART: /token-usage chart [period] — renders an SVG dashboard (per-model
	// multi-line + unified single-line total) to <primary>/charts/. PNG emitted
	// too when a system converter (rsvg-convert / inkscape) is on PATH; no npm
	// dependency either way. Default window = last 30 days.
	const runChart = async (ctx: ExtensionCommandContext, argString: string): Promise<void> => {
		const { roots, primary } = loadRoots();
		const fmt = makeFormatter(resolveStyle(numberStyleSetting(pi)));
		const a = (argString ?? "").trim();
		const isAll = a.split(/\s+/)[0] === "all";
		const range = parseRange(a === "" ? "days 30" : a);
		if (!range) {
			ctx.ui.notify(
				"Usage: /token-usage chart [today | day [YYYY-MM-DD] | week [N] | days [N] | month [YYYY-MM] | year [YYYY] | all]",
				"warning",
			);
			return;
		}
		const dateList = isAll ? null : dateRange(range.start, range.end);
		const records = isAll ? await readAllRecords(roots) : await readRecords(roots, dateRange(range.start, range.end));
		const data = buildChartData(records, dateList);
		const svg = buildUsageSVG(range, data, fmt);

		const dir = join(primary, "charts");
		await mkdir(dir, { recursive: true });
		const stem = `usage-${dayKey(data.spanStart)}_${dayKey(data.spanEnd)}`;
		const svgPath = join(dir, `${stem}.svg`);
		await writeFile(svgPath, svg, "utf8");

		const conv = detectPngConverter();
		let pngPath: string | null = null;
		let pngErr: string | null = null;
		if (conv) {
			const p = join(dir, `${stem}.png`);
			const r = renderPng(conv, svgPath, p, 1600);
			if (r.ok) pngPath = p;
			else pngErr = r.error ?? "unknown error";
		}

		// Three distinct outcomes, each with its own message — a converter present
		// but failing must NOT silently degrade to an indistinguishable SVG-only.
		const lines = [`Chart: ${svgPath}`];
		if (pngPath) lines.push(`PNG : ${pngPath}`);
		else if (pngErr) lines.push(`PNG failed (${conv!.bin}): ${pngErr}`);
		else lines.push("(SVG only — install rsvg-convert or inkscape for PNG)");
		ctx.ui.notify(lines.join("\n"), "info");
	};

	// Shared query runner — menu (on select) and typed path both call this.
	// Loads roots/prices/formatter fresh per call (cheap; matches the old
	// inline behavior).
	const runQuery = async (ctx: ExtensionCommandContext, argString: string): Promise<void> => {
		const { roots, primary } = loadRoots();
		const prices = loadPrices(primary);
		const idx = buildPriceIndex(prices);
		const conv = cacheConv();
		const fmt = makeFormatter(resolveStyle(numberStyleSetting(pi)));

		const a = (argString ?? "").trim();
		const parts = a.split(/\s+/).filter(Boolean);

		// chart [period] — render the SVG dashboard (per-model + unified total),
		// optional PNG when a system converter (rsvg-convert/inkscape) is present.
		if (parts[0] === "chart") {
			await runChart(ctx, parts.slice(1).join(" "));
			return;
		}

		// model <name> — special path: scan all history for one model.
		if (parts[0] === "model" && parts[1]) {
			const all = await readAllRecords(roots);
			ctx.ui.notify(renderModel(ctx.ui.theme, parts.slice(1).join(" "), all, idx, conv, fmt), "info");
			return;
		}

		const range = parseRange(a);
		if (!range) {
			ctx.ui.notify(
				`Usage: /token-usage [today | day [YYYY-MM-DD] | week [N] | days [N] | month [YYYY-MM] | year [YYYY] | all | model <name>]\nconv: ${conv}`,
				"warning",
			);
			return;
		}

		const dates = dateRange(range.start, range.end);
		// `all` walks the ledger directory instead of materializing a multi-year
		// date range. The sentinel start/end is ignored.
		const records = parts[0] === "all" ? await readAllRecords(roots) : await readRecords(roots, dates);
		const agg = aggregate(records, idx, conv, range.subtotalKey);
		ctx.ui.notify(renderTable(ctx.ui.theme, range, agg, conv, fmt), "info");
	};

	pi.registerCommand("token-usage", {
		description:
			"Token & cost usage. /token-usage (opens range menu) | /token-usage <today|day|week|days|month|year|all|model> | /token-usage chart [period] (SVG dashboard + optional PNG). Shows real USD and api-equiv USD.",
		handler: async (args, ctx) => {
			const a = (args ?? "").trim();
			// Bare command in TUI → quick-range menu. Non-TUI (RPC/headless) and
			// any explicit args skip the menu and go straight to runQuery; bare
			// non-TUI falls through to parseRange's today default (old behavior).
			if (a === "" && ctx.mode === "tui") {
				let chosen: string | null = null;
				await ctx.ui.custom((tui, theme, _kb, done) => {
					const container = new Container();
					container.addChild(
						new Text(theme.fg("accent", theme.bold("Token usage — select a range")), 1, 1),
					);
					const selectList = new SelectList(
						[...QUICK_RANGES],
						QUICK_RANGES.length,
						getSelectListTheme(),
						RANGE_LAYOUT,
					);
					selectList.onSelect = (item) => {
						chosen = item.value;
						done(undefined);
					};
					selectList.onCancel = () => done(undefined);
					container.addChild(selectList);
					return {
						render: (w: number) => container.render(w),
						invalidate: () => container.invalidate(),
						handleInput: (data: string) => {
							selectList.handleInput(data);
							tui.requestRender();
						},
					};
				});
				// Dialog closed. ctx still valid (no reload happened). Run the
				// chosen range; Esc/cancel → chosen stays null, no-op.
				if (chosen) await runQuery(ctx, chosen);
				return;
			}
			await runQuery(ctx, a);
		},
	});
}
