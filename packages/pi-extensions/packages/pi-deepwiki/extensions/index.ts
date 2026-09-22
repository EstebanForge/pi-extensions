/**
 * pi-deepwiki — DeepWiki documentation tools for pi.
 *
 * Adds two LLM-callable tools that query the hosted DeepWiki MCP service
 * (https://mcp.deepwiki.com) over plain HTTP+JSON-RPC. No MCP adapter install
 * is required: this extension speaks the Streamable-HTTP transport inline.
 *
 *   - deepwiki_wiki_structure: list a repo's wiki table of contents
 *   - deepwiki_ask_question:   ask a codebase-grounded question about a repo
 *
 * Tool awareness is injected as a compact system-prompt appendix via
 * before_agent_start (no skill file, to keep token cost minimal).
 *
 * Based on: DeepWiki by Cognition — https://deepwiki.com
 */
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { wikiStructureTool } from "../lib/tools/wiki-structure";
import { askQuestionTool } from "../lib/tools/ask-question";

// Compact tool guidance appended to the system prompt. Intentionally tiny:
// the tool descriptions themselves carry the detail; this just tells the agent
// when to reach for them. Mirrors the agentmemory TOOL_GUIDANCE pattern.
const TOOL_GUIDANCE = [
  "DeepWiki tools are available for any public GitHub repository.",
  "Use deepwiki_wiki_structure to list a repo's documentation outline (owner/repo).",
  "Use deepwiki_ask_question to ask a codebase-grounded question about one repo (or up to 10).",
  "Reach for them when asked how a specific repo works internally or where logic lives.",
].join(" ");

function deepwiki(pi: ExtensionAPI): void {
  pi.registerTool(wikiStructureTool);
  pi.registerTool(askQuestionTool);

  pi.on("before_agent_start", async (event) => {
    return {
      systemPrompt: [event.systemPrompt, TOOL_GUIDANCE]
        .filter(Boolean)
        .join("\n\n"),
    };
  });

  // /deepwiki <owner/repo> [question] — pins intent by prefilled input so the
  // agent reaches for the deepwiki tools deterministically. Command handlers
  // cannot directly send a turn (sendUserMessage is session-scoped), so we
  // prefill the editor; the user hits Enter to run.
  //   With a question: ask the repo. Without: list the wiki outline.
  pi.registerCommand("deepwiki", {
    description:
      "DeepWiki: ask about a GitHub repo. Usage: /deepwiki <owner/repo> [question]. With a question, calls deepwiki_ask_question; without, lists the repo's wiki outline via deepwiki_wiki_structure.",
    handler: async (args, ctx) => {
      const trimmed = args.trim();
      if (!trimmed) {
        ctx.ui.notify(
          "Usage: /deepwiki <owner/repo> [question]",
          "warning",
        );
        return;
      }
      // Split repo from the rest on the first space. repoName is owner/repo
      // (no spaces), so the first token is always the repo.
      const spaceIdx = trimmed.indexOf(" ");
      const repo =
        spaceIdx === -1 ? trimmed : trimmed.slice(0, spaceIdx);
      const question =
        spaceIdx === -1 ? "" : trimmed.slice(spaceIdx + 1).trim();

      const prompt = question
        ? `Answer this question about the GitHub repository ${repo} using the deepwiki_ask_question tool: ${question}`
        : `List the documentation outline for the GitHub repository ${repo} using the deepwiki_wiki_structure tool.`;
      ctx.ui.setEditorText(prompt);
    },
  });
}

export default deepwiki;
