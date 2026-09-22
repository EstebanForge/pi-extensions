// Tool titles, descriptions, and parameter descriptions adapted from the
// DeepWiki MCP server's own tools/list output (serverInfo DeepWiki 2.14.3),
// rewritten to instruct the pi agent. The hosted service exposes three public
// tools; we surface the two that are safe for an agent context:
//   - read_wiki_structure -> wiki_structure
//   - ask_question        -> ask_question
// read_wiki_contents is intentionally omitted: it dumps the ENTIRE wiki as a
// single blob (1MB+ for large repos) with no page filter, which is unusable as
// an LLM tool call. ask_question gives the same knowledge at grounded sizes.

export const WIKI_STRUCTURE_TITLE = "DeepWiki: List Wiki Topics";

export const WIKI_STRUCTURE_DESCRIPTION = `Lists the documentation table of contents for a public GitHub repository via DeepWiki.

Use FIRST when you need to explore an unfamiliar repo's architecture: it returns the wiki's section/subsection outline (e.g. "2 Core Runtime", "2.1 Signal Pipeline"). Cheap and small; call it to discover what to ask about.

Pass repoName in owner/repo form (e.g. "solidjs/solid", "sveltejs/svelte"). The repo must be indexed on deepwiki.com; most public repos are. Do not call more than 3 times per question.`;

export const WIKI_STRUCTURE_REPO_DESCRIPTION =
  'GitHub repository in owner/repo format (e.g. "solidjs/solid").';

export const ASK_QUESTION_TITLE = "DeepWiki: Ask Repo Question";

export const ASK_QUESTION_DESCRIPTION = `Asks a question about a public GitHub repository and gets an AI-powered, codebase-grounded answer via DeepWiki.

Use AFTER (or instead of) listing topics when you need a concrete explanation grounded in the repo's actual source: how a subsystem works, where logic lives, how pieces fit together. Returns focused prose (not the whole wiki) with inline citations and a deepwiki.com search link.

Pass repoName in owner/repo form, or an array of up to 10 repos to cross-reference. Be specific in the question: good = "How does fine-grained reactivity work in solidjs/solid?"; bad = "explain solid". Do not call more than 3 times per question.`;

export const ASK_QUESTION_REPO_DESCRIPTION =
  'GitHub repository in owner/repo format (e.g. "solidjs/solid"), or an array of up to 10 owner/repo strings to cross-reference.';

export const ASK_QUESTION_QUESTION_DESCRIPTION =
  "The question to ask about the repository. Be specific and include relevant detail. Do not include sensitive or confidential information.";
