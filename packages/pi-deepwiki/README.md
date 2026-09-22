# @estebanforge/pi-deepwiki

[DeepWiki](https://deepwiki.com) documentation tools for the [pi coding agent](https://pi.dev).

Adds AI-powered, codebase-grounded documentation for any public GitHub repository via two LLM-callable tools:

- **`deepwiki_wiki_structure`** — lists a repo's wiki table of contents.
- **`deepwiki_ask_question`** — asks a question and gets a grounded answer with inline citations.

Tool awareness is injected as a compact system-prompt appendix (no skill file, to keep token cost minimal). A `/deepwiki <owner/repo> [question]` slash command pins intent for direct invocation.

## How it works

`deepwiki.com` has no public REST API. Its hosted service exposes an MCP server at `https://mcp.deepwiki.com/mcp`. This extension speaks that MCP **Streamable HTTP** transport inline (JSON-RPC 2.0 over Server-Sent Events), so **no MCP adapter install** is required. The two public tools (`read_wiki_structure`, `ask_question`) are mapped 1:1 to the pi tools above. Auth-free for public repos.

## Install

```bash
pi install npm:@estebanforge/pi-deepwiki
```

## What it adds

- **`deepwiki_wiki_structure`** — given `owner/repo`, returns the wiki's section/subsection outline. Cheap discovery.
- **`deepwiki_ask_question`** — given `owner/repo` (or an array of up to 10) and a `question`, returns a focused, codebase-grounded answer.
- A compact system-prompt note telling the agent when to reach for these tools (no skill file, no prompt file).
- **`/deepwiki <owner/repo> [question]`** — direct invocation. With a question it triggers `deepwiki_ask_question`; without it lists the wiki outline. Prefills the input editor (the agent runs on Enter).

## Usage

You don't need to mention DeepWiki. The agent reaches for these tools whenever a question is about how a specific public GitHub repo works internally. The slash command is there when you want to pin the intent explicitly.

### Regular chat (auto-invoked)

Just ask a question that names a repo in `owner/repo` form. The agent picks the right tool:

```
How does fine-grained reactivity work in solidjs/solid?
```

```
Where is the signal pipeline defined in starfederation/datastar?
```

```
What's the structure of EstebanForge/construct-cli?
```

Cross-reference up to 10 repos in one question:

```
How do solidjs/solid, sveltejs/svelte, and tailwindlabs/tailwindcss each approach reactivity and styling?
```

If you only name a repo with no question, the agent lists its wiki outline first (cheap discovery) before deciding what to ask.

### Slash command (pinned intent)

`/deepwiki <owner/repo> [question]` prefills the input editor with an explicit instruction. Hit Enter to run.

Ask a question about a repo:

```
/deepwiki starfederation/datastar How are SSE patch events merged into signals?
```

List a repo's wiki outline (no question):

```
/deepwiki EstebanForge/construct-cli
```

Bare `/deepwiki` with no args prints a usage reminder.

## Configuration

None required for public repos. Optional environment variable:

- `DEEPWIKI_MCP_URL` — override the MCP endpoint (defaults to `https://mcp.deepwiki.com/mcp`).

## Notes

- The hosted MCP `read_wiki_contents` tool is intentionally **not** exposed: it returns the entire wiki as a multi-megabyte blob with no page filter, which is unusable as an LLM tool call. Use `ask_question` for the same knowledge at grounded sizes.
- These tools are network calls to a third-party service. Do not pass secrets or proprietary code in the `question`.

## License

MIT
