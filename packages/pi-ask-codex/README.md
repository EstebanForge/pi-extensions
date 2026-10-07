# @estebanforge/pi-ask-codex

A [Pi](https://github.com/earendil-works/pi) extension that exposes the **`AskCodex`** tool: delegate a self-contained sub-task to OpenAI's [Codex CLI](https://github.com/openai/codex) and stream its structured progress back into the Pi session.

It is the `AskClaude`-style delegation pattern (from pi-claude-bridge), pointed at GPT via `codex exec`. The tool answers to three names the CLI is known by — **codex**, **openai**, and **gpt** — surfaced in its description so the model maps any of them to this single tool.

## Install

```
pi install npm:@estebanforge/pi-ask-codex
```

Requires the **Codex CLI** installed and authenticated:

```bash
npm install -g @openai/codex
codex login
```

The extension resolves `codex` on `$PATH`, or via the `CODEX_BIN` environment variable if you want to point at a specific binary.

## Two modes: one-shot vs continued conversation

One tool, two ways to use it — you (or the agent) decide per call:

- **One-shot (isolated)**: omit `sessionId`. Codex starts fresh with no memory of prior calls. Use for independent questions.
- **Continued conversation**: pass the `sessionId` returned in a prior call's result (`details.sessionId`, also shown in the result footer). Codex resumes that session with full context intact — use for follow-ups, multi-turn refinement, or "now do X based on what you just did".

How it works under the hood: `codex exec --json` prints a `thread.started` event carrying the session id directly (no snapshot/diff hack — cleaner than the agy route). On a continued call, `codex exec resume <id>` reuses it natively. Codex holds all session state on disk; this extension is otherwise stateless.

## How it works

```
Pi (orchestrator)
  └─ AskCodex tool
       └─ spawn: codex exec --json [--model <m>] [-c model_reasoning_effort=...] [-C <cwd>] [-s <sandbox>] "<prompt>"
            └─ codex runs its OWN tool loop (read / write / edit / exec) inside <cwd>
            └─ stdout is a JSONL event stream; we parse it for status + the final agent message
       └─ returns codex's final answer text + sessionId (for follow-ups) + token usage
```

No ACP adapter, no app-server daemon, no `acpx`, no third-party binary. `codex exec --json` is a clean JSONL stream we parse directly. The extension is self-contained.

## Structured progress

Unlike plain stdout capture, the extension parses the JSONL event stream and renders human-readable status lines while codex runs:

- `running: npm test` / `verifying: pytest` (verification commands labeled distinctly)
- `editing: src/foo.ts, src/bar.ts` (file changes, as they happen)
- `searched: <query>` (web searches)
- `thinking: <reasoning summary>` (when reasoning summaries are emitted)
- `command completed: ... (exit 0)` (per-tool results)

Transient `error` events (e.g. `"Reconnecting... 1/5"` during a dropped stream) are treated as non-fatal progress, not failure. Only `turn.failed` or a non-zero process exit surfaces as an error.

## Model aliases

Aliases resolve at load time against the live catalog from `codex debug models --bundled` — no version strings are hardcoded, so they track whatever Codex currently ships (GPT-6 era: `gpt-6.1-sol` workhorse, `gpt-6-astra` frontier, `gpt-6-luna` fast).

| User says | Resolves to (GPT-6 era catalog) |
| --- | --- |
| `default` | omit `--model` (Codex's own default, currently gpt-6.1-sol) |
| `mini` / `nano` | gpt-6-luna (fast, affordable tier) |
| `astra` | gpt-6-astra (frontier tier) |
| `full` / `gpt` | gpt-6.1-sol (workhorse, highest version) |
| `6 mini`, `6.1 full`, `6 astra` | pinned version + tier |
| `gpt-6.1-sol` / `gpt-6-astra` | exact passthrough |

Deprecated models stay listed in the catalog but fail server-side. The catalog carries each one's official `upgrade` pointer (`gpt-5.5` → `gpt-6-sol`, `gpt-5.6-luna` → `gpt-6-luna`, ...), and resolution follows it, so a stale pinned id like `5.6 mini` lands on its successor instead of a 400. Hidden catalog entries (experiments, internal reviewers) never win alias resolution but stay reachable as exact ids. The bare `default` alias omits the flag entirely and lets the CLI pick its own model at run time, so no effort validation is possible on that path — an unsupported configured effort surfaces as a codex error mid-run.

Note: when authenticated with a ChatGPT account (the common case, including the free tier), only some models are available — others return `400: model is not supported when using Codex with a ChatGPT account`. The alias set is intentionally small and points only at known-good names for that auth path. Use API-key auth (`CODEX_API_KEY`) to target other models, and pass the exact id.

## Configuration

`~/.pi/agent/ask-codex.json` (global) merged over `.pi/ask-codex.json` (project):

```json
{
  "defaultModel": "default",
  "defaultReasoning": "medium",
  "defaultSandbox": "danger-full-access"
}
```

| Key | Default | Description |
| --- | --- | --- |
| `defaultModel` | `default` | Alias or exact id used when the tool call omits `model`. |
| `defaultReasoning` | `medium` | Reasoning effort (`low` / `medium` / `high` / `xhigh` / `max` / `ultra`) passed via `-c model_reasoning_effort`. Lower = faster and cheaper. |
| `defaultSandbox` | `danger-full-access` | Sandbox policy: `danger-full-access` (default, full tool access without prompts), `workspace-write` (edit files in cwd only), or `read-only` (inspect without acting; disable-acting option). |

### `/codex` command

Interactive picker for the default model, reasoning effort, and sandbox. If the project config (`.pi/ask-codex.json`) already defines a key, the change is written there so it actually takes effect; otherwise it writes to the global config. Outside TUI (RPC/headless), prints a read-only status snapshot.

## Tool parameters

| Param | Required | Description |
| --- | --- | --- |
| `prompt` | yes | Self-contained task. Codex cannot see this conversation. |
| `model` | no | Alias or exact id (see table above). Omit for the configured default. |
| `reasoningEffort` | no | `low` / `medium` / `high` / `xhigh` / `max` / `ultra`. Overrides the configured default. Validated against the resolved model's supported ladder (e.g. `ultra` is rejected on gpt-6-luna) before the run starts. |
| `sandbox` | no | `danger-full-access` (default) / `workspace-write` / `read-only`. Overrides the configured default. |
| `sessionId` | no | Omit for one-shot. Pass a prior call's `details.sessionId` to continue that conversation. |
| `cwd` | no | Workspace path. Defaults to the current project root. |
| `timeoutMinutes` | no | Hard cap in minutes. Default `10`. |

## Sandbox note (containers / restricted kernels)

Codex's default sandbox uses [bubblewrap](https://github.com/containers/bubblewrap), which needs permission to create user namespaces. In some containers and hardened kernels you'll see:

```
bwrap: No permissions to create new namespace, likely because the kernel does not allow non-privileged user namespaces.
```

When that happens, Codex's own tool calls (file reads/writes, command execution) are blocked even though the run itself succeeds. Fixes:

- Run Pi in an environment that allows user namespaces, **or**
- Pass `sandbox: "danger-full-access"` per call (or set `defaultSandbox` to it) — appropriate when the outer environment is *already* sandboxed (a container, CI runner).

The extension's own process management (spawn, timeout, abort, JSONL parsing) is unaffected.

## Environment variables

| Var | Default | Description |
| --- | --- | --- |
| `CODEX_BIN` | `codex` | Path to the codex binary. |
| `CODEX_EXTRA_ARGS` | _(empty)_ | Extra args appended to every `codex exec` invocation. Parsed with a shell-like splitter, so quoted values with spaces are preserved. |

## Background runs

Set `background: true` on a call to run detached: the tool returns a `runId` at once, the calling agent keeps working, and the full answer arrives later as a message in the conversation (wrapped in an UNTRUSTED banner: it is tool output, never a user instruction). The message carries the resume handle (`sessionId`) so the run can be threaded like any blocking call. Stop a run with `/codex-stop [runId]` (unique id prefix; no arg stops the only running run). Constraints: refused in print/json mode (the process exits before the message could arrive); a `/new`, `/resume`, `/fork`, or `/reload` kills in-flight runs and their results are lost; at most 4 runs at once; failure wakes (timeout, crash) carry up to 400 chars of peer output as the reason, also banner-marked.

## License

MIT
