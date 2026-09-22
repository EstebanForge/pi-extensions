import { Type, type Static } from "typebox";
import type { AgentToolResult, ToolDefinition } from "@earendil-works/pi-coding-agent";
import { slackGet } from "../api";
import { toToolResult, errorText, type SlackDetails } from "../result";
import { formatChannelList } from "../format";
import type { SlackChannel } from "../types";
import {
  LIST_CHANNELS_TITLE,
  LIST_CHANNELS_DESCRIPTION,
  LIST_CHANNELS_LIMIT_DESCRIPTION,
  LIST_CHANNELS_TYPES_DESCRIPTION,
  LIST_CHANNELS_CURSOR_DESCRIPTION,
} from "../prompts";

// List conversations the calling user can see. Uses users.conversations (NOT
// conversations.list): with a user token, users.conversations returns
// conversations the calling user is a member of, including DMs and group DMs,
// which is exactly the "what can I read" view this extension promises.
// conversations.list with a user token returns public channels workspace-wide
// (useful, but not the membership view we want as the default discovery tool).
const Params = Type.Object({
  limit: Type.Optional(Type.Number({ description: LIST_CHANNELS_LIMIT_DESCRIPTION, minimum: 1, maximum: 999 })),
  types: Type.Optional(Type.String({ description: LIST_CHANNELS_TYPES_DESCRIPTION })),
  cursor: Type.Optional(Type.String({ description: LIST_CHANNELS_CURSOR_DESCRIPTION })),
});

interface ListResponse {
  ok: boolean;
  channels?: SlackChannel[];
  response_metadata?: { next_cursor?: string };
}

export const listChannelsTool: ToolDefinition<typeof Params, SlackDetails> = {
  name: "slack_list_channels",
  label: LIST_CHANNELS_TITLE,
  description: LIST_CHANNELS_DESCRIPTION,
  parameters: Params,
  async execute(
    _toolCallId: string,
    params: Static<typeof Params>,
  ): Promise<AgentToolResult<SlackDetails>> {
    try {
      const resp = await slackGet<ListResponse>("users.conversations", {
        query: {
          limit: params.limit ?? 200,
          types: params.types ?? "public_channel,private_channel,im,mpim",
          cursor: params.cursor,
          exclude_archived: true,
        },
      });
      const channels = resp.channels ?? [];
      return toToolResult(formatChannelList(channels));
    } catch (err) {
      return toToolResult(errorText(err));
    }
  },
};
