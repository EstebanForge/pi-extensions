/**
 * pi-slack-me - Slack tools for pi that act as YOU.
 *
 * Adds 8 LLM-callable tools that talk to the Slack Web API using a USER token
 * (xoxp-). There is no bot to invite: the app inherits the calling user's
 * membership and access, so it can read public channels, private channels the
 * user is in, DMs, and group DMs - exactly what the user sees in the Slack
 * client.
 *
 * Five read tools (list, read, thread, search, download) plus three write
 * tools (post, update, delete). The write tools post as the user. Posting,
 * editing, and DM-sending open an editable review dialog before sending; the
 * destructive delete tool is always confirmed and blocked in headless mode.
 *
 * Based on: Slack Web API - https://docs.slack.dev/reference/methods
 *           "act as me" user-token model per
 *           https://docs.slack.dev/authentication/tokens
 */
import type {
  ExtensionAPI,
  ExtensionCommandContext,
} from "@earendil-works/pi-coding-agent";
import { getSettingsListTheme } from "@earendil-works/pi-coding-agent";
import { Container, SettingsList, Text, type SettingItem } from "@earendil-works/pi-tui";
import { listChannelsTool } from "../lib/tools/list-channels";
import { readMessagesTool } from "../lib/tools/read-messages";
import { readThreadTool } from "../lib/tools/read-thread";
import { searchTool } from "../lib/tools/search";
import { downloadFileTool } from "../lib/tools/download-file";
import { postMessageTool } from "../lib/tools/post-message";
import { updateMessageTool } from "../lib/tools/update-message";
import { deleteMessageTool } from "../lib/tools/delete-message";
import { hasSlackToken } from "../lib/auth";
import {
  CONFIRM_WRITE_FLAG,
  CONFIRM_WRITE_FLAG_DESCRIPTION,
  ALLOW_HEADLESS_WRITE_FLAG,
  ALLOW_HEADLESS_WRITE_FLAG_DESCRIPTION,
  getConfirmWriteEnabled,
  setConfirmWriteEnabled,
  getAllowHeadlessWriteEnabled,
  setAllowHeadlessWriteEnabled,
} from "../lib/confirm";

// Compact tool guidance appended to the system prompt. Intentionally small:
// the tool descriptions themselves carry the detail; this just tells the
// agent when to reach for Slack, reinforces the act-as-me model, and notes
// that write tools gate themselves.
const TOOL_GUIDANCE = [
  "These tools act as the USER, not a bot: they read and post exactly what the user Slack account can, including DMs and private channels you are a member of.",
  "Use slack_list_channels FIRST to discover conversation IDs (channels C..., DMs D..., groups). It returns your membership view, including DMs.",
  "Use slack_read_messages to read a channel's recent history; slack_read_thread to read a thread's replies.",
  "Use slack_search for full-text search across the workspace (supports in:#channel, from:@user, after:YYYY-MM-DD). Great for finding feedback or reported issues.",
  "When a message references a file/image (shown with 📎), use slack_download_file with the file ID, then use the `read` tool on the returned path to view images.",
  "Write tools (slack_post_message, slack_update_message, slack_delete_message) gate themselves: post/update open an editable preview and delete asks yes/no. Call them directly; the extension handles review. You do NOT need to ask the user yourself.",
  "slack_post_message posts as you. Pass channel for a channel/group/DM, OR to_user (a U... user ID) to DM someone (not both). Set thread_ts to reply in a thread. Posting needs the chat:write scope; DM-ing via to_user also needs im:write.",
  "slack_delete_message is irreversible and is ALWAYS confirmed (even when the gate is off); in headless mode it is refused rather than running blind.",
  "In HEADLESS mode (no interactive UI), post/update are REFUSED by default (an unsupervised run cannot post on the user's behalf). The slack-allow-headless-write flag opts in to headless writes; delete is blocked headless regardless.",
].join(" ");

function slackMe(pi: ExtensionAPI): void {
  // Register the flag for /settings visibility and CLI `--slack-confirm-write`
  // override ONLY. The gate itself reads file-backed module state
  // (lib/confirm.ts getConfirmWriteEnabled) because pi extension flags are
  // in-memory-only with no setFlag API. Default mirrors the on-disk default.
  pi.registerFlag(CONFIRM_WRITE_FLAG, {
    description: CONFIRM_WRITE_FLAG_DESCRIPTION,
    type: "boolean",
    default: true,
  });
  pi.registerFlag(ALLOW_HEADLESS_WRITE_FLAG, {
    description: ALLOW_HEADLESS_WRITE_FLAG_DESCRIPTION,
    type: "boolean",
    default: false,
  });

  pi.registerTool(listChannelsTool);
  pi.registerTool(readMessagesTool);
  pi.registerTool(readThreadTool);
  pi.registerTool(searchTool);
  pi.registerTool(downloadFileTool);
  pi.registerTool(postMessageTool);
  pi.registerTool(updateMessageTool);
  pi.registerTool(deleteMessageTool);

  pi.on("before_agent_start", async (event) => {
    return {
      systemPrompt: [event.systemPrompt, TOOL_GUIDANCE]
        .filter(Boolean)
        .join("\n\n"),
    };
  });

  // /slack <verb> - prefix the editor with an explicit instruction so the
  // agent reaches for the right tool deterministically. The command cannot
  // directly dispatch a tool call, so it sets the editor text and the user
  // hits Enter to run. Same prefill pattern as pi-asana.
  //
  //   /slack channels [types]      -> slack_list_channels
  //   /slack dms                    -> slack_list_channels (types=im)
  //   /slack read <channel> [N]    -> slack_read_messages
  //   /slack thread <channel> <ts> -> slack_read_thread
  //   /slack search <query>        -> slack_search
  //   /slack post <channel> <text>  -> slack_post_message
  //   /slack dm <user> <text>       -> slack_post_message (to_user)
  //   /slack reply <channel> <ts> <text> -> slack_post_message (thread)
  //   /slack edit <channel> <ts> <text>  -> slack_update_message
  //   /slack delete <channel> <ts>  -> slack_delete_message
  //   /slack config                 -> settings modal (write review gate)
  //   /slack confirm on|off         -> toggle write review gate
  //   /slack headless on|off        -> toggle headless (no-UI) write opt-in
  //
  // Bare /slack prints token status + usage.
  pi.registerCommand("slack", {
    description:
      'Slack tools (act as you). Usage: /slack channels [types] | /slack dms | /slack read <channel> [N] | /slack thread <channel> <ts> | /slack search <query> | /slack post <channel> <text> | /slack dm <user> <text> | /slack reply <channel> <ts> <text> | /slack edit <channel> <ts> <text> | /slack delete <channel> <ts> | /slack config | /slack confirm on|off | /slack headless on|off.',
    handler: async (args, ctx) => {
      if (!hasSlackToken()) {
        ctx.ui.notify(
          "Slack: SLACK_USER_TOKEN is not set. Create a Slack app, add the User Token Scopes from the README, install it, and `export SLACK_USER_TOKEN=xoxp-...`.",
          "warning",
        );
        return;
      }

      const trimmed = args.trim();
      if (!trimmed) {
        ctx.ui.notify(
          "Slack: authenticated as your user token. Usage: /slack channels | /slack dms | /slack read <channel> [N] | /slack thread <channel> <ts> | /slack search <query> | /slack post <channel> <text> | /slack dm <user> <text> | /slack reply <channel> <ts> <text> | /slack edit <channel> <ts> <text> | /slack delete <channel> <ts> | /slack config | /slack confirm on|off | /slack headless on|off",
          "info",
        );
        return;
      }

      const firstSpace = trimmed.indexOf(" ");
      const verb = (firstSpace === -1 ? trimmed : trimmed.slice(0, firstSpace)).toLowerCase();
      const rest = firstSpace === -1 ? "" : trimmed.slice(firstSpace + 1).trim();

      let prompt: string | null = null;

      switch (verb) {
        case "channels":
        case "list":
          prompt = rest
            ? `Call the slack_list_channels tool with types="${rest}" to list the Slack conversations you can see.`
            : `Call the slack_list_channels tool to list the Slack conversations you can see (channels, DMs, groups).`;
          break;
        case "dms":
        case "dm": {
          // Bare "/slack dms" lists DMs; "/slack dm <user> <text>" sends one.
          if (rest) {
            const sp = rest.indexOf(" ");
            if (sp === -1) {
              ctx.ui.notify(
                "Usage: /slack dm <user id> <message>\nExample: /slack dm U0123ABC456 hey",
                "warning",
              );
              return;
            }
            const user = rest.slice(0, sp);
            const msg = rest.slice(sp + 1).trim();
            if (!msg) {
              ctx.ui.notify(
                "Usage: /slack dm <user id> <message>\nExample: /slack dm U0123ABC456 hey",
                "warning",
              );
              return;
            }
            prompt = `Call the slack_post_message tool with to_user="${user}" and text=${JSON.stringify(msg)} to DM that user. The user reviews the message before it is sent.`;
            break;
          }
          prompt = `Call the slack_list_channels tool with types="im" to list your Slack direct messages.`;
          break;
        }
        case "read":
        case "history": {
          const parts = rest.split(/\s+/).filter(Boolean);
          const channel = parts[0];
          const limit = parts[1];
          if (!channel) {
            ctx.ui.notify(
              "Usage: /slack read <channel> [limit]\nExample: /slack read C0123ABC456   or   /slack read C0123ABC456 20",
              "warning",
            );
            return;
          }
          const limitNote = limit && /^\d+$/.test(limit) ? ` limit=${limit}` : "";
          prompt = `Call the slack_read_messages tool with channel="${channel}"${limitNote} to read recent messages from that Slack conversation.`;
          break;
        }
        case "thread": {
          const parts = rest.split(/\s+/).filter(Boolean);
          if (parts.length < 2) {
            ctx.ui.notify(
              "Usage: /slack thread <channel> <thread_ts>\nExample: /slack thread C0123ABC456 1512085950.000216",
              "warning",
            );
            return;
          }
          prompt = `Call the slack_read_thread tool with channel="${parts[0]}" and thread_ts="${parts[1]}" to read the replies in that Slack thread.`;
          break;
        }
        case "search":
        case "find":
          if (!rest) {
            ctx.ui.notify(
              "Usage: /slack search <query>\nExample: /slack search broken deploy in:#ops",
              "warning",
            );
            return;
          }
          prompt = `Call the slack_search tool with query="${rest}" to search Slack messages across the workspace.`;
          break;
        case "post":
        case "send": {
          // /slack post <channel> <text...>
          const sp = rest.indexOf(" ");
          if (sp === -1) {
            ctx.ui.notify(
              "Usage: /slack post <channel> <message>\nExample: /slack post C0123ABC456 deploying now",
              "warning",
            );
            return;
          }
          const channel = rest.slice(0, sp);
          const msg = rest.slice(sp + 1).trim();
          if (!msg) {
            ctx.ui.notify(
              "Usage: /slack post <channel> <message>\nExample: /slack post C0123ABC456 deploying now",
              "warning",
            );
            return;
          }
          prompt = `Call the slack_post_message tool with channel="${channel}" and text=${JSON.stringify(msg)} to post that message. The user reviews it before it is sent.`;
          break;
        }
        case "reply": {
          // /slack reply <channel> <ts> <text...>
          const parts = rest.split(/\s+/);
          if (parts.length < 3) {
            ctx.ui.notify(
              "Usage: /slack reply <channel> <thread_ts> <message>\nExample: /slack reply C0123ABC456 1512085950.000216 confirmed",
              "warning",
            );
            return;
          }
          const channel = parts[0];
          const threadTs = parts[1];
          const msg = parts.slice(2).join(" ").trim();
          prompt = `Call the slack_post_message tool with channel="${channel}", thread_ts="${threadTs}", and text=${JSON.stringify(msg)} to reply in that thread. The user reviews it before it is sent.`;
          break;
        }
        case "edit":
        case "update": {
          // /slack edit <channel> <ts> <text...>
          const parts = rest.split(/\s+/);
          if (parts.length < 3) {
            ctx.ui.notify(
              "Usage: /slack edit <channel> <ts> <new message>\nExample: /slack edit C0123ABC456 1512085950.000216 updated text",
              "warning",
            );
            return;
          }
          const channel = parts[0];
          const ts = parts[1];
          const msg = parts.slice(2).join(" ").trim();
          prompt = `Call the slack_update_message tool with channel="${channel}", ts="${ts}", and text=${JSON.stringify(msg)} to edit that message. The user reviews the new text before it is applied.`;
          break;
        }
        case "delete":
        case "remove": {
          // /slack delete <channel> <ts>
          const parts = rest.split(/\s+/).filter(Boolean);
          if (parts.length < 2) {
            ctx.ui.notify(
              "Usage: /slack delete <channel> <ts>\nExample: /slack delete C0123ABC456 1512085950.000216",
              "warning",
            );
            return;
          }
          prompt = `Call the slack_delete_message tool with channel="${parts[0]}" and ts="${parts[1]}" to delete that message. It will ask for confirmation first.`;
          break;
        }
        case "config": {
          await openConfigModal(ctx);
          return;
        }
        case "confirm": {
          // /slack confirm on|off - one-shot toggle of the write review gate.
          const next = rest.toLowerCase();
          if (next !== "on" && next !== "off") {
            ctx.ui.notify('Usage: /slack confirm on|off', "warning");
            return;
          }
          const value = next === "on";
          if (setConfirmWriteEnabled(value)) {
            ctx.ui.notify(`${CONFIRM_WRITE_FLAG}: ${next}. (delete stays guarded regardless.)`, "info");
          } else {
            ctx.ui.notify(`Failed to persist ${CONFIRM_WRITE_FLAG} (disk write failed).`, "error");
          }
          return;
        }
        case "headless": {
          // /slack headless on|off - opt in/out of unsupervised (no-UI) writes.
          const next = rest.toLowerCase();
          if (next !== "on" && next !== "off") {
            ctx.ui.notify('Usage: /slack headless on|off', "warning");
            return;
          }
          const value = next === "on";
          if (setAllowHeadlessWriteEnabled(value)) {
            ctx.ui.notify(`${ALLOW_HEADLESS_WRITE_FLAG}: ${next}.`, "info");
          } else {
            ctx.ui.notify(`Failed to persist ${ALLOW_HEADLESS_WRITE_FLAG} (disk write failed).`, "error");
          }
          return;
        }
        default:
          prompt = `The user typed "/slack ${trimmed}" with an unknown verb. Show the available verbs (channels, dms, read, thread, search, post, dm, reply, edit, delete, config, confirm) and ask what they want.`;
          break;
      }

      if (prompt) ctx.ui.setEditorText(prompt);
    },
  });
}

// Settings modal for /slack config. Single flag today; the SettingsList path
// scales if more flags are added later. Non-TUI callers get a status notify.
// Ported from pi-asana's openConfigModal; the gate is file-backed so no reload
// is needed after a toggle.
async function openConfigModal(
  ctx: ExtensionCommandContext,
): Promise<void> {
  const currentConfirm = getConfirmWriteEnabled();
  const currentHeadless = getAllowHeadlessWriteEnabled();

  if (ctx.mode !== "tui") {
    ctx.ui.notify(
      `Slack write review (post/update): ${currentConfirm ? "on" : "off"}. Delete is always guarded. Headless writes: ${currentHeadless ? "on" : "off"}. Toggle: /slack confirm on|off, /slack headless on|off`,
      "info",
    );
    return;
  }

  const items: SettingItem[] = [
    {
      id: CONFIRM_WRITE_FLAG,
      label: "Review before posting writes",
      description: CONFIRM_WRITE_FLAG_DESCRIPTION,
      currentValue: currentConfirm ? "on" : "off",
      values: ["on", "off"],
    },
    {
      id: ALLOW_HEADLESS_WRITE_FLAG,
      label: "Allow writes in headless mode",
      description: ALLOW_HEADLESS_WRITE_FLAG_DESCRIPTION,
      currentValue: currentHeadless ? "on" : "off",
      values: ["on", "off"],
    },
  ];

  const pending = new Map<string, boolean>();

  await ctx.ui.custom((tui, theme, _kb, done) => {
    const container = new Container();
    container.addChild(
      new Text(theme.fg("accent", theme.bold("Slack extension settings")), 1, 1),
    );
    const settingsList = new SettingsList(
      items,
      Math.min(items.length + 2, 15),
      getSettingsListTheme(),
      (id: string, newValue: string) => {
        pending.set(id, newValue === "on");
      },
      () => done(undefined),
    );
    container.addChild(settingsList);
    return {
      render: (w: number) => container.render(w),
      invalidate: () => container.invalidate(),
      handleInput: (data: string) => {
        settingsList.handleInput?.(data);
        tui.requestRender();
      },
    };
  });

  // Persist genuine deltas only (drop net-zero flips). The generic onChange
  // key is the flag id, so this scales to any number of flags without a
  // per-flag persist block. File-backed setters apply live; no reload needed.
  const setters: Record<string, (v: boolean) => boolean> = {
    [CONFIRM_WRITE_FLAG]: setConfirmWriteEnabled,
    [ALLOW_HEADLESS_WRITE_FLAG]: setAllowHeadlessWriteEnabled,
  };
  const previous: Record<string, boolean> = {
    [CONFIRM_WRITE_FLAG]: currentConfirm,
    [ALLOW_HEADLESS_WRITE_FLAG]: currentHeadless,
  };
  let changed = false;
  for (const [id, target] of pending) {
    if (target === undefined || target === previous[id]) continue;
    const ok = setters[id]?.(target);
    if (ok) {
      ctx.ui.notify(`${id}: ${previous[id]} → ${target ? "on" : "off"}.`, "info");
      changed = true;
    } else {
      ctx.ui.notify(`Failed to persist ${id} (disk write failed).`, "error");
      changed = true;
    }
  }
  if (!changed) return;
}

export default slackMe;
