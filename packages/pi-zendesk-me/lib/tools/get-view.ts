import { Type, type Static } from "typebox";
import type {
  AgentToolResult,
  ToolDefinition,
} from "@earendil-works/pi-coding-agent";
import { zdGet } from "../api";
import { toToolResult, errorText, type ZendeskDetails } from "../result";
import { buildSideLoadMaps, formatTicketLine } from "../format";
import type { ZdViewExecuteResponse, ZdViewResponse } from "../types";
import { parseViewRef, VIEW_REF_EXAMPLE } from "../url";
import {
  GET_VIEW_DESCRIPTION,
  GET_VIEW_LIMIT_DESCRIPTION,
  GET_VIEW_PARAM,
  GET_VIEW_TITLE,
} from "../prompts";

const Params = Type.Object({
  view: Type.String({ description: GET_VIEW_PARAM }),
  limit: Type.Optional(
    Type.Number({
      description: GET_VIEW_LIMIT_DESCRIPTION,
      minimum: 1,
      maximum: 100,
    }),
  ),
});

export const getViewTool: ToolDefinition<typeof Params, ZendeskDetails> = {
  name: "zendesk_get_view",
  label: GET_VIEW_TITLE,
  description: GET_VIEW_DESCRIPTION,
  parameters: Params,
  async execute(
    _toolCallId: string,
    params: Static<typeof Params>,
  ): Promise<AgentToolResult<ZendeskDetails>> {
    const id = parseViewRef(params.view);
    if (id === null) {
      return toToolResult(
        `Invalid view reference: ${JSON.stringify(params.view)}. ` +
          `Pass ${VIEW_REF_EXAMPLE}.`,
      );
    }

    try {
      const limit = params.limit ?? 25;
      const viewResp = await zdGet<ZdViewResponse>(`views/${id}.json`);
      const execResp = await zdGet<ZdViewExecuteResponse>(
        `views/${id}/execute.json`,
        {
          query: {
            per_page: limit,
            include: "users,organizations",
          },
        },
      );

      const title = viewResp.view.title ?? "(untitled view)";
      const rows = execResp.rows ?? [];
      const count = execResp.count ?? rows.length;
      const maps = buildSideLoadMaps(execResp.users, execResp.organizations);

      const lines = [
        `View #${id} - ${title}`,
        `${count} matching ticket${count === 1 ? "" : "s"}` +
          (execResp.next_page
            ? ` (showing first ${rows.length} - raise limit or narrow the view to refine)`
            : ""),
        "",
        ...(rows.length
          ? rows.map((row) => formatTicketLine(row.ticket, maps))
          : ["(no matching tickets)"]),
      ];

      return toToolResult(lines.join("\n"));
    } catch (err) {
      return toToolResult(errorText(err));
    }
  },
};
