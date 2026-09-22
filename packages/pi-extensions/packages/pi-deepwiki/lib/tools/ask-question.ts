import { Type, type Static } from "typebox";
import type { ToolDefinition } from "@earendil-works/pi-coding-agent";
import { callDeepWikiTool } from "../api";
import { toToolResult, errorText } from "../result";
import {
  ASK_QUESTION_TITLE,
  ASK_QUESTION_DESCRIPTION,
  ASK_QUESTION_REPO_DESCRIPTION,
  ASK_QUESTION_QUESTION_DESCRIPTION,
} from "../prompts";

// DeepWiki's ask_question accepts repoName as a single string OR an array of
// up to 10. We model the union so the agent can cross-reference repos.
const RepoName = Type.Union(
  [Type.String(), Type.Array(Type.String(), { minItems: 1, maxItems: 10 })],
  { description: ASK_QUESTION_REPO_DESCRIPTION },
);

const Params = Type.Object({
  repoName: RepoName,
  question: Type.String({ description: ASK_QUESTION_QUESTION_DESCRIPTION }),
});

export const askQuestionTool: ToolDefinition<typeof Params, undefined> = {
  name: "deepwiki_ask_question",
  label: ASK_QUESTION_TITLE,
  description: ASK_QUESTION_DESCRIPTION,
  parameters: Params,
  async execute(_toolCallId: string, params: Static<typeof Params>) {
    try {
      const text = await callDeepWikiTool("ask_question", {
        repoName: params.repoName,
        question: params.question,
      });
      return toToolResult(text);
    } catch (err) {
      return toToolResult(errorText(err));
    }
  },
};
