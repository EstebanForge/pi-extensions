import { Type, type Static } from "typebox";
import type { ToolDefinition } from "@earendil-works/pi-coding-agent";
import { callDeepWikiTool } from "../api";
import { toToolResult, errorText } from "../result";
import {
  WIKI_STRUCTURE_TITLE,
  WIKI_STRUCTURE_DESCRIPTION,
  WIKI_STRUCTURE_REPO_DESCRIPTION,
} from "../prompts";

const Params = Type.Object({
  repoName: Type.String({ description: WIKI_STRUCTURE_REPO_DESCRIPTION }),
});

export const wikiStructureTool: ToolDefinition<typeof Params, undefined> = {
  name: "deepwiki_wiki_structure",
  label: WIKI_STRUCTURE_TITLE,
  description: WIKI_STRUCTURE_DESCRIPTION,
  parameters: Params,
  async execute(_toolCallId: string, params: Static<typeof Params>) {
    try {
      const text = await callDeepWikiTool("read_wiki_structure", {
        repoName: params.repoName,
      });
      return toToolResult(text);
    } catch (err) {
      return toToolResult(errorText(err));
    }
  },
};
