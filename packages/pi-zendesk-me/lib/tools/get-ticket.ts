import { Type, type Static } from "typebox";
import type {
  AgentToolResult,
  ToolDefinition,
} from "@earendil-works/pi-coding-agent";
import { zdGet } from "../api";
import { toToolResult, errorText, type ZendeskDetails } from "../result";
import {
  buildSideLoadMaps,
  formatDate,
  orgName,
  stripHtml,
  truncate,
  userName,
} from "../format";
import type { ZdTicketResponse } from "../types";
import { parseTicketRef, TICKET_REF_EXAMPLE } from "../url";
import {
  GET_TICKET_DESCRIPTION,
  GET_TICKET_INCLUDE_DESCRIPTION,
  GET_TICKET_PARAM,
  GET_TICKET_TITLE,
} from "../prompts";

const Params = Type.Object({
  ticket: Type.String({ description: GET_TICKET_PARAM }),
  include: Type.Optional(
    Type.Array(Type.String(), {
      description: GET_TICKET_INCLUDE_DESCRIPTION,
    }),
  ),
});

export const getTicketTool: ToolDefinition<
  typeof Params,
  ZendeskDetails
> = {
  name: "zendesk_get_ticket",
  label: GET_TICKET_TITLE,
  description: GET_TICKET_DESCRIPTION,
  parameters: Params,
  async execute(
    _toolCallId: string,
    params: Static<typeof Params>,
  ): Promise<AgentToolResult<ZendeskDetails>> {
    const id = parseTicketRef(params.ticket);
    if (id === null) {
      return toToolResult(
        `Invalid ticket reference: ${JSON.stringify(params.ticket)}. ` +
          `Pass ${TICKET_REF_EXAMPLE}.`,
      );
    }

    try {
      const include = params.include ?? ["users", "organizations"];
      const resp = await zdGet<ZdTicketResponse>(`tickets/${id}.json`, {
        query: { include: include.join(",") },
      });
      const t = resp.ticket;
      const maps = buildSideLoadMaps(resp.users, resp.organizations);

      const lines: string[] = [
        `Ticket #${t.id} - [${t.status}] ${t.subject ?? "(no subject)"}`,
        "",
        `Type: ${t.type ?? "none"}`,
        `Priority: ${t.priority ?? "normal"}`,
        `Requester: ${userName(maps, t.requester_id)}`,
        `Assignee: ${userName(maps, t.assignee_id)}`,
        `Organization: ${orgName(maps, t.organization_id)}`,
        `Created: ${formatDate(t.created_at)}`,
        `Updated: ${formatDate(t.updated_at)}`,
        `Due: ${formatDate(t.due_at)}`,
        `Tags: ${t.tags?.length ? t.tags.join(", ") : "none"}`,
      ];

      const description = stripHtml(t.description);
      if (description) {
        lines.push("", "Description:", truncate(description, 2000));
      }
      lines.push(
        "",
        "Use zendesk_get_comments for the full thread; " +
          "zendesk_get_user / zendesk_get_organization for more detail on any " +
          "person or org above.",
      );

      return toToolResult(lines.join("\n"));
    } catch (err) {
      return toToolResult(errorText(err));
    }
  },
};
