# Changelog

## 1.0.1 — 2026-08-06

### Changed
- **Dependencies updated.** Raised the `pi-coding-agent` dev pin to `^0.84.0`. Audited against the pi v0.84.0 breaking changes (renamed `ModelsRequestTransforms`, null-tolerant `getApiKeyAndHeaders` headers, dropped `message_update` partial fields, v4 session APIs); no code changes were needed and `tsc`/`typecheck` passes against 0.84.0.

## 1.0.0 (2026-06-26)

Initial release.

Pi-native DeepWiki documentation tool. Registers two LLM-callable tools that
query the hosted DeepWiki MCP service (`https://mcp.deepwiki.com`) over plain
HTTP, with no MCP adapter install required — the extension speaks the MCP
Streamable HTTP transport (JSON-RPC 2.0 over Server-Sent Events) inline.

### Added
- `deepwiki_wiki_structure` tool — given a repo in `owner/repo` form, returns
  the wiki's section/subsection outline. Cheap discovery for an unfamiliar
  codebase.
- `deepwiki_ask_question` tool — given a repo (or an array of up to 10) and a
  question, returns a focused, codebase-grounded answer with inline
  citations. Replaces dumping the full wiki.
- Compact tool guidance injected via the `before_agent_start` hook
  (~50 tokens, no skill file).
- `/deepwiki <owner/repo> [question]` slash command. With a question it
  prefills the input editor with an explicit ask that triggers
  `deepwiki_ask_question`; without, it triggers `deepwiki_wiki_structure`.
  Registered programmatically via `registerCommand` (no prompt file).
- Inline MCP client (`lib/api.ts`) handling JSON-RPC, SSE frame parsing,
  timeouts, and friendly status errors. Supports `DEEPWIKI_MCP_URL` override.

Based on [DeepWiki](https://deepwiki.com) by Cognition.
