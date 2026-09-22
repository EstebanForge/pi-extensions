import { Type, type Static } from "typebox";
import type { AgentToolResult, ToolDefinition } from "@earendil-works/pi-coding-agent";
import { callAsana } from "../api";
import { toToolResult, errorText, type AsanaDetails } from "../result";
import type { AsanaRef } from "../types";
import {
  SEARCH_TITLE,
  SEARCH_DESCRIPTION,
  SEARCH_WORKSPACE_DESCRIPTION,
  SEARCH_QUERY_DESCRIPTION,
  SEARCH_RESOURCE_TYPE_DESCRIPTION,
  SEARCH_LIMIT_DESCRIPTION,
} from "../prompts";

// Universal search via the Asana typeahead endpoint. One call resolves partial
// names against ONE resource type per request - the typeahead endpoint
// does not accept a CSV list of types (verified in the OpenAPI spec at
// developers.asana.com/reference/typeaheadforworkspace).
//
// Accepts: task | project | user | tag (the four the curated tool surface
// cares about; full enum is actor/agent/custom_field/goal/project/portfolio/
// project_template/tag/task/team/user but the others are not exposed by any
// other tool here). Defaults to "task" since that is the common case in the
// Wicket stack.
const Params = Type.Object({
  workspace: Type.String({ description: SEARCH_WORKSPACE_DESCRIPTION }),
  query: Type.String({ description: SEARCH_QUERY_DESCRIPTION, minLength: 1 }),
  resource_type: Type.Optional(
    Type.Union(
      [Type.Literal("task"), Type.Literal("project"), Type.Literal("user"), Type.Literal("tag")],
      { description: SEARCH_RESOURCE_TYPE_DESCRIPTION, default: "task" },
    ),
  ),
  count: Type.Optional(
    Type.Number({ description: SEARCH_LIMIT_DESCRIPTION, minimum: 1, maximum: 100 }),
  ),
});

export const searchObjectsTool: ToolDefinition<typeof Params, AsanaDetails> = {
  name: "asana_search_objects",
  label: SEARCH_TITLE,
  description: SEARCH_DESCRIPTION,
  parameters: Params,
  async execute(
    _toolCallId: string,
    params: Static<typeof Params>,
  ): Promise<AgentToolResult<AsanaDetails>> {
    try {
      const resourceType = params.resource_type ?? "task";
      const items = await callAsana<AsanaRef[]>(
        "GET",
        `/workspaces/${encodeURIComponent(params.workspace)}/typeahead`,
        {
          query: {
            resource_type: resourceType,
            query: params.query,
            count: params.count ?? 20,
          },
        },
      );

      const list = Array.isArray(items) ? items : [];
      if (list.length === 0) {
        return toToolResult(
          `No ${resourceType} matched "${params.query}" in workspace ${params.workspace}. ` +
            `Try a shorter query, check the workspace GID with \`asana_get_me\`, ` +
            `or pass a different resource_type (task / project / user / tag).`,
        );
      }

      const rows = list.map(
        (it) => `- [${it.resource_type ?? "object"}] ${it.name ?? "(unnamed)"} (gid: ${it.gid})`,
      );
      const header =
        `Asana search: ${list.length} ${resourceType}${
          list.length === 1 ? "" : "s"
        } matched "${params.query}" in workspace ${params.workspace}.`;
      return toToolResult(`${header}\n${rows.join("\n")}`);
    } catch (err) {
      return toToolResult(errorText(err));
    }
  },
};
