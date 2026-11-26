# Engines

Turns run through one of two engines behind the same provider surface (`config.engine`, default `acp`). A first-run picker explains the choices, and `/agy engine` reopens it. Direct switches work too: `/agy engine acp|stream-json`. Restart applies the switch.

Both engines require the same `agy` CLI installation and use its cached Google credentials. There is no separate ACP binary or second sign-in.

## Native tools and the bridge catalog

On BOTH engines, agy's native tool calls execute agy-side: on ACP after a permission frame (provider Gate C - "the server already executed the tool; nothing parks"), on stream-json through its own loop while pi renders the steps (pi re-executes only read-only calls for card rendering; mutating ones replay through a display-only wrapper). The escalation, poll long-wait, and turn-end handoff machinery covers MCP-routed bridge calls on both engines; a silent native command outlasting the idle guard dies on both (ACP: the bridge's 5-minute stall guard, observed live 2026-11-26; stream-json: pi's idle cap, issue #21).

The bridge catalog is where the engines differ: `bridgeTools: "all"` declares pi's default builtins (read, ls, grep, find, edit, write, bash) directly on ACP - pi's tool surface is otherwise unreachable there - while stream-json keeps the builtin-free catalog it always shipped (the fallback contract). The system prompt gains an ACP note (only when bash is actually active) steering anything longer than a minute onto the bridge bash.

- **acp** (default): `agy acp`, JSON-RPC 2.0 over stdio. Verified live on agy 1.5.3 with text streaming, exact token usage, session resume, bridge tools, separate model/thinking options, and notification-based cancellation.
- **stream-json** (fallback): a persistent `agy` CLI process using the stream-json protocol. Live token usage and conversation resume via `--conversation`.

## First run and CLI setup

On a fresh install, the first interactive pi start opens the engine picker. `acp` is preselected; `esc` decides later and writes nothing.

If `agy` is missing, interactive pi asks once per process before running Google's official installer without blocking bridge startup. Linux and macOS download `https://antigravity.google/cli/install.sh` to a temp file and run it under bash, so an installer that exits early (already-installed notice) cannot surface as a download failure. Windows PowerShell runs `irm https://antigravity.google/cli/install.ps1 | iex`. Headless sessions print instructions once and never install automatically. A bad explicit `AGY_BIN` gets correction instructions instead of a useless install.

After installation, the bridge verifies that agy is available, then asks you to run `agy` in a terminal, complete Google sign-in, and restart pi. ACP requires agy 1.5.3 or newer. An older installation points at `agy update` instead of the installer, which cannot upgrade an existing install. `/agy engine acp` checks availability immediately.

Existing installs clean up the retired ACP server only under `~/.local/opt/agy-acp`. A build must contain `agy_acp_server.par` plus `zip.sha256`, the unpacked `localharness_external` directory, or a matching interrupted `.download-<build>.zip` archive. Interrupted archives and empty build directories are removed too. The managed `current` symlink is removed with those builds. Unmarked binaries, unrelated files, and custom installation paths stay untouched. The retired `acp.bin` key is removed from `<agentDir>/antigravity-bridge/config.json` automatically at startup; the rest of the file keeps its shape. A set `AGY_ACP_BIN` environment variable cannot be removed by the bridge; it is ignored and warns with removal instructions. If the config rewrite fails, the warning names the file and the manual fix. Retired `~/.gemini/antigravity-acp` credentials are not deleted automatically; `/agy doctor` identifies them for manual removal.

## Capabilities

| Capability | `stream-json` | `acp` |
| --- | --- | --- |
| Show thinking text | No (token count only) | Yes, when the server sends thought chunks |
| Token usage | Live CLI metrics | Exact server usage; client estimates remain a fallback |
| Image prompt input | Staged temp files plus bridge read tool | Native image blocks |
| Image tool results | Yes | Yes |
| Review-only provider turns | Refused; the CLI does not enforce plan read-only | Refused by the bridge |
| Dynamic model / effort switch | Recycles process on drift | Per-turn `model` and `thought_level` config options |
| Process lifecycle | Persistent `agy` process | Persistent `agy acp` process |
| Session resume | `--conversation <id>` | `session/load` and `session/new` |
| Turn cancel | Kills process group | `session/cancel` notification, with teardown fallback |
| MCP tool bridge | Isolated per-session MCP home (`--gemini_dir`); global registration is the probe-verified fallback | Direct `mcpServers` plus a sanitized private MCP home |
| Pi builtins in the bridge catalog | Not bridged (native commands run agy-side; catalog unchanged) | Declared directly under `bridgeTools: "all"` (when bash is active in pi) |
| Long silent native commands | Killed by pi's idle cap (issue #21) | Killed by the bridge's 5-minute stall guard (observed live) |
| Tool visibility | Native re-exec plus wrapper replay | Display-only native tool cards |
| Context digest | Inline prompt text | `embeddedContext` resource block |
| System prompt | Staged agy agent file | Prepended to the first prompt |
| Authentication | Shared `agy` CLI credentials | Shared `agy` CLI credentials |
| Wire protocol | CLI NDJSON stream | JSON-RPC 2.0 over stdio |

## Switching and authentication

Switch with `/agy engine acp|stream-json`, then restart pi. `/agy auth` and `/agy auth-manual` show the shared CLI authentication instructions. `/agy doctor` checks the CLI version and reports the active ACP server version without spending tokens. Sessions are engine-scoped, so switching engines never crosses conversations.
