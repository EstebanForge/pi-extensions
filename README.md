# pi-extensions

Sixteen [Pi Coding Agent](https://github.com/earendil-works) extensions in one npm workspace. Install only what you need; each package publishes and installs on its own under the `@estebanforge` scope.

```bash
pi install npm:@estebanforge/pi-agentmemory
```

## Packages

| Package | Role |
| --- | --- |
| [`pi-agentmemory`](packages/pi-agentmemory) | Cross-session memory via the agentmemory REST API |
| [`pi-antigravity-bridge`](packages/pi-antigravity-bridge) | Bridge Pi to Google Antigravity: ACP driver, approval gates, ask tool |
| [`pi-asana-me`](packages/pi-asana-me) | Asana tasks, projects, and comments |
| [`pi-ask-antigravity`](packages/pi-ask-antigravity) | One-shot delegation to Antigravity |
| [`pi-ask-claude`](packages/pi-ask-claude) | One-shot delegation to Claude Code |
| [`pi-ask-codex`](packages/pi-ask-codex) | One-shot delegation to OpenAI Codex |
| [`pi-codegraph-enhanced`](packages/pi-codegraph-enhanced) | CodeGraph code intelligence tools |
| [`pi-deepwiki`](packages/pi-deepwiki) | DeepWiki repository research |
| [`pi-git-me`](packages/pi-git-me) | git + GitHub write policy tools |
| [`pi-glm-tweaks`](packages/pi-glm-tweaks) | Z.ai GLM provider tuning |
| [`pi-hostname`](packages/pi-hostname) | Hostname indicator |
| [`pi-mixture-of-agents`](packages/pi-mixture-of-agents) | Second-opinion reference models over transcripts |
| [`pi-show-me-the-meat`](packages/pi-show-me-the-meat) | Reading-diff tool: reduces a git diff to the lines that carry the change |
| [`pi-slack-me`](packages/pi-slack-me) | Slack read and post tools |
| [`pi-token-cost-ledger`](packages/pi-token-cost-ledger) | Per-session token cost ledger |
| [`pi-zendesk-me`](packages/pi-zendesk-me) | Zendesk ticket tools |

## Development

```bash
npm install        # once, at the root
npm run check      # typecheck + tests for the whole fleet
```

Layout: each package is uniform. `extensions/` holds the pi entrypoint declared in each manifest's `pi.extensions` field, `lib/` holds shared helpers where present, `tests/` holds every test. One root `tsconfig.json`, one root `vitest.config.ts`, toolchain dependencies live only at the root.

## Versions and releases

Versions are per-package: a package's version moves only when that package releases. One-off fixes and tweaks release a single package. The fleet stamp exists for moments when everything moves at once (dependency bumps, mass changes): it adds one version level to every package from its own current version, so histories stay independent.

```bash
npm run rel <name> patch     # release one package: check, bump, lockfile, commit, tag <name>-v<version>
npm run pub <name>           # full check, then npm publish for that package only

npm run release:patch        # fleet stamp: check, then +1 on every package, one commit, tag fleet-v<x.y.z>
npm run publish              # full check, then npm publish for every package
```

The registry holds different versions per package by design. Right after a fleet stamp every package has cleared its own registry version, so the blanket publish works; after individual releases, publish those packages individually. Existing installs keep working: package names and entrypoints are unchanged by the monorepo migration.

## License

MIT.
