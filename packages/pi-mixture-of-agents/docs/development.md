# Development & Testing

How to run this extension locally in Pi without publishing to npm or GitHub.
No compilation step. Pi loads extensions via [jiti](https://github.com/unjs/jiti),
so TypeScript sources in `extensions/` and `lib/` run as-is.

## Prerequisites

- Pi installed (`@earendil-works/pi-coding-agent`)
- `npm install` once in this repo so peers resolve from `node_modules/`:
  ```bash
  npm install
  ```
- At least one reference model and one aggregator model already configured in
  Pi (`~/.pi/agent/models.json` or a provider with credentials). The extension
  ships no API keys.

## Run it (three ways, cheapest first)

### 1. One-off run with `-e` (no install)

Quickest iteration loop. Loads the extension into a temp dir for the current
session only; nothing is written to settings.

```bash
pi -e ./extensions
```

Point the flag at the `extensions/` **directory** (it has the `index.ts` entry).
For a one-shot prompt instead of an interactive session:

```bash
pi -e ./extensions -p "summarize this repo"
```

Good for: smoke-testing a code change in isolation.

### 2. Install from a local path (persistent, live source)

Registers the package by path. No copy, no publish. Edits take effect on
`/reload`. This is the closest to a real install and respects the `pi` manifest
in `package.json` (`pi.extensions: ["./extensions"]`).

Project-scoped (recommended; writes `.pi/settings.json` in this repo, travels
with the checkout):

```bash
pi install -l .
```

Global (writes `~/.pi/agent/settings.json`, always-on across projects):

```bash
pi install .
```

Then verify the provider registered:

```bash
pi --list-models | rg moa
```

In a Pi session: `/reload` after edits, then `/model moa/<preset>` or `/moa`.

Good for: long sessions, dogfooding across many turns, sharing via the repo.

### 3. Project-local auto-discover (alternative)

Drop the package path into `.pi/settings.json` manually under `extensions`:

```json
{
  "extensions": ["."]
}
```

Same effect as option 2 project-scoped. Use whichever you prefer; `pi install -l .`
is the documented shorthand.

## Config file locations (where presets live)

The extension reads presets from two JSON files, user then project override:

| Scope | Path |
| --- | --- |
| User (global) | `~/.pi/agent/moa.json` |
| Project | `<cwd>/.pi/moa.json` (uses `CONFIG_DIR_NAME`, so rebranded distributions honor their own dir) |

If neither exists, `/moa` opens the menu; pick `New preset…` to create one. Delete the file to reset.

## Verify after a code change

1. Reload: in the session run `/reload`, or restart Pi.
2. Confirm provider is live:
   ```bash
   pi --list-models | rg 'moa/'
   ```
3. Confirm command wiring: in a session run `/moa`. It should print your
   presets (or "no presets configured" on a fresh install).
4. End-to-end smoke: `/moa <some prompt>` runs refs + aggregator once; or pick
   `moa/<preset>` from `/model` for a full agent turn.

## Automated tests

Vitest suite under `tests/`. Runs without a live Pi session or network.

```bash
npm test           # vitest run
npm run typecheck  # tsc --noEmit
```

Coverage: `config`, `dedup`, `engine`, `stream-facade`, `transcript`,
`integration`. Add new behavior here first (red), then implement.

The `integration` suite is **skipped by default**; it hits a real model
configured in `moa.json` and may cost money. Opt in explicitly:

```bash
MOA_INTEGRATION=1 npx vitest run tests/integration.test.ts
```

Needs at least one reference and one aggregator preset in `~/.pi/agent/moa.json`
(or `.pi/moa.json`). Leaves the default `npm test` offline and free.

## Project trust

First time Pi enters this repo it will ask to trust `.pi/`. Answer yes (or
pre-trust). Project-local extensions and `.pi/moa.json` load only after trust
is resolved.

## Layout

```
extensions/index.ts   entry; registers provider + commands
lib/                  config, engine, slots, stream-facade, transcript, dedup, types, prompts
tests/                vitest suites
docs/                 this file
```

## Iteration checklist

- [ ] `npm install` (once, and after dependency changes)
- [ ] Edit source in `extensions/` or `lib/`
- [ ] `npm test && npm run typecheck`
- [ ] `pi -e ./extensions` (smoke) **or** `/reload` (if installed)
- [ ] `pi --list-models | rg moa` confirms provider
- [ ] `/moa` opens the drill-down menu; the read-only listing shows in headless
