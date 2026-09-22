import { Type, type Static } from "typebox";
import type { AgentToolResult, ToolDefinition } from "@earendil-works/pi-coding-agent";
import { slackGet } from "../api";
import { toToolResult, errorText, type SlackDetails } from "../result";
import { formatMessages } from "../format";
import type { SlackMessage } from "../types";
import {
  READ_MESSAGES_TITLE,
  READ_MESSAGES_DESCRIPTION,
  READ_MESSAGES_CHANNEL_DESCRIPTION,
  READ_MESSAGES_LIMIT_DESCRIPTION,
  READ_MESSAGES_OLDEST_DESCRIPTION,
  READ_MESSAGES_LATEST_DESCRIPTION,
  READ_MESSAGES_CURSOR_DESCRIPTION,
} from "../prompts";

const Params = Type.Object({
  channel: Type.String({ description: READ_MESSAGES_CHANNEL_DESCRIPTION }),
  limit: Type.Optional(Type.Number({ description: READ_MESSAGES_LIMIT_DESCRIPTION, minimum: 1, maximum: 200 })),
  oldest: Type.Optional(Type.String({ description: READ_MESSAGES_OLDEST_DESCRIPTION })),
  latest: Type.Optional(Type.String({ description: READ_MESSAGES_LATEST_DESCRIPTION })),
  cursor: Type.Optional(Type.String({ description: READ_MESSAGES_CURSOR_DESCRIPTION })),
});

interface HistoryResponse {
  ok: boolean;
  messages?: SlackMessage[];
  has_more?: boolean;
  response_metadata?: { next_cursor?: string };
}

export const readMessagesTool: ToolDefinition<typeof Params, SlackDetails> = {
  name: "slack_read_messages",
  label: READ_MESSAGES_TITLE,
  description: READ_MESSAGES_DESCRIPTION,
  parameters: Params,
  async execute(
    _toolCallId: string,
    params: Static<typeof Params>,
  ): Promise<AgentToolResult<SlackDetails>> {
    try {
      // Slack's `oldest`/`latest` are EXCLUSIVE by default: a message whose
      // ts equals the boundary is omitted. That breaks the single-message read
      // pattern ("read this permalink") and is rarely what a caller wants.
      // When either bound is set, opt into inclusive results. Slack ignores
      // `inclusive` unless oldest/latest is supplied, so this is safe.
      const useInclusive = params.oldest !== undefined || params.latest !== undefined;
      const resp = await slackGet<HistoryResponse>("conversations.history", {
        query: {
          channel: params.channel,
          limit: params.limit ?? 50,
          oldest: params.oldest,
          latest: params.latest,
          inclusive: useInclusive ? true : undefined,
          cursor: params.cursor,
        },
      });
      const messages = resp.messages ?? [];
      const text = await formatMessages(messages, params.channel, resp.has_more);
      return toToolResult(text);
    } catch (err) {
      return toToolResult(errorText(err));
    }
  },
};
