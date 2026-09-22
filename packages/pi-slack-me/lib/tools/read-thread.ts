import { Type, type Static } from "typebox";
import type { AgentToolResult, ToolDefinition } from "@earendil-works/pi-coding-agent";
import { slackGet } from "../api";
import { toToolResult, errorText, type SlackDetails } from "../result";
import { formatThread } from "../format";
import type { SlackMessage } from "../types";
import {
  READ_THREAD_TITLE,
  READ_THREAD_DESCRIPTION,
  READ_THREAD_CHANNEL_DESCRIPTION,
  READ_THREAD_TS_DESCRIPTION,
  READ_THREAD_LIMIT_DESCRIPTION,
  READ_THREAD_CURSOR_DESCRIPTION,
} from "../prompts";

const Params = Type.Object({
  channel: Type.String({ description: READ_THREAD_CHANNEL_DESCRIPTION }),
  thread_ts: Type.String({ description: READ_THREAD_TS_DESCRIPTION }),
  limit: Type.Optional(Type.Number({ description: READ_THREAD_LIMIT_DESCRIPTION, minimum: 1, maximum: 1000 })),
  cursor: Type.Optional(Type.String({ description: READ_THREAD_CURSOR_DESCRIPTION })),
});

interface RepliesResponse {
  ok: boolean;
  messages?: SlackMessage[];
  has_more?: boolean;
  response_metadata?: { next_cursor?: string };
}

export const readThreadTool: ToolDefinition<typeof Params, SlackDetails> = {
  name: "slack_read_thread",
  label: READ_THREAD_TITLE,
  description: READ_THREAD_DESCRIPTION,
  parameters: Params,
  async execute(
    _toolCallId: string,
    params: Static<typeof Params>,
  ): Promise<AgentToolResult<SlackDetails>> {
    try {
      const resp = await slackGet<RepliesResponse>("conversations.replies", {
        query: {
          channel: params.channel,
          ts: params.thread_ts,
          limit: params.limit ?? 100,
          cursor: params.cursor,
        },
      });
      const messages = resp.messages ?? [];
      const text = await formatThread(
        messages,
        params.channel,
        params.thread_ts,
        resp.has_more,
      );
      return toToolResult(text);
    } catch (err) {
      return toToolResult(errorText(err));
    }
  },
};
