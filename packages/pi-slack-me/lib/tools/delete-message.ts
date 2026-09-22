import { Type, type Static } from "typebox";
import type { AgentToolResult, ToolDefinition } from "@earendil-works/pi-coding-agent";
import { slackPost, SlackApiError } from "../api";
import { confirmWrite, summarizeDeleteMessage } from "../confirm";
import { toToolResult, errorText, type SlackDetails } from "../result";
import {
  DELETE_MESSAGE_TITLE,
  DELETE_MESSAGE_DESCRIPTION,
  DELETE_MESSAGE_CHANNEL_DESCRIPTION,
  DELETE_MESSAGE_TS_DESCRIPTION,
} from "../prompts";

// Delete a message as the calling user. chat.delete is irreversible, so this
// tool sets requireInteractive: the yes/no confirm runs even when the gate
// flag is off, and the call is refused in headless mode (no UI to confirm).

const Params = Type.Object({
  channel: Type.String({ description: DELETE_MESSAGE_CHANNEL_DESCRIPTION }),
  ts: Type.String({ description: DELETE_MESSAGE_TS_DESCRIPTION }),
});

interface ChatDeleteResponse {
  ok: boolean;
  channel?: string;
  ts?: string;
}

export const deleteMessageTool: ToolDefinition<typeof Params, SlackDetails> = {
  name: "slack_delete_message",
  label: DELETE_MESSAGE_TITLE,
  description: DELETE_MESSAGE_DESCRIPTION,
  parameters: Params,
  async execute(
    _toolCallId: string,
    params: Static<typeof Params>,
    _signal,
    _onUpdate,
    ctx,
  ): Promise<AgentToolResult<SlackDetails>> {
    // Destructive gate: always confirmed, blocked in headless. This cannot be
    // disabled by the slack-confirm-write flag.
    const decision = await confirmWrite(ctx, {
      title: `Delete message ${params.ts} in ${params.channel}?`,
      summary: summarizeDeleteMessage({ channel: params.channel, ts: params.ts }),
      requireInteractive: true,
    });
    if (!decision.proceed) {
      return toToolResult(
        `Slack: delete cancelled${ctx.hasUI ? " by user" : " (no interactive UI to confirm a destructive write)"}. Message ${params.ts} was NOT deleted.`,
      );
    }

    try {
      await slackPost<ChatDeleteResponse>("chat.delete", {
        body: { channel: params.channel, ts: params.ts },
      });
      return toToolResult(
        `Slack: message ${params.ts} deleted from ${params.channel} (permanent).`,
      );
    } catch (err) {
      if (err instanceof SlackApiError && err.isAuthError) {
        return toToolResult(
          `Slack: cannot delete - token is invalid or lacks the chat:write scope. ${err.message}`,
        );
      }
      return toToolResult(errorText(err));
    }
  },
};
