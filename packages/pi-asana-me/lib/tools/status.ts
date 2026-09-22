import { Type, type Static } from "typebox";
import type { AgentToolResult, ToolDefinition } from "@earendil-works/pi-coding-agent";
import { callAsana, AsanaError } from "../api";
import { toToolResult, errorText, type AsanaDetails } from "../result";
import type { AsanaProjectStatus } from "../types";
import {
  STATUS_OVERVIEW_TITLE,
  STATUS_OVERVIEW_DESCRIPTION,
} from "../prompts";

// Aggregated status report. Asana exposes this via
// `/projects/{gid}/project_statuses` (single project). We accept a list of
// project GIDs and walk them, surfacing per-project failures inline so one
// bad GID does not lose the rest of the report.
const Params = Type.Object({
  project_gids: Type.Array(Type.String(), {
    description:
      "One or more project GIDs to pull a status overview for (1-10). Pass the GIDs you already have; do not chain a search before this tool.",
    minItems: 1,
    maxItems: 10,
  }),
});

export const statusOverviewTool: ToolDefinition<typeof Params, AsanaDetails> = {
  name: "asana_get_status_overview",
  label: STATUS_OVERVIEW_TITLE,
  description: STATUS_OVERVIEW_DESCRIPTION,
  parameters: Params,
  async execute(
    _toolCallId: string,
    params: Static<typeof Params>,
  ): Promise<AgentToolResult<AsanaDetails>> {
    try {
      const blocks: string[] = [];
      for (const gid of params.project_gids) {
        try {
          const entries = await callAsana<AsanaProjectStatus[]>(
            "GET",
            `/projects/${encodeURIComponent(gid)}/project_statuses`,
            { query: { opt_fields: "title,text,color,author.name,created_at" } },
          );
          if (!Array.isArray(entries) || entries.length === 0) {
            blocks.push(`Project ${gid}: no status updates posted yet.`);
            continue;
          }
          blocks.push(`Project ${gid}: ${entries.length} status update(s).`);
          for (const s of entries) {
            const when = s.created_at ? ` (${s.created_at})` : "";
            const color = s.color ? ` [${s.color}]` : "";
            const title = s.title ?? "(no title)";
            const author = s.author?.name ?? "unknown author";
            blocks.push(`  - ${title}${color} - ${author}${when}`);
            if (s.text) blocks.push(`    ${s.text.slice(0, 300)}`);
          }
        } catch (inner) {
          if (inner instanceof AsanaError && inner.status === 404) {
            blocks.push(`Project ${gid}: not found. Verify the GID with asana_search_objects.`);
          } else {
            blocks.push(
              `Project ${gid}: error - ${inner instanceof Error ? inner.message : String(inner)}`,
            );
          }
        }
      }
      return toToolResult(blocks.join("\n"));
    } catch (err) {
      return toToolResult(errorText(err));
    }
  },
};
