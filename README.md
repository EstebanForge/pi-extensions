# pi-extensions

Sixteen [Pi Coding Agent](https://github.com/earendil-works/pi) extensions in one npm workspace. Install only what you need; each package publishes and installs on its own under the `@estebanforge` scope.

## Extensions

### [pi-agentmemory](packages/pi-agentmemory)

Cross-session memory via the agentmemory REST API.

```bash
pi install npm:@estebanforge/pi-agentmemory
```

### [pi-antigravity-bridge](packages/pi-antigravity-bridge)

Bridge Pi to Google Antigravity: ACP driver, approval gates, ask tool.

```bash
pi install npm:@estebanforge/pi-antigravity-bridge
```

### [pi-asana-me](packages/pi-asana-me)

Asana tasks, projects, and comments.

```bash
pi install npm:@estebanforge/pi-asana-me
```

### [pi-ask-antigravity](packages/pi-ask-antigravity)

One-shot delegation to Antigravity.

```bash
pi install npm:@estebanforge/pi-ask-antigravity
```

### [pi-ask-claude](packages/pi-ask-claude)

One-shot delegation to Claude Code.

```bash
pi install npm:@estebanforge/pi-ask-claude
```

### [pi-ask-codex](packages/pi-ask-codex)

One-shot delegation to OpenAI Codex.

```bash
pi install npm:@estebanforge/pi-ask-codex
```

### [pi-codegraph-enhanced](packages/pi-codegraph-enhanced)

CodeGraph code intelligence tools.

```bash
pi install npm:@estebanforge/pi-codegraph-enhanced
```

### [pi-deepwiki](packages/pi-deepwiki)

DeepWiki repository research.

```bash
pi install npm:@estebanforge/pi-deepwiki
```

### [pi-git-me](packages/pi-git-me)

git + GitHub write policy tools.

```bash
pi install npm:@estebanforge/pi-git-me
```

### [pi-glm-tweaks](packages/pi-glm-tweaks)

Z.ai GLM provider tuning.

```bash
pi install npm:@estebanforge/pi-glm-tweaks
```

### [pi-hostname](packages/pi-hostname)

Hostname indicator.

```bash
pi install npm:@estebanforge/pi-hostname
```

### [pi-mixture-of-agents](packages/pi-mixture-of-agents)

Second-opinion reference models over transcripts.

```bash
pi install npm:@estebanforge/pi-mixture-of-agents
```

### [pi-show-me-the-meat](packages/pi-show-me-the-meat)

Reading-diff tool: reduces a git diff to the lines that carry the change.

```bash
pi install npm:@estebanforge/pi-show-me-the-meat
```

### [pi-slack-me](packages/pi-slack-me)

Slack read and post tools.

```bash
pi install npm:@estebanforge/pi-slack-me
```

### [pi-token-cost-ledger](packages/pi-token-cost-ledger)

Per-session token cost ledger.

```bash
pi install npm:@estebanforge/pi-token-cost-ledger
```

### [pi-zendesk-me](packages/pi-zendesk-me)

Zendesk ticket tools.

```bash
pi install npm:@estebanforge/pi-zendesk-me
```

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

npm run release:patch        # fleet stamp: check, then +1 on every package, one commit, one tag per package
npm run publish              # full check, then npm publish for every package
```

The registry holds different versions per package by design. Right after a fleet stamp every package has cleared its own registry version, so the blanket publish works; after individual releases, publish those packages individually. Existing installs keep working: package names and entrypoints are unchanged by the monorepo migration.

## License

MIT.
