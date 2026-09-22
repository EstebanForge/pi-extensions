import { Type, type Static } from "typebox";
import type { AgentToolResult, ToolDefinition } from "@earendil-works/pi-coding-agent";
import { callAsana } from "../api";
import { toToolResult, errorText, type AsanaDetails } from "../result";
import type { AsanaUser } from "../types";
import { ME_TITLE, ME_DESCRIPTION, ME_OPT_FIELDS_DESCRIPTION } from "../prompts";

// Whoami. Single endpoint (`/users/me`). Returns the authenticated user plus
// the workspaces they have access to. Call once at the start of a session if
// later tools need a workspace GID or user GID.
const Params = Type.Object({
  opt_fields: Type.Optional(
    Type.String({ description: ME_OPT_FIELDS_DESCRIPTION }),
  ),
});

export const getMeTool: ToolDefinition<typeof Params, AsanaDetails> = {
  name: "asana_get_me",
  label: ME_TITLE,
  description: ME_DESCRIPTION,
  parameters: Params,
  async execute(
    _toolCallId: string,
    params: Static<typeof Params>,
  ): Promise<AgentToolResult<AsanaDetails>> {
    try {
      const me = await callAsana<AsanaUser>("GET", "/users/me", {
        query: params.opt_fields ? { opt_fields: params.opt_fields } : undefined,
      });
      const lines: string[] = [];
      lines.push(`Asana: authenticated as ${me.name ?? "(unnamed)"} (${me.email ?? "no email"}).`);
      lines.push(`User GID: ${me.gid}`);
      if (Array.isArray(me.workspaces) && me.workspaces.length > 0) {
        lines.push(`Workspaces (${me.workspaces.length}):`);
        for (const ws of me.workspaces) {
          lines.push(
            `  - ${ws.name ?? "(unnamed)"} (gid: ${ws.gid}, type: ${ws.resource_type ?? "workspace"})`,
          );
        }
      } else {
        lines.push(
          "Workspaces: none returned. The PAT may need to be re-issued with workspace access.",
        );
      }
      return toToolResult(lines.join("\n"));
    } catch (err) {
      return toToolResult(errorText(err));
    }
  },
};
