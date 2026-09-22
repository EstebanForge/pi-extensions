import { Type, type Static } from "typebox";
import type {
  AgentToolResult,
  ToolDefinition,
} from "@earendil-works/pi-coding-agent";
import { zdGet } from "../api";
import { toToolResult, errorText, type ZendeskDetails } from "../result";
import { buildSideLoadMaps, formatDate, formatTicketLine } from "../format";
import type { ZdSearchResponse } from "../types";
import {
  SEARCH_ALL_TYPES_DESCRIPTION,
  SEARCH_DESCRIPTION,
  SEARCH_LIMIT_DESCRIPTION,
  SEARCH_QUERY_DESCRIPTION,
  SEARCH_TITLE,
} from "../prompts";

const Params = Type.Object({
  query: Type.String({ description: SEARCH_QUERY_DESCRIPTION }),
  limit: Type.Optional(
    Type.Number({
      description: SEARCH_LIMIT_DESCRIPTION,
      minimum: 1,
      maximum: 100,
    }),
  ),
  all_types: Type.Optional(
    Type.Boolean({
      description: SEARCH_ALL_TYPES_DESCRIPTION,
    }),
  ),
});

// Agents overwhelmingly mean "find tickets". Prepend type:ticket unless the
// query already pins a type (covers type:ticket and type:organization etc.).
function effectiveQuery(query: string, allTypes: boolean): string {
  if (allTypes || /(^|\s)type:/.test(query)) return query;
  return `type:ticket ${query}`;
}

export const searchTool: ToolDefinition<typeof Params, ZendeskDetails> = {
  name: "zendesk_search",
  label: SEARCH_TITLE,
  description: SEARCH_DESCRIPTION,
  parameters: Params,
  async execute(
    _toolCallId: string,
    params: Static<typeof Params>,
  ): Promise<AgentToolResult<ZendeskDetails>> {
    try {
      const query = effectiveQuery(params.query, params.all_types ?? false);
      const resp = await zdGet<ZdSearchResponse>("search.json", {
        query: { query, per_page: params.limit ?? 25 },
      });

      const results = resp.results ?? [];
      if (!results.length) {
        return toToolResult(`No results for: ${query}`);
      }

      const maps = buildSideLoadMaps();
      const lines = [
        `${resp.count} result${resp.count === 1 ? "" : "s"} for: ${query}` +
          (resp.next_page
            ? ` (showing first ${results.length} - narrow the query to refine)`
            : ""),
        "",
        ...results.map((r) => {
          if (r.result_type === "ticket") {
            return formatTicketLine(r, maps);
          }
          if (r.result_type === "user") {
            return `user result #${r.id} - use zendesk_get_user for details`;
          }
          if (r.result_type === "organization") {
            return `organization result #${r.id} - use zendesk_get_organization for details`;
          }
          return `${r.result_type} result (unrendered)`;
        }),
        "",
        "Dates (UTC):",
        ...results
          .filter((r) => r.result_type === "ticket")
          .map((r) => `#${r.id}: created ${formatDate(r.created_at)}`),
      ];

      return toToolResult(lines.join("\n"));
    } catch (err) {
      return toToolResult(errorText(err));
    }
  },
};

export { effectiveQuery };
