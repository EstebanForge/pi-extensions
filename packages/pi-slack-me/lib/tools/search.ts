import { Type, type Static } from "typebox";
import type { AgentToolResult, ToolDefinition } from "@earendil-works/pi-coding-agent";
import { slackGet } from "../api";
import { toToolResult, errorText, type SlackDetails } from "../result";
import { formatSearchResults } from "../format";
import type { SlackSearchResult } from "../types";
import {
  SEARCH_TITLE,
  SEARCH_DESCRIPTION,
  SEARCH_QUERY_DESCRIPTION,
  SEARCH_COUNT_DESCRIPTION,
  SEARCH_SORT_DESCRIPTION,
  SEARCH_SORT_DIR_DESCRIPTION,
  SEARCH_PAGE_DESCRIPTION,
} from "../prompts";

const Params = Type.Object({
  query: Type.String({ description: SEARCH_QUERY_DESCRIPTION }),
  count: Type.Optional(Type.Number({ description: SEARCH_COUNT_DESCRIPTION, minimum: 1, maximum: 100 })),
  sort: Type.Optional(Type.String({ description: SEARCH_SORT_DESCRIPTION })),
  sort_dir: Type.Optional(Type.String({ description: SEARCH_SORT_DIR_DESCRIPTION })),
  page: Type.Optional(Type.Number({ description: SEARCH_PAGE_DESCRIPTION, minimum: 1 })),
});

interface SearchResponse {
  ok: boolean;
  messages?: SlackSearchResult;
}

export const searchTool: ToolDefinition<typeof Params, SlackDetails> = {
  name: "slack_search",
  label: SEARCH_TITLE,
  description: SEARCH_DESCRIPTION,
  parameters: Params,
  async execute(
    _toolCallId: string,
    params: Static<typeof Params>,
  ): Promise<AgentToolResult<SlackDetails>> {
    try {
      const resp = await slackGet<SearchResponse>("search.messages", {
        query: {
          query: params.query,
          count: params.count ?? 20,
          sort: params.sort,
          sort_dir: params.sort_dir,
          page: params.page,
        },
      });
      const result = resp.messages ?? { matches: [], total: 0 };
      const text = await formatSearchResults(result, params.query);
      return toToolResult(text);
    } catch (err) {
      return toToolResult(errorText(err));
    }
  },
};
