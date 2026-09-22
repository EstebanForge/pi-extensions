import { Type, type Static } from "typebox";
import type {
  AgentToolResult,
  ToolDefinition,
} from "@earendil-works/pi-coding-agent";
import { zdGet } from "../api";
import { toToolResult, errorText, type ZendeskDetails } from "../result";
import { formatDate } from "../format";
import type { ZdOrgResponse } from "../types";
import {
  GET_ORG_DESCRIPTION,
  GET_ORG_PARAM,
  GET_ORG_TITLE,
} from "../prompts";

const Params = Type.Object({
  organization: Type.Number({ description: GET_ORG_PARAM }),
});

export const getOrganizationTool: ToolDefinition<
  typeof Params,
  ZendeskDetails
> = {
  name: "zendesk_get_organization",
  label: GET_ORG_TITLE,
  description: GET_ORG_DESCRIPTION,
  parameters: Params,
  async execute(
    _toolCallId: string,
    params: Static<typeof Params>,
  ): Promise<AgentToolResult<ZendeskDetails>> {
    try {
      const resp = await zdGet<ZdOrgResponse>(
        `organizations/${params.organization}.json`,
      );
      const o = resp.organization;
      const lines = [
        `Organization #${o.id} - ${o.name}`,
        "",
        `Domains: ${o.domain_names?.length ? o.domain_names.join(", ") : "none"}`,
        `Created: ${formatDate(o.created_at)}`,
        `Updated: ${formatDate(o.updated_at)}`,
      ];
      if (o.details) lines.push("", `Details: ${o.details}`);
      if (o.notes) lines.push("", `Notes: ${o.notes}`);
      if (o.tags?.length) lines.push("", `Tags: ${o.tags.join(", ")}`);
      return toToolResult(lines.join("\n"));
    } catch (err) {
      return toToolResult(errorText(err));
    }
  },
};
