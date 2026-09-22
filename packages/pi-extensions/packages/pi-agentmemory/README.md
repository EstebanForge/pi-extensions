# @estebanforge/pi-agentmemory

Pi-native **cross-session memory** for Pi, backed by [agent-memory.dev](https://www.agent-memory.dev). The agent recalls past decisions, bugs, and preferences across sessions automatically, with no MCP server in the loop. This package is the client; it talks directly to the agentmemory REST API.

> **Requires the agentmemory server.** This extension does not bundle the server. Install [agent-memory.dev](https://www.agent-memory.dev) once (see [Prerequisites](#prerequisites)); thereafter the extension starts it automatically when needed and reuses an already-running one. See [Auto-start](#auto-start).

## Prerequisites

Install and start the agentmemory server on your machine:

```bash
npm install -g @agentmemory/agentmemory
agentmemory
```

Or run it without installing: `npx -y @agentmemory/agentmemory@latest`.

By default the REST API listens on `http://localhost:3111` (the web viewer is on `http://localhost:3113`). See the [agent-memory.dev docs](https://www.agent-memory.dev/docs) and the [source on GitHub](https://github.com/rohitg00/agentmemory) for auth, Docker, and configuration.

## Install

```
pi install npm:@estebanforge/pi-agentmemory
```

Start (or restart) Pi in a project. On session start the extension health-checks the server and lights up the footer status.

## What it does

Three tools, one command, and a recall/observe lifecycle wired into Pi hooks.

### Tools

| Tool | Description |
| --- | --- |
| `memory_health` | Check whether the agentmemory server is reachable and healthy |
| `memory_search` | Search memory for prior decisions, preferences, bugs, and workflows |
| `memory_save` | Save a durable fact, convention, or bug fix into memory |

### Command

| Command | Description |
| --- | --- |
| `/agentmemory` | Show server health + flags, or toggle a flag (`/agentmemory [toggle <flag>]`) |

### Hooks

| Hook | What it does |
| --- | --- |
| `session_start` | Derives the session ID, health-checks the server, sets the footer status |
| `before_agent_start` | Fires a background smart-search for the prompt and appends tool guidance to the system prompt |
| `context` | Awaits the search results and injects them as a user message before the LLM call |
| `agent_end` | Observes the conversation turn back into agentmemory for future recall |

## How it works

The recall path is deferred to keep prompt latency low. On `before_agent_start` the extension kicks off a smart-search against agentmemory and returns immediately; the `context` hook then awaits the result and prepends it as a user message just before the LLM is called. After the turn, `agent_end` writes the exchange back to agentmemory as an observation, so later sessions can recall it.

No MCP server required. The extension talks directly to the agentmemory REST API (`health`, `smart-search`, `remember`, `observe`).

## Auto-start

The extension brings the server up on demand so you rarely start it by hand. On session start, and whenever `memory_search` / `memory_save` run, it:

1. Health-checks `GET /agentmemory/health`. If healthy, do nothing.
2. If down, checks whether `agentmemory` is installed. If so, starts it (detached, so it outlives Pi). If not, falls back to `npx -y @agentmemory/agentmemory@latest`.
3. Polls health for up to ~20s (first run downloads its engine), then proceeds or reports a clear error.

Closing Pi leaves the server running; reopening Pi, or opening a second Pi at the same time, detects it via the health check and does not start it again. A single Pi process also starts it only once per outage, even if several memory tools fire while it is down.

Two flags control this (edit in `pi config`):

| Flag | Default | Effect |
| --- | --- | --- |
| `agentmemory-autostart` | `true` | Master switch. `false` disables auto-start entirely; the extension then only health-checks and reports if the server is down. |
| `agentmemory-npx-fallback` | `true` | If `agentmemory` is not on PATH, start it via `npx`. `false` starts only a globally-installed server and otherwise reports that it is not installed. Use this if `npx` is too slow for you. |

**Security note:** `npx -y @agentmemory/agentmemory@latest` downloads and runs the latest published package (unpinned) on first use. This is the official no-install path, but it is remote code execution. Install the CLI globally or set `agentmemory-npx-fallback=false` if that is not acceptable in your environment.

## Configuration

Set via environment variables:

| Variable | Default | Purpose |
| --- | --- | --- |
| `AGENTMEMORY_URL` | `http://localhost:3111` | agentmemory server base URL |
| `AGENTMEMORY_SECRET` | (none) | Bearer token for auth |
| `AGENTMEMORY_REQUIRE_HTTPS` | (none) | Set `1` to reject plaintext HTTP + secret on non-loopback hosts |

## Security

A plaintext bearer-auth guard (`security.ts`) watches for a secret sent over plain HTTP to a non-loopback host. It warns once by default, and throws if `AGENTMEMORY_REQUIRE_HTTPS=1`. Use HTTPS or an SSH tunnel when carrying a bearer token over the network.

## Compatibility

- Pi (`@earendil-works/pi-coding-agent`), `pi-tui`, and `typebox`, as optional peer dependencies resolved by the Pi runtime.
- The agentmemory server ([agent-memory.dev](https://www.agent-memory.dev)), default `http://localhost:3111`.

## License

MIT
