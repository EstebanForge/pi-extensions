import { Type, type Static } from "typebox";
import type {
  AgentToolResult,
  ToolDefinition,
} from "@earendil-works/pi-coding-agent";
import { zdGet } from "../api";
import { toToolResult, errorText, type ZendeskDetails } from "../result";
import { formatDate } from "../format";
import type { ZdUserResponse } from "../types";
import {
  GET_USER_DESCRIPTION,
  GET_USER_PARAM,
  GET_USER_TITLE,
} from "../prompts";

const Params = Type.Object({
  user: Type.Number({ description: GET_USER_PARAM }),
});

export const getUserTool: ToolDefinition<typeof Params, ZendeskDetails> = {
  name: "zendesk_get_user",
  label: GET_USER_TITLE,
  description: GET_USER_DESCRIPTION,
  parameters: Params,
  async execute(
    _toolCallId: string,
    params: Static<typeof Params>,
  ): Promise<AgentToolResult<ZendeskDetails>> {
    try {
      const resp = await zdGet<ZdUserResponse>(
        `users/${params.user}.json`,
      );
      const u = resp.user;
      const lines = [
        `User #${u.id} - ${u.name}`,
        "",
        `Email: ${u.email ?? "none"}`,
        `Role: ${u.role}`,
        `Active: ${u.active ? "yes" : "no"}`,
        `Organization: ${u.organization_id ? `#${u.organization_id}` : "none"}`,
        `Time zone: ${u.time_zone ?? "unknown"}`,
        `Created: ${formatDate(u.created_at)}`,
        `Updated: ${formatDate(u.updated_at)}`,
      ];
      if (u.details) lines.push("", `Details: ${u.details}`);
      if (u.notes) lines.push("", `Notes: ${u.notes}`);
      if (u.tags?.length) lines.push("", `Tags: ${u.tags.join(", ")}`);
      return toToolResult(lines.join("\n"));
    } catch (err) {
      return toToolResult(errorText(err));
    }
  },
};
