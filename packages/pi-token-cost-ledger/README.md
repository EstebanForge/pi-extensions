# @estebanforge/pi-token-cost-ledger

Token & cost ledger for [Pi](https://github.com/earendil-works/pi-coding-agent). Captures every assistant message to a per-day JSONL ledger and exposes a `/token-usage` command with by-model and by-period breakdowns showing **both** real USD and API-equivalent USD.

## Why two dollar figures

On a flat coding plan the marginal cost/token is `$0` — useless for comparison. So alongside the provider's **real** cost, every report shows **api-equiv**: what the same tokens would cost pay-as-you-go on GLM's public API. That's the apples-to-apples axis vs Anthropic/OpenAI.

## Install

```
pi install npm:@estebanforge/pi-token-cost-ledger
```

## Usage

```
/token-usage                   opens a range menu (bare, in TUI)
/token-usage today
/token-usage day [YYYY-MM-DD]      today, or a specific day
/token-usage week [N]              current ISO week; N = weeks ago
/token-usage days [N]              rolling N-day window incl. today (default 30)
/token-usage month [YYYY-MM]       current month, or a specific one
/token-usage year [YYYY]           current year, or a specific one
/token-usage all                   full history
/token-usage model <name>          one model across all history, by month
/token-usage chart [period]        render a usage dashboard (SVG + optional PNG)
```

Run `/token-usage` with no argument (in the TUI) to pick a range from a menu:
**Today · Last 7 days · This month · Last 30 days · This year · Last 365 days · All**. Arrow keys to move, Enter to select, Esc to cancel. In headless/RPC mode, bare `/token-usage` still defaults to today. Each menu item maps to the typed form shown above, so the menu doubles as a cheat sheet.

Each report prints:

- **Total** — real $ · api-equiv $ · total tokens · calls
- **By model** — per-model breakdown
- **By period** — day or month subtotals (when the range spans more than one)

## Charts

`/token-usage chart [period]` renders a usage dashboard as a self-contained
**SVG** to `~/.pi/extensions-data/estebanforge/pi-token-cost-ledger/charts/usage-<start>_<end>.svg`,
then prints the path. A **PNG** is written alongside when `rsvg-convert` or
`inkscape` is on PATH — **no npm dependencies are added either way** (SVG is
pure string templating; PNG relies on a system binary you may already have).

```
/token-usage chart              last 30 days (default)
/token-usage chart today
/token-usage chart days 7
/token-usage chart month
/token-usage chart all
```

The dashboard adapts the single-vendor "usage details" convention to pi's
multi-provider reality:

- **KPI row** — Total token consumption · top **model** consumption · top
  **provider** consumption (so the cross-provider split is visible at a glance).
- **By model** — one line per model, colored by usage rank; legend reads
  `provider:model`. The busiest model always takes the amber line.
- **Total (all models combined)** — a second chart with a single filled line
  summing every model, for the overall trend.

The period accepts anything the text command does (`today`, `day [D]`,
`week [N]`, `days [N]`, `month [YYYY-MM]`, `year [YYYY]`, `all`). SVG needs
nothing; PNG is emitted only when a converter is found on `PATH`. These are
**optional system dependencies** — the extension adds no npm packages for
rendering.

**Linux** (Debian / Ubuntu):

```
sudo apt install librsvg2-bin      # rsvg-convert — fastest, headless-native
# or
sudo apt install inkscape
```

Fedora / RHEL:

```
sudo dnf install librsvg2          # provides rsvg-convert
# or
sudo dnf install inkscape
```

Arch:

```
sudo pacman -S librsvg             # provides rsvg-convert
# or
sudo pacman -S inkscape
```

**macOS** (Homebrew):

```
brew install librsvg               # provides rsvg-convert (recommended)
# or
brew install --cask inkscape
```

`rsvg-convert` (from `librsvg`) is preferred — small, fast, and built for
headless conversion. `inkscape` works but is heavier. If neither is present,
the SVG is still written and the notify notes how to enable PNG.

## How it works

- **Capture.** A `message_end` hook appends `{ts, provider, model, tokens, cost}` to `~/.pi/extensions-data/estebanforge/pi-token-cost-ledger/YYYY/MM/DD.jsonl`. Format is unchanged from the legacy ledger, so existing files are valid with zero migration.
- **Pricing.** api-equiv is computed at query time from current prices (reprice semantics — history always reflects the latest price file). A default `prices.json` ships with the extension; `~/.pi/extensions-data/estebanforge/pi-token-cost-ledger/prices.json` overrides it if present. See **Updating prices** below.
- **Multi-root.** Reads `~/.pi/extensions-data/estebanforge/pi-token-cost-ledger/roots.conf` (one path/line, `#` comments, first = primary write target). Disjoint ledgers (e.g. a construct sandbox) are unioned read-only; no dedup needed. Honors `PI_COST_LEDGER` / `PI_COST_LEDGERS` env overrides.
- **Cache convention.** `CACHE_CONV=separate` (default) treats `cacheRead` as a subset of input; `CACHE_CONV=included` treats input as the full prompt. Matches the old scripts.
- **Number format.** Controlled by the `token-cost-ledger-numbers` flag or `TOKEN_COST_LEDGER_NUMBERS` env:
  - `auto` (default) — detect from the terminal locale (`LC_ALL` > `LC_NUMERIC` > `LANG`) via `Intl.NumberFormat`. Respects each user's locale.
  - `comma` — Latin/European: `1.148,23` (dot thousands, comma decimal)
  - `dot` — Anglo: `1,148.23` (comma thousands, dot decimal)

  Set with `/token-cost-ledger` (opens an interactive menu — cycle with Enter/Space, persists on close), `/token-cost-ledger comma` (one-shot shorthand), `pi config set token-cost-ledger-numbers comma`, or per-session with `TOKEN_COST_LEDGER_NUMBERS=comma pi`.

## Commands

| Command | Description |
| --- | --- |
| `/token-usage` | Open the range menu (Today / Last 7-30-365 days / This month / This year / All). |
| `/token-usage <period>` | Query usage directly (today/day/week/days/month/year/all/model). See Usage above. |
| `/token-usage chart [period]` | Render a usage dashboard (SVG + optional PNG) to `<ledger>/charts/`. Default: last 30 days. |
| `/token-cost-ledger refresh` | Pull latest costs from models.dev into the override (network). |
| `/token-cost-ledger` | Open the interactive options menu (number format / refresh prices). |
| `/token-cost-ledger <auto\|comma\|dot>` | Set number format directly (one-shot shorthand; persists + reloads). |

## Updating prices

The bundled `extensions/prices.json` holds canonical **first-party** rates per 1M tokens (input / cache-read / output), keyed by the exact model string pi logs. Source: [**models.dev**](https://models.dev) — an open-source database of AI model specs and pricing.

### Refresh from models.dev (in pi)

Run `/token-cost-ledger refresh` (or open `/token-cost-ledger` and set **Refresh prices now → yes**) to pull the live [models.dev](https://models.dev/catalog.json) catalog and update the override file at `~/.pi/extensions-data/estebanforge/pi-token-cost-ledger/prices.json`. Load precedence means the next `/token-usage` reflects it immediately — no reload.

The refresh is **update-only**: it refreshes costs for models already tracked, and preserves meta keys, hand-curated extras (e.g. grok / deepseek / mimo from non-first-party providers), and per-model `_tier_note` annotations. It does **not** add new models — those arrive via bundled-file releases. A network failure changes nothing.

### Manual edit / regenerate

To regenerate from scratch or add models, extract from the catalog with jq:

```bash
curl -sL https://models.dev/catalog.json -o /tmp/models-dev-catalog.json

# Extract canonical first-party pricing (zai, anthropic, minimax, google, openai)
jq -rc '.providers | to_entries[] | .key as $p
  | select($p|test("^(zai|anthropic|minimax|google|openai)$"))
  | .value.models // {} | to_entries[]
  | select(.value.cost != null)
  | {provider:$p, model:.key, cost:.value.cost, name:.value.name}' \
  /tmp/models-dev-catalog.json
```

Map catalog `{input, output, cache_read}` → this file's `{i, o, c}`. Keys match the ledger's model string case-insensitively (both sides are lowercased at lookup). A trailing Z.ai coding-plan route suffix (`[1m]`, as in `glm-5.3-flash[1m]`) is stripped automatically when the exact key misses, so only the base model needs an entry — `[1m]` is a routing variant of the same model at the same price, never a catalog SKU. Models with context-tier pricing use the **default tier** (<200K / <512K context); the over-tier rate is noted in `_tier_note`. After editing, no reload is needed — queries re-read the file each call.

models.dev alternatives: the catalog JSON (`catalog.json` / `models.json` / `providers.json`), the `@opencode-ai/models` npm SDK (typed snapshot for offline use), or TOML sources on GitHub.

## Data layout

```
~/.pi/extensions-data/estebanforge/pi-token-cost-ledger/
├── roots.conf          # ledger roots (optional; auto-detects host + construct)
├── prices.json         # GLM prices override (optional; bundled default otherwise)
├── 2026/07/22.jsonl    # one record per assistant message, append-only
└── 2026/07/23.jsonl
```

## License

MIT
