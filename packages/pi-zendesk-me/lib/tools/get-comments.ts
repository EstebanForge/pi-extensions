import { Type, type Static } from "typebox";
import type {
  AgentToolResult,
  ToolDefinition,
} from "@earendil-works/pi-coding-agent";
import { zdGet } from "../api";
import { toToolResult, errorText, type ZendeskDetails } from "../result";
import { buildSideLoadMaps, formatComment } from "../format";
import type { ZdCommentsResponse } from "../types";
import { parseTicketRef, TICKET_REF_EXAMPLE } from "../url";
import {
  GET_COMMENTS_DESCRIPTION,
  GET_COMMENTS_LIMIT_DESCRIPTION,
  GET_COMMENTS_PARAM,
  GET_COMMENTS_PUBLIC_ONLY_DESCRIPTION,
  GET_COMMENTS_TITLE,
} from "../prompts";

const Params = Type.Object({
  ticket: Type.String({ description: GET_COMMENTS_PARAM }),
  limit: Type.Optional(
    Type.Number({
      description: GET_COMMENTS_LIMIT_DESCRIPTION,
      minimum: 1,
      maximum: 100,
    }),
  ),
  public_only: Type.Optional(
    Type.Boolean({
      description: GET_COMMENTS_PUBLIC_ONLY_DESCRIPTION,
    }),
  ),
});

export const getCommentsTool: ToolDefinition<
  typeof Params,
  ZendeskDetails
> = {
  name: "zendesk_get_comments",
  label: GET_COMMENTS_TITLE,
  description: GET_COMMENTS_DESCRIPTION,
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
      const resp = await zdGet<ZdCommentsResponse>(
        `tickets/${id}/comments.json`,
        { query: { include: "users" } },
      );

      const all = resp.comments ?? [];
      const filtered = params.public_only
        ? all.filter((c) => c.public)
        : all;
      const limit = params.limit ?? 20;

      // Zendesk returns the thread oldest-first. Agents care most about the
      // latest state, so render the tail and count what was cut.
      const shown = filtered.slice(-limit);
      const hidden = filtered.length - shown.length;

      const maps = buildSideLoadMaps(resp.users, resp.organizations);
      const header = `Ticket #${id}: ${filtered.length} entr${
        filtered.length === 1 ? "y" : "ies"
      }${params.public_only ? " (public replies only)" : ""}` +
        (hidden > 0
          ? ` - showing ${shown.length} most recent, ${hidden} oldest hidden (raise limit to see them)`
          : "");

      const body = shown.map((c) => formatComment(c, maps)).join("\n\n");
      return toToolResult(
        [header, shown.length ? "" : "(no entries)", body]
          .filter((s) => s !== undefined)
          .join("\n"),
      );
    } catch (err) {
      return toToolResult(errorText(err));
    }
  },
};
