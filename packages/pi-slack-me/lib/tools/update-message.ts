import { Type, type Static } from "typebox";
import type { AgentToolResult, ToolDefinition } from "@earendil-works/pi-coding-agent";
import { slackPost, SlackApiError } from "../api";
import { confirmWrite, summarizeUpdateMessage } from "../confirm";
import { toToolResult, errorText, postedContentExtras, type SlackDetails } from "../result";
import {
  UPDATE_MESSAGE_TITLE,
  UPDATE_MESSAGE_DESCRIPTION,
  UPDATE_MESSAGE_CHANNEL_DESCRIPTION,
  UPDATE_MESSAGE_TS_DESCRIPTION,
  UPDATE_MESSAGE_TEXT_DESCRIPTION,
} from "../prompts";

// Edit the text of a message you previously posted. chat.update with a user
// token can only touch your own messages; Slack rejects edits to others'
// messages with cant_update_message.

const Params = Type.Object({
  channel: Type.String({ description: UPDATE_MESSAGE_CHANNEL_DESCRIPTION }),
  ts: Type.String({ description: UPDATE_MESSAGE_TS_DESCRIPTION }),
  text: Type.String({ description: UPDATE_MESSAGE_TEXT_DESCRIPTION, minLength: 1 }),
});

interface ChatUpdateResponse {
  ok: boolean;
  channel?: string;
  ts?: string;
  text?: string;
}

export const updateMessageTool: ToolDefinition<typeof Params, SlackDetails> = {
  name: "slack_update_message",
  label: UPDATE_MESSAGE_TITLE,
  description: UPDATE_MESSAGE_DESCRIPTION,
  parameters: Params,
  async execute(
    _toolCallId: string,
    params: Static<typeof Params>,
    _signal,
    _onUpdate,
    ctx,
  ): Promise<AgentToolResult<SlackDetails>> {
    // Review-before-send gate (editable).
    const decision = await confirmWrite(ctx, {
      title: `Edit message ${params.ts} in ${params.channel}?`,
      editableText: params.text,
      summary: summarizeUpdateMessage({
        channel: params.channel,
        ts: params.ts,
        text: params.text,
      }),
    });
    if (!decision.proceed) {
      return toToolResult(
        ctx.hasUI
          ? `Slack: edit cancelled by user. Message ${params.ts} was not changed.`
          : `Slack: edit not applied (headless mode; no UI to review). Use /slack headless on to allow unsupervised writes.`,
      );
    }
    const text = decision.text ?? params.text;

    try {
      await slackPost<ChatUpdateResponse>("chat.update", {
        body: { channel: params.channel, ts: params.ts, text },
      });
      const { extraText, details } = postedContentExtras(text, decision.edited ?? false);
      return toToolResult(
        `Slack: message ${params.ts} updated in ${params.channel}.${extraText}`,
        details,
      );
    } catch (err) {
      if (err instanceof SlackApiError && err.code === "cant_update_message") {
        return toToolResult(
          `Slack: cannot edit ${params.ts} - only messages you authored can be edited with a user token. The ts may belong to another user.`,
        );
      }
      if (err instanceof SlackApiError && err.isAuthError) {
        return toToolResult(
          `Slack: cannot edit - token is invalid or lacks the chat:write scope. ${err.message}`,
        );
      }
      return toToolResult(errorText(err));
    }
  },
};
