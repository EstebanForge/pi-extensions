import { Type, type Static } from "typebox";
import type { AgentToolResult, ToolDefinition } from "@earendil-works/pi-coding-agent";
import { callAsana, AsanaError } from "../api";
import { toToolResult, errorText, type AsanaDetails } from "../result";
import type { AsanaProjectCompact } from "../types";
import {
  GET_PROJECT_TITLE,
  GET_PROJECT_DESCRIPTION,
  GET_PROJECT_GID_DESCRIPTION,
  GET_PROJECT_INCLUDE_SECTIONS_DESCRIPTION,
  GET_PROJECT_OPT_FIELDS_DESCRIPTION,
  GET_PROJECTS_TITLE,
  GET_PROJECTS_DESCRIPTION,
  GET_PROJECTS_WORKSPACE_DESCRIPTION,
  GET_PROJECTS_TEAM_DESCRIPTION,
  GET_PROJECTS_ARCHIVED_DESCRIPTION,
} from "../prompts";

// --- Single project ---------------------------------------------------------

const GetProjectParams = Type.Object({
  gid: Type.String({ description: GET_PROJECT_GID_DESCRIPTION }),
  include_sections: Type.Optional(
    Type.Boolean({ description: GET_PROJECT_INCLUDE_SECTIONS_DESCRIPTION }),
  ),
  opt_fields: Type.Optional(
    Type.String({ description: GET_PROJECT_OPT_FIELDS_DESCRIPTION }),
  ),
});

export const getProjectTool: ToolDefinition<typeof GetProjectParams, AsanaDetails> = {
  name: "asana_get_project",
  label: GET_PROJECT_TITLE,
  description: GET_PROJECT_DESCRIPTION,
  parameters: GetProjectParams,
  async execute(
    _toolCallId: string,
    params: Static<typeof GetProjectParams>,
  ): Promise<AgentToolResult<AsanaDetails>> {
    try {
      const project = await callAsana<AsanaProjectCompact>(
        "GET",
        `/projects/${encodeURIComponent(params.gid)}`,
        {
          query: {
            opt_fields: params.opt_fields
              ? `${params.opt_fields},sections.name`
              : "name,notes,owner.name,members.name,current_status.title,current_status.color,task_counts.completed,layout,default_view",
          },
        },
      );
      const lines: string[] = [];
      lines.push(`Project ${project.gid}:`);
      lines.push(`  name: ${project.name ?? "(unnamed)"}`);
      if (project.notes) lines.push(`  notes: ${project.notes.slice(0, 300)}`);
      if (project.owner && project.owner.name) {
        lines.push(`  owner: ${project.owner.name}`);
      }
      if (Array.isArray(project.members) && project.members.length > 0) {
        lines.push(
          `  members: ${project.members.map((m) => m.name ?? "(unnamed)").join(", ")}`,
        );
      }
      if (project.current_status?.title) {
        const color = project.current_status.color ? ` (${project.current_status.color})` : "";
        lines.push(`  current status: ${project.current_status.title}${color}`);
      }
      if (params.include_sections && Array.isArray(project.sections) && project.sections.length > 0) {
        lines.push(`  sections:`);
        for (const s of project.sections) {
          lines.push(`    - ${s.name ?? "(unnamed)"} (gid: ${s.gid})`);
        }
      }
      return toToolResult(lines.join("\n"));
    } catch (err) {
      if (err instanceof AsanaError && err.status === 404) {
        return toToolResult(
          `Asana: project ${params.gid} not found. Verify the GID with \`asana_search_objects\` (resource_type=project).`,
        );
      }
      return toToolResult(errorText(err));
    }
  },
};

// --- Project list ----------------------------------------------------------

const GetProjectsParams = Type.Object({
  workspace: Type.Optional(
    Type.String({ description: GET_PROJECTS_WORKSPACE_DESCRIPTION }),
  ),
  team: Type.Optional(
    Type.String({ description: GET_PROJECTS_TEAM_DESCRIPTION }),
  ),
  archived: Type.Optional(
    Type.Boolean({ description: GET_PROJECTS_ARCHIVED_DESCRIPTION }),
  ),
  limit: Type.Optional(Type.Number({ minimum: 1, maximum: 100 })),
});

export const getProjectsTool: ToolDefinition<typeof GetProjectsParams, AsanaDetails> = {
  name: "asana_get_projects",
  label: GET_PROJECTS_TITLE,
  description: GET_PROJECTS_DESCRIPTION,
  parameters: GetProjectsParams,
  async execute(
    _toolCallId: string,
    params: Static<typeof GetProjectsParams>,
  ): Promise<AgentToolResult<AsanaDetails>> {
    try {
      if (!params.workspace && !params.team) {
        return toToolResult(
          'Asana error: asana_get_projects requires either a "workspace" GID or a "team" GID. Call asana_get_me first to list workspaces the PAT can see.',
        );
      }
      const list = await callAsana<AsanaProjectCompact[]>("GET", "/projects", {
        query: {
          workspace: params.workspace,
          team: params.team,
          archived: params.archived,
          opt_fields: "name,archived,owner.name,current_status.title",
          limit: params.limit ?? 50,
        },
      });
      const rows = list.map((p) => {
        const archived = p.archived ? " [archived]" : "";
        const owner = p.owner?.name ?? "no owner";
        return `- ${p.name ?? "(unnamed)"} (gid: ${p.gid}) - ${owner}${archived}`;
      });
      const header = `Asana: ${list.length} project${list.length === 1 ? "" : "s"}${
        params.archived ? " (including archived)" : ""
      }.`;
      return toToolResult(
        list.length === 0 ? `${header}\n(No projects matched.)` : `${header}\n${rows.join("\n")}`,
      );
    } catch (err) {
      return toToolResult(errorText(err));
    }
  },
};
