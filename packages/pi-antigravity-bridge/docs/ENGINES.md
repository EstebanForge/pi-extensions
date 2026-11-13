# Engines

Turns run through one of two engines behind the same provider surface (`config.engine`, default `acp`). A first-run picker explains the choices, and `/agy engine` reopens it. Direct switches work too: `/agy engine acp|stream-json`. Restart applies the switch.

Both engines require the same `agy` CLI installation and use its cached Google credentials. There is no separate ACP binary or second sign-in.

- **acp** (default): `agy acp`, JSON-RPC 2.0 over stdio. Verified live on agy 1.5.3 with text streaming, exact token usage, session resume, bridge tools, separate model/thinking options, and notification-based cancellation.
- **stream-json** (fallback): a persistent `agy` CLI process using the stream-json protocol. Live token usage and conversation resume via `--conversation`.

## First run and CLI setup

On a fresh install, the first interactive pi start opens the engine picker. `acp` is preselected; `esc` decides later and writes nothing.

If `agy` is missing, interactive pi asks once per process before running Google's official installer without blocking bridge startup. Linux and macOS run `set -o pipefail; curl -fsSL https://antigravity.google/cli/install.sh | bash`. Windows PowerShell runs `irm https://antigravity.google/cli/install.ps1 | iex`. Headless sessions print instructions once and never install automatically. A bad explicit `AGY_BIN` gets correction instructions instead of a useless install.

After installation, the bridge verifies that agy is available, then asks you to run `agy` in a terminal, complete Google sign-in, and restart pi. ACP requires agy 1.5.3 or newer. An older installation triggers the same confirmed installer offer. `/agy engine acp` checks availability immediately.

Existing installs clean up the retired ACP server only under `~/.local/opt/agy-acp`. A build must contain `agy_acp_server.par` plus `zip.sha256`, the unpacked `localharness_external` directory, or a matching interrupted `.download-<build>.zip` archive. Interrupted archives and empty build directories are removed too. The managed `current` symlink is removed with those builds. Unmarked binaries, unrelated files, and custom installation paths stay untouched. The retired `acp.bin` key is removed from `~/.pi/agent/antigravity-bridge/config.json` automatically at startup; the rest of the file keeps its shape. A set `AGY_ACP_BIN` environment variable cannot be removed by the bridge; it is ignored and warns with removal instructions. If the config rewrite fails, the warning names the file and the manual fix. Retired `~/.gemini/antigravity-acp` credentials are not deleted automatically; `/agy doctor` identifies them for manual removal.

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
| Tool visibility | Native re-exec plus wrapper replay | Display-only native tool cards |
| Context digest | Inline prompt text | `embeddedContext` resource block |
| System prompt | Staged agy agent file | Prepended to the first prompt |
| Authentication | Shared `agy` CLI credentials | Shared `agy` CLI credentials |
| Wire protocol | CLI NDJSON stream | JSON-RPC 2.0 over stdio |

## Switching and authentication

Switch with `/agy engine acp|stream-json`, then restart pi. `/agy auth` and `/agy auth-manual` show the shared CLI authentication instructions. `/agy doctor` checks the CLI version and reports the active ACP server version without spending tokens. Sessions are engine-scoped, so switching engines never crosses conversations.
