# @estebanforge/pi-ask-antigravity

A [Pi](https://github.com/earendil-works/pi-coding-agent) extension that exposes the **`AskAntigravity`** tool: delegate a self-contained sub-task to Google Antigravity's `agy` CLI and stream its response back into the Pi session.

It is the `AskClaude`-style delegation pattern (from pi-claude-bride extension), pointed at Gemini via `agy`. The tool answers to three names the CLI is known by — **gemini**, **antigravity**, and **agy** — surfaced in its description so the model maps any of them to this single tool.

<img width="1512" height="845" alt="image" src="https://github.com/user-attachments/assets/3e1a8f19-64d2-43ab-a30f-47f39daa151d" />

## Install

```
pi install npm:@estebanforge/pi-ask-antigravity
```

Requires the **`agy` CLI** installed and authenticated. If you don't have it, follow Google's [official install guide](https://antigravity.google/docs/cli/install) for your platform. Then run `agy` once to complete Google OAuth.

The extension resolves `agy` on `$PATH`, or via the `AGY_BIN` environment variable if you want to point at a specific binary.

## Two modes: one-shot vs continued conversation

One tool, two ways to use it — you (or the agent) decide per call:

- **One-shot (isolated)**: omit `conversationId`. agy starts fresh with no memory of prior calls. Use for independent questions.
- **Continued conversation**: pass the `conversationId` returned in a prior call's result (`details.conversationId`, also shown in the result footer). agy resumes that conversation with full context intact — use for follow-ups, multi-turn refinement, or "now do X based on what you just did".

How it works under the hood: `agy -p` does not print the conversation id, so on a fresh run the extension snapshots agy's conversations directory before spawn and discovers the single new `.db` file agy created (the one technique borrowed from [`antigravity-acp`](https://github.com/shubzkothekar/antigravity-acp)'s `scan.ts`). On a continued call it passes `--conversation <id>` and agy reuses it natively. agy holds all conversation state in its own SQLite DB; this extension is otherwise stateless.

## How it works

```
Pi (orchestrator)
  └─ AskAntigravity tool
       └─ spawn: agy --add-dir <cwd> --model <resolved> [--conversation <id>] -p <prompt>
            └─ agy runs its OWN tool loop (read / write / edit / exec) inside <cwd>
            └─ stdout streamed as partial tool output
       └─ returns agy's final answer text + conversationId (for follow-ups)
```

No ACP server, no SQLite reverse-engineering, no `acpx`, no third-party binary. `agy -p` (print mode) prints its response to stdout, so we capture it directly.

## Model aliases

Verbose `agy models` strings (`Gemini 3.5 Flash (Medium)`) are hostile to natural requests. This extension resolves friendly aliases to the exact string:

| User says | Resolves to |
| --- | --- |
| `flash` | latest Flash, default tier (Medium) |
| `pro` | latest Pro (Pro has no Medium → **High**) |
| `gemini` | alias for `flash` |
| `flash high` | latest Flash, High |
| `pro low` | latest Pro, Low |
| `3.5 flash` | pinned version, default tier |
| `3.1 pro` | pinned Pro version (→ High) |
| `sonnet` | Claude Sonnet 4.6 (Thinking) |
| `opus` | Claude Opus 4.6 (Thinking) |
| `gpt-oss` | GPT-OSS 120B (Medium) |
| `Gemini 3.5 Flash (Medium)` | exact passthrough |

- **Latest** = highest version number available for the family.
- **Default tier**: Flash → Medium, Pro → High. Overridable per-config (below).
- When a tier is unavailable for a family, the nearest is chosen with ties broken toward the higher tier (so "latest and greatest" wins).
- The non-Gemini aliases (`sonnet`, `opus`, `gpt-oss`) are a static overlay merged with the live `agy models` catalog. Live entries always win on case-insensitive full-string equality, so an updated `agy` listing takes precedence over the hardcoded fallback.

## Execution modes (`mode`)

| Mode | Flag | Use when |
| --- | --- | --- |
| `plan` | `--mode plan` | agy reviews and plans without writing. Use for cross-review and read-only tasks. |
| `accept-edits` (default) | `--mode accept-edits` | agy applies edits directly inside the workspace. |

For agy's orthogonal `--sandbox` shell-containment flag, set `AGY_EXTRA_ARGS=--sandbox` in your environment. The extension does not expose it as a `mode` value because `--sandbox` controls command containment, not edit persistence.

Recommended pairings:

```text
# Gemini produces, Claude reviews
AskAntigravity prompt="Implement the approved refactor" mode=accept-edits
AskAntigravity prompt="Review the resulting diff" model=opus mode=plan digest=true

# Claude produces, Gemini reviews
AskAntigravity prompt="Fix the parser root cause" model=opus mode=accept-edits
AskAntigravity prompt="Review the resulting diff" model=pro mode=plan digest=true
```

## Compact output (`digest`)

Set `digest: true` to prefix the prompt with `(Use compact digests, not full file contents.)` so `agy` returns summaries instead of full file payloads. Defaults on for `plan`, off for `accept-edits`. Use `true` for any read-only call (review, exploration, planning) where full file contents are noise.

## Configuration

`~/.pi/agent/ask-antigravity.json` (global) merged over `.pi/ask-antigravity.json` (project):

```json
{
  "defaultModel": "flash",
  "defaultThinking": "medium"
}
```

| Key | Default | Description |
| --- | --- | --- |
| `defaultModel` | `flash` | Alias or exact id used when the tool call omits `model`. |
| `defaultThinking` | `medium` | Tier used when an alias doesn't name one. Applies only if the family offers it; otherwise the family default (Pro → High). |

### `/agy` command

Interactive picker for the default model and default thinking. If the project config (`.pi/ask-antigravity.json`) already defines a key, the change is written there so it actually takes effect; otherwise it writes to the global config. Outside TUI (RPC/headless), prints a read-only status snapshot.

## Tool parameters

| Param | Required | Description |
| --- | --- | --- |
| `prompt` | yes | Self-contained task. agy cannot see the Pi conversation. |
| `cwd` | no | Workspace agy runs in. Defaults to the project root. |
| `model` | no | Alias or exact id. Omit for the configured default. |
| `mode` | no | `plan` (review-only) or `accept-edits` (agy applies edits, default). |
| `digest` | no | Prefix the prompt with `(Use compact digests, not full file contents.)`. Defaults on for `plan`, off for `accept-edits`. |
| `conversationId` | no | Omit for a one-shot (agy starts fresh). Pass the id from a prior call's result (`details.conversationId`) to resume that agy conversation with full context. See [Two modes](#two-modes-one-shot-vs-continued-conversation). |
| `timeoutMinutes` | no | Hard cap on the run. Default 10. |

## Environment

| Env var | Purpose |
| --- | --- |
| `AGY_BIN` | Path to an `agy` binary; skips `$PATH` lookup |
| `AGY_EXTRA_ARGS` | Extra args appended to every `agy` invocation (raw string) |
| `AGY_CONVERSATIONS_DIR` | Directory where agy writes its conversation SQLite DBs. Defaults to `~/.gemini/antigravity-cli/conversations`. Override only if agy uses a different path on your OS. |

## When to use it

- A second opinion from a different model family on the same problem.
- Gemini-specific reasoning, long-context synthesis.
- An isolated sub-task you want agy to complete end-to-end without driving each step.

agy mutates the workspace itself, so scope calls to sub-tasks where that is the desired contract, not where Pi is concurrently editing the same files.

## Terms of Service notice

Google's [Antigravity ToS](https://antigravity.google/terms) states that using third-party software to access the Service (e.g. driving `agy` from a non-Google editor) is a breach of the Agreement and may be grounds for suspension or termination of your account. `agy` handles its own Google OAuth; this extension only spawns the official binary as a subprocess — but the effect is still a non-Google editor driving the Antigravity service through a third-party tool. **By using this extension against an `agy` session logged into your personal Antigravity account, you accept that risk.**

## License

MIT
