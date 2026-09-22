# Changelog

## 1.2.3 — 2026-08-26

### Added
- **Prices for GLM-5.3-Flash** (list rates per the Z.ai pricing page:
  $0.15 input / $0.03 cache-read / $0.50 output per 1M; 50% launch promo
  through 2026-09-09, list encoded). Same gap class as glm-5.3 in 1.2.2:
  models.dev lags new Z.ai releases and `/token-cost-ledger refresh` is
  update-only by design, so the entry ships in the bundled file — and was
  also hand-added to the live override so flash turns are priced today.

### Fixed
- **`[1m]` coding-plan route suffixes now price against the base model.**
  Z.ai's 1M-context routes (`glm-5.3[1m]`, `glm-5.3-flash[1m]`) are distinct
  model ids in pi, and the ledger records `msg.model` verbatim — so every
  `[1m]` turn missed the exact-match lookup and reported `$0.00 api-equiv`
  plus unpriced-model warning noise. `lookupPrice` now strips one trailing
  bracket group when the exact key misses (exact match always wins first;
  unknown models still miss). Also corrected the README's stale
  "case-sensitive keys" claim — the index lowercases both sides.

## 1.2.2 — 2026-08-20

### Fixed
- **Prices for GLM-5.3 and Claude Opus 5.** Added bundled `prices.json` entries for `glm-5.3` (\$1.40 input / \$0.26 cache-read / \$4.40 output per 1M, per the published Z.ai pricing page) and `claude-opus-5` (\$5 / \$0.50 / \$25, per models.dev). Both models had no entry, so about 7.8K calls (973M tokens) rendered as `$0.00 api-equiv` and tripped the unpriced-model warning. models.dev has not listed GLM-5.3 yet, which is why `/token-cost-ledger refresh` could not close the gap (refresh is update-only by design; new models ship with the bundled file).

## 1.2.1 — 2026-08-06

### Changed
- **Dependencies updated.** Raised the `pi-coding-agent` dev pin to `^0.84.0`. Audited against the pi v0.84.0 breaking changes (renamed `ModelsRequestTransforms`, null-tolerant `getApiKeyAndHeaders` headers, dropped `message_update` partial fields, v4 session APIs); no code changes were needed and `tsc`/`typecheck` passes against 0.84.0.

## 1.2.0 — 2026-08-03

### Added
- **Usage charts.** `/token-usage chart [period]` renders a usage dashboard as
  a self-contained **SVG** (dark theme, KPI row + per-model multi-line chart +
  a second unified single-line chart summing all models) to
  `<ledger>/charts/usage-<start>_<end>.svg`. A **PNG** is emitted alongside
  when `rsvg-convert` or `inkscape` is on PATH — zero npm dependencies either
  way. Default window is the last 30 days; any period the text command accepts
  works (`today`, `days N`, `week`, `month`, `year`, `all`). Adapts the
  single-vendor dashboard convention to pi's multi-provider reality: the KPI
  row shows **Total / top model / top provider**, and the per-model legend
  reads `provider:model`.

## 1.1.1 — 2026-07-21

### Fixed
- **Setting the number format no longer crashes.** `/token-cost-ledger <auto|comma|dot>`
  and the menu's apply path tried to persist via `pi config set`, which is not a
  real command (`pi config` only accepts `-l/--approve/--no-approve`; any
  positional arg throws "Unexpected argument set" and exits 1). Selecting a
  separator failed with `Failed to apply: token-cost-ledger-numbers (Unexpected
  argument set)`.
  - The chosen style now persists to a file-backed store (`settings.json` next
    to `prices.json` in the ledger data dir), seeded into `registerFlag` at load.
    `pi config set` is gone; setting calls `saveNumberStyleSetting` then
    `/reload` (the reload re-seeds the flag from disk).
  - The setting now survives a full pi restart too — the old mechanism never
    persisted at all (extension flags are in-memory only; there is no CLI for
    them).

## 1.1.0 — 2026-07-21

### Added
- **Price refresh from models.dev.** `/token-cost-ledger refresh` (or the
  **Refresh prices now** row in the `/token-cost-ledger` menu) pulls the live
  [models.dev](https://models.dev/catalog.json) catalog and updates the
  override `prices.json`. Update-only for tracked models; preserves meta keys,
  hand-curated extras, and `_tier_note` annotations. Atomic write; a network
  failure changes nothing. Load precedence means the next `/token-usage`
  reflects it immediately (no reload).
- **Quick-range menu for `/token-usage`.** Bare `/token-usage` (no args, in the
  TUI) now opens an interactive picker: Today, Last 7 days, This month, Last
  30 days, This year, Last 365 days, All. Arrow keys + Enter; Esc cancels.
  Typed periods still work as before; headless/RPC mode still defaults to today.
- **`days [N]` period.** Rolling N-day window ending today (inclusive), e.g.
  `/token-usage days 7`. Subtotals switch to per-month once N > 31 to avoid
  screen overflow.

### Changed
- **Breaking: `/usage` renamed to `/token-usage`.** No alias. The old command
  name is gone. Update any muscle memory, scripts, or docs that call `/usage`.
- **`/token-cost-ledger` bare command now opens an interactive menu.** In the
  TUI it cycles number format (auto/comma/dot) and offers a refresh-prices
  row via Enter/Space; the old read-only status panel survives only as the
  headless/RPC fallback. Typed shorthand (`/token-cost-ledger comma`) is
  unchanged.
- **`/token-usage days [N]` rejects N > 3650.** Sanity cap on the typed path
  (~10 years); the menu uses fixed 7/30/365, so this only guards against
  typos like `days 999999` probing a file per day.

## 1.0.0 — 2026-07-22

Initial release. One extension replaces the former 3-part token-cost setup
(`@ctogg/pi-cost-counter` + `api-equiv.sh` + `tokens.zsh` + `monthly-rollup.sh`).
Owns the full lifecycle: capture every assistant message to a JSONL ledger, then
query it with a `/usage` command across day/week/month/year/all/model dimensions,
showing both real USD (provider cost) and API-equivalent USD (recomputed from a
bundled price file, since on a flat plan the marginal cost is `$0` and only the
API-equiv axis is comparable across vendors).

### Added
- **Capture.** A `message_end` hook appends `{ts, provider, model, tokens, cost}`
  to a per-day JSONL ledger at `~/.pi/extensions-data/<author>/<extension>/YYYY/MM/DD.jsonl`.
  Record format is byte-compatible with the legacy `@ctogg` ledger, so ~20 prior
  files are valid day one with zero migration.
- **`/usage` command.** Periods: `today` | `day [YYYY-MM-DD]` | `week [N]` |
  `month [YYYY-MM]` | `year [YYYY]` | `all` | `model <name>`. Each report prints
  grand totals (calls, tokens in/out/cache/total, real $ + api-equiv $), a
  by-model breakdown, and by-day or by-month subtotals when the window spans
  more than one period. Case-insensitive model match with known-models hint on
  miss.
- **Two cost figures.** Real USD comes straight from the provider's `cost.total`;
  api-equiv USD is computed at query time from current prices (reprice semantics
  — history always reflects the latest price file, never a stale snapshot).
- **Bundled `prices.json`** with canonical first-party rates (GLM, Claude,
  Gemini, GPT, Grok, DeepSeek, MiniMax, MiMo) sourced from [models.dev](https://models.dev).
  Override at `<ledger>/prices.json` takes precedence; both are re-read each call,
  so edits take effect immediately (no reload).
- **Unpriced-model warning.** Records whose model has no price entry (experiment
  aliases, unknown providers) are tracked and surfaced as a `⚠ N calls had no
  price entry — shown as $0,00` line instead of silently folding into the total.
- **Case-insensitive price lookup.** Ledger model strings (mixed case, e.g.
  `MiniMax-M3`) match canonical lowercase price keys via a `PriceIndex` built
  once per query, so casing drift never reports phantom `$0,00`.
- **Multi-root ledger.** Reads `<ledger>/roots.conf` (one path/line, `#` comments,
  first = primary write target). Disjoint ledgers are unioned read-only; no dedup.
  Honors `PI_COST_LEDGER` / `PI_COST_LEDGERS` env overrides.
- **Construct-cli sandbox aggregation.** Auto-detects the sandbox ledger under
  `~/.config/construct-cli/home/...` when running on the host, so `/usage`
  shows unified host + sandbox spend. Host-only by construction: inside the
  sandbox, `homedir()` is the overlay root, so the union is disabled (no phantom
  nested path, no double-count).
- **Locale-aware number formatting.** `/usage` reports respect the terminal's locale: group/decimal separators are detected from `LC_ALL` > `LC_NUMERIC` > `LANG` (POSIX precedence) via `Intl.NumberFormat.formatToParts`. Override with the `token-cost-ledger-numbers` flag or `TOKEN_COST_LEDGER_NUMBERS` env (`auto` default | `comma` for `1.148,23` | `dot` for `1,148.23`). Default `auto` means each user sees their own convention without configuration.
- **`/token-cost-ledger` command.** Options status panel by default; `/token-cost-ledger <auto|comma|dot>` (or `set <value>`) changes the number format via `pi config set` + reload. Tab-completion for the three values. Mirrors the `/glm-tweaks` pattern.
- **`CACHE_CONV`** env (`separate` default | `included`) controls whether
  `cacheRead` is treated as a subset of input or as part of the full prompt;
  surfaced in the report header.

### Design
- **Storage convention.** Introduces a GitHub-scoped layout for extension data:
  `~/.pi/extensions-data/<author>/<extension>/`. No pi standard existed (surveyed
  `getAgentDir()`-based and ad-hoc paths across installed extensions); this
  convention is collision-proof, self-documenting, and derives from pi's
  `getAgentDir()` so it inherits `PI_CODING_AGENT_DIR` overrides.
- **Soft-fail read paths.** Per-file JSONL reads stream line-by-line and swallow
  malformed lines, unreadable files, and mid-read failures (rotated/permission-
  flipped). A single bad file never crashes `/usage`. Records are shape-guarded
  (`isCostRecord`: `ts` is number, `tokens` is object) so legacy or partial
  records skip cleanly rather than blowing up aggregation.
- **Best-effort capture.** The `message_end` hook wraps all filesystem work in
  try/catch — a logging side-channel must never break the chat session. Disk
  full / permission errors are swallowed and logged to stderr.
- **Numeric coercion at capture.** Provider usage fields are coerced to number
  before write, so a provider returning a string field can't corrupt downstream
  sums via string concatenation.
- **`/usage all` walks the directory.** Uses `readAllRecords` (directory walk
  touching only existing files) instead of materializing a multi-year date range.
  No hardcoded floor year.

### Notes
- **Migration from the old setup.** Uninstall `@ctogg/pi-cost-counter`
  (`pi uninstall npm:@ctogg/pi-cost-counter`); the old `api-equiv.sh`,
  `monthly-rollup.sh`, `tokens.zsh`, and `install.sh` can be deleted. Historical
  JSONL files are read in place — no data migration, no re-import. Legacy
  `monthly/*.json` rollups are ignored (the extension reads raw JSONL directly).
- **Parity verified** against the old `api-equiv.sh --by-month` TOTAL row on
  cutover: api-equiv USD matched to the cent ($1.148,23); real USD ($70,53) is
  newly visible (the old scripts discarded `cost.total`).
- **Tier-priced models** (Gemini Pro, GPT-5.5/5.6, MiniMax-M3 over 200K/272K/512K
  context) use the default tier in `prices.json`; the over-tier rate is noted in
  `_tier_note` for manual reference.
- **Refresh prices** with the documented `curl` + `jq` recipe (see README
  "Updating prices") against `https://models.dev/catalog.json`. Keys must match
  the ledger's model string; case is normalized automatically.
