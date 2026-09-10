# @estebanforge/pi-ask-claude

A [Pi](https://github.com/earendil-works/pi-coding-agent) extension that exposes the **`AskClaude`** tool: delegate a self-contained sub-task to the [Claude Code](https://docs.claude.com/en/docs/claude-code) CLI and stream its structured progress back into the Pi session.

It is the `AskCodex` / `AskAntigravity` delegation pattern, pointed at Claude via `claude -p --output-format stream-json`. The tool answers to the names the CLI is known by — **claude** and **claude code** — surfaced in its description so the model maps "ask claude" to this single tool.

This is the **Claude-Code-specific standalone**. It is distinct from the `AskClaude` tool shipped by [`pi-claude-bridge`](https://github.com/elidickinson/pi-claude-bridge): that one shares the Pi conversation through the Agent SDK; this one runs an isolated `claude` subprocess. The two intentionally never register at the same time — see [Conflict guard](#conflict-guard-against-pi-claude-bridge).

## Install

```
pi install npm:@estebanforge/pi-ask-claude
```

Requires **Claude Code** installed and authenticated:

```bash
npm install -g @anthropic-ai/claude-code
claude /login   # or set ANTHROPIC_API_KEY
```

The extension resolves `claude` on `$PATH`, or via the `CLAUDE_BIN` environment variable if you want to point at a specific binary.

## Two modes: one-shot vs continued conversation

One tool, two ways to use it — you (or the agent) decide per call:

- **One-shot (isolated)**: omit `sessionId`. Claude starts a fresh session with no memory of prior calls. Use for independent questions.
- **Continued conversation**: pass the `sessionId` returned in a prior call's result (`details.sessionId`, also shown in the result footer). Claude resumes that session with full context intact — use for follow-ups, multi-turn refinement, or "now do X based on what you just did".

How it works under the hood: a fresh run lets claude assign a session id and captures it from the `system/init` stream event; a continued run uses `--resume <id>`. Claude holds all session state on disk; this extension is otherwise stateless.

## How it works

```
Pi (orchestrator)
  └─ AskClaude tool
       └─ spawn: claude -p --output-format stream-json --verbose [--model <m>] [--effort <e>] [--allowedTools <read-only> | --tools "" | --permission-mode bypassPermissions] [--resume <id>]
            └─ the prompt is delivered via STDIN; claude runs its OWN tool loop (Read / Grep / Edit / Bash / ...) inside <cwd>
            └─ stdout is a JSONL event stream; we parse it for status + the final agent message
       └─ returns claude's final answer text + sessionId (for follow-ups) + token usage + cost
```

No Agent SDK, no app-server daemon, no `acpx`, no third-party adapter. `claude -p --output-format stream-json` is a clean JSONL stream we parse directly. The extension is self-contained.

## Structured progress

Unlike plain stdout capture, the extension parses the JSONL event stream and renders human-readable status lines while claude runs:

- `reading: src/foo.ts` (Read)
- `searching: config` (Grep / Glob / LS)
- `editing: src/bar.ts` (Edit / Write)
- `running: npm test` (Bash)
- `web search: <query>` / `web fetch: <url>`
- `tool error` (a tool returned an error)

Session-start hook events and other lifecycle noise are filtered out. The final answer comes from the `result` event.

## Permission modes

The `mode` parameter controls what Claude is allowed to do:

| Mode | Maps to | Behavior |
| --- | --- | --- |
| `full` (default) | `--permission-mode bypassPermissions` | Full tool access: file edits + bash execution, no permission prompts (pi philosophy: pi has none either). Gated by `allowFullMode`. |
| `read` | `--allowedTools Read,Grep,Glob,LS,WebSearch,WebFetch,TodoWrite` | Research / analysis / review with file access, no mutations. Read-only tools never prompt, so the run stays non-interactive. Disable-acting option. |
| `none` | `--tools ""` | General knowledge only — no file or tool access at all. Disable-tools option. |

> `plan` mode is intentionally avoided: it requires interactive plan approval and errors out under `--print` (`error_during_execution`). The prompt is sent via stdin because `--allowedTools` / `--tools` are variadic flags that would otherwise swallow a positional prompt.

## Model aliases

| You pass | Sent to claude |
| --- | --- |
| `sonnet` | `--model sonnet` |
| `opus` | `--model opus` |
| `haiku` | `--model haiku` |
| `fable` | `--model fable` |
| `claude-sonnet-5` | exact passthrough |

Omit `model` to use the configured default.

## Configuration

`~/.pi/agent/ask-claude.json` (global) merged over `.pi/ask-claude.json` (project):

```json
{
  "defaultModel": "sonnet",
  "defaultMode": "full",
  "defaultEffort": "default",
  "allowFullMode": true
}
```

| Key | Default | Description |
| --- | --- | --- |
| `defaultModel` | `sonnet` | Alias or full id used when the tool call omits `model`. |
| `defaultMode` | `full` | `full` (default), `read`, or `none`. |
| `defaultEffort` | `default` | Mapped to `claude --effort`: `default` (omit the flag), `low`, `medium`, `high`, `xhigh`. |
| `allowFullMode` | `true` | When `false`, `mode: "full"` is refused. |

### `/claude` command

Interactive picker for the default model, permission mode, effort, and the full-mode toggle. If the project config (`.pi/ask-claude.json`) already defines a key, the change is written there so it actually takes effect; otherwise it writes to the global config. Outside TUI (RPC/headless), prints a read-only status snapshot.

## Tool parameters

| Param | Required | Description |
| --- | --- | --- |
| `prompt` | yes | Self-contained task. Claude cannot see this conversation (unless you resume). |
| `model` | no | Alias or full id (see table above). Omit for the configured default. |
| `mode` | no | `read` / `none` / `full`. Overrides the configured default. |
| `thinking` | no | `default` / `low` / `medium` / `high` / `xhigh` (maps to `--effort`). |
| `sessionId` | no | Omit for one-shot. Pass a prior call's `details.sessionId` to continue. |
| `cwd` | no | Workspace path. Defaults to the current project root. |
| `systemPrompt` | no | Replace Claude's default system prompt (`--system-prompt`). |
| `appendSystemPrompt` | no | Append to Claude's default system prompt (`--append-system-prompt`). |
| `timeoutMinutes` | no | Hard cap in minutes. Default `10`. |

## Conflict guard against pi-claude-bridge

[`pi-claude-bridge`](https://github.com/elidickinson/pi-claude-bridge) is the more popular path to Claude in Pi: it provides a model provider **and** its own `AskClaude` tool (SDK-backed, shares the Pi conversation). To avoid a duplicate `AskClaude` tool, this standalone **self-disables at load time** when the bridge is installed, enabled, **and** has its `AskClaude` enabled.

The check reads the same inputs Pi and the bridge read, so the decision matches what the bridge itself will register:

1. **Bridge installed + enabled in this Pi instance** — `packages` in `~/.pi/agent/settings.json` contains `npm:pi-claude-bridge` (plain string = enabled; `{ source, extensions: [] }` = installed but disabled).
2. **Bridge's AskClaude enabled** — `askClaude.enabled === true` in `~/.pi/agent/claude-bridge.json` (global, merged over `<project>/.pi/claude-bridge.json`). Note: the bridge's `AskClaude` is **opt-in** — it registers only when `enabled` is explicitly `true` (despite the bridge README claiming `true` is the default; verified against `src/index.ts`).

When both hold, this extension registers **no tool** (only a `/claude` command that explains why it stood down) and logs the reason. Detection is fail-open: a broken or unreadable `settings.json` resolves to "no conflict", so the standalone is never silently disabled by a config error.

To use **this** standalone instead of the bridge's AskClaude, either:

```jsonc
// ~/.pi/agent/claude-bridge.json — turn the bridge's AskClaude off
{ "askClaude": { "enabled": false } }
```

…or uninstall the bridge, then restart Pi.

## Environment variables

| Var | Default | Description |
| --- | --- | --- |
| `CLAUDE_BIN` | `claude` | Path to the claude binary. |
| `CLAUDE_EXTRA_ARGS` | _(empty)_ | Extra args appended to every `claude` invocation. Parsed with a shell-like splitter, so quoted values with spaces are preserved. |

## License

MIT
