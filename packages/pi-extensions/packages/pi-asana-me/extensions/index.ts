/**
 * pi-asana-me - Asana Work Graph tools for pi.
 *
 * Adds 19 LLM-callable tools that talk to the Asana REST API
 * (https://app.asana.com/api/1.0) over plain HTTP+JSON. No MCP server install
 * is required: this extension issues standard REST calls with a personal
 * access token (PAT) read from the ASANA_ACCESS_TOKEN environment variable.
 *
 * The tool surface mirrors a curated subset of the official Asana MCP server
 * (https://developers.asana.com/docs/mcp-tools-reference). The 19 tools cover
 * the read-then-write flows an LLM agent actually needs; noisy duplicates and
 * Claude/ChatGPT-only confirmation-UI tools are intentionally omitted.
 *
 * Tool awareness is injected as a compact system-prompt appendix via
 * before_agent_start (no skill file, to keep token cost minimal).
 *
 * Based on: Asana REST API - https://developers.asana.com/reference
 *           Asana MCP V2 server - https://developers.asana.com/docs/mcp-tools-reference
 */
import type {
  ExtensionAPI,
  ExtensionCommandContext,
} from "@earendil-works/pi-coding-agent";
import { getSettingsListTheme } from "@earendil-works/pi-coding-agent";
import { Container, SettingsList, Text, type SettingItem } from "@earendil-works/pi-tui";
import { searchObjectsTool } from "../lib/tools/search";
import { getMeTool } from "../lib/tools/me";
import { getMyTasksTool } from "../lib/tools/my-tasks";
import { getTaskTool } from "../lib/tools/task";
import { getTaskDescriptionTool } from "../lib/tools/task-description";
import { getTasksTool } from "../lib/tools/tasks";
import { getProjectTool, getProjectsTool } from "../lib/tools/project";
import { statusOverviewTool } from "../lib/tools/status";
import { createTasksTool } from "../lib/tools/create-tasks";
import { updateTasksTool } from "../lib/tools/update-tasks";
import { getCustomFieldsTool } from "../lib/tools/custom-fields-get";
import { setCustomFieldsTool } from "../lib/tools/custom-fields-set";
import { addCommentTool } from "../lib/tools/comment-add";
import { updateCommentTool } from "../lib/tools/comment-update";
import { getCommentTool } from "../lib/tools/comment-get";
import { getTaskCommentsTool } from "../lib/tools/comment-list";
import { listAttachmentsTool } from "../lib/tools/attachment-list";
import { downloadAttachmentTool } from "../lib/tools/attachment-download";
import {
  CONFIRM_WRITE_FLAG,
  CONFIRM_WRITE_FLAG_DESCRIPTION,
  getConfirmWriteEnabled,
  setConfirmWriteEnabled,
} from "../lib/confirm";

// Compact tool guidance appended to the system prompt. Intentionally small:
// the tool descriptions themselves carry the detail; this just tells the
// agent when to reach for Asana. Mirrors the pi-deepwiki TOOL_GUIDANCE pattern.
const TOOL_GUIDANCE = [
  "Asana tools (asana_*) are available when ASANA_ACCESS_TOKEN is set in the environment.",
  'Use asana_search_objects FIRST when you do not know a GID; pass a workspace from asana_get_me as "workspace".',
  "Use asana_get_my_tasks as the shortcut for the authenticated user\u2019s task list.",
  "Use asana_get_tasks with one of project/section/tag/assignee for bulk reads; asana_get_task for full detail on one task.",
  "asana_get_task truncates the notes/description to 2000 chars; call asana_get_task_description for the full, untruncated body when you need the whole spec.",
  "Use asana_get_status_overview for cross-project rollups; do not chain a search before it.",
  "asana_update_comment edits a comment previously posted (own comments only; system stories and other people's comments are refused). The `text` is the FULL replacement body, not a delta.",
  "Comments live on the stories endpoint, not the task; use asana_get_task_comments to read recent comment threads on demand (default: last 5). Long comments truncate at 700 chars; the footer prints the story_gid to pass to asana_get_comment for the full body.",
  "Attachments (files uploaded to a task AND images pasted inline into comments) are listed with asana_list_attachments; download one with asana_download_attachment, then run the read tool on the returned path to view an image or parse a csv/xls.",
  "Write tools (asana_create_tasks, asana_update_tasks, asana_add_comment, asana_update_comment) prompt the user for review before posting to Asana when the `asana-confirm-write` flag is on (default). Call them directly: the extension shows the drafted payload for accept/edit/cancel. The agent does NOT need to ask the user itself.",
  "Custom fields: use asana_get_custom_fields to read a task's field schema (name, type, enum options, current value) and asana_set_custom_fields to write them by NAME (enum option names resolve to gids automatically; text/number coerced; null clears). set_custom_fields is review-gated like the other write tools.",
  "asana_add_comment: default to plain text. Only set html=true for @-mentions or inline formatting, and then the body MUST be a single <body>...</body> using ONLY these tags: body, strong/b, em/i, u, s, code, ol, ul, li, a, blockquote, pre. NO <br>, <p>, <div>, <span>, headers, or <hr> — Asana does not error on a bad tag; it silently stores the WHOLE comment as literal text (tags visible, HTTP 201). @-mention form: <a data-asana-gid=\"USER_GID\"></a> with a real user GID from asana_search_objects. The tool validates html_text and refuses payloads that would trigger the silent fallback.",
].join(" ");

function asana(pi: ExtensionAPI): void {
  // Register the flag for /settings visibility and CLI `--asana-confirm-write`
  // override ONLY. The gate itself reads file-backed module state
  // (lib/confirm.ts getConfirmWriteEnabled) because pi extension flags are
  // in-memory-only with no setFlag API and no persistence path. The default
  // mirrors the on-disk default so /settings shows a truthful value before
  // the user has ever toggled.
  pi.registerFlag(CONFIRM_WRITE_FLAG, {
    description: CONFIRM_WRITE_FLAG_DESCRIPTION,
    type: "boolean",
    default: true,
  });

  pi.registerTool(getMeTool);
  pi.registerTool(searchObjectsTool);
  pi.registerTool(getMyTasksTool);
  pi.registerTool(getTaskTool);
  pi.registerTool(getTaskDescriptionTool);
  pi.registerTool(getTasksTool);
  pi.registerTool(getProjectTool);
  pi.registerTool(getProjectsTool);
  pi.registerTool(statusOverviewTool);
  pi.registerTool(createTasksTool);
  pi.registerTool(updateTasksTool);
  pi.registerTool(getCustomFieldsTool);
  pi.registerTool(setCustomFieldsTool);
  pi.registerTool(addCommentTool);
  pi.registerTool(updateCommentTool);
  pi.registerTool(getTaskCommentsTool);
  pi.registerTool(getCommentTool);
  pi.registerTool(listAttachmentsTool);
  pi.registerTool(downloadAttachmentTool);

  pi.on("before_agent_start", async (event) => {
    return {
      systemPrompt: [event.systemPrompt, TOOL_GUIDANCE]
        .filter(Boolean)
        .join("\n\n"),
    };
  });

  // /asana <verb> [args] - prefix the editor with an explicit
  // instruction so the agent reaches for the right tool deterministically.
  //
  //   /asana me                       -> asana_get_me
  //   /asana my                       -> asana_get_my_tasks
  //   /asana my incomplete            -> asana_get_my_tasks (completed=incomplete)
  //   /asana show <gid>               -> asana_get_task
  //   /asana project <gid>            -> asana_get_project
  //   /asana search <workspace> <query>
  //                                  -> asana_search_objects
  //   /asana status <gids>            -> asana_get_status_overview
  //   /asana comments <gid> [N]       -> asana_get_task_comments
  //   /asana comment <gid>            -> asana_get_comment
  //   /asana attachments <gid>        -> asana_list_attachments
  //   /asana download <gid>           -> asana_download_attachment
  //   /asana create <text>            -> hint with asana_create_tasks
  //   /asana config                   -> settings modal (write review gate)
  //   /asana confirm on|off           -> toggle write review gate
  //
  // Bare /asana prints a usage reminder. Command handlers cannot directly
  // dispatch a tool call (pi.sendUserMessage is session-scoped), so we use
  // the same prefill-the-editor pattern as pi-deepwiki. The user hits Enter
  // to run; the agent picks the right tool from the prefill.
  pi.registerCommand("asana", {
    description:
      'Asana tools. Usage: /asana me | /asana my [incomplete|completed] | /asana show <gid> | /asana project <gid> | /asana search <workspace> <query> | /asana status <gid> [<gid>...] | /asana comments <gid> [N] | /asana comment <gid> | /asana attachments <gid> | /asana download <gid> | /asana create <free-form description> | /asana config | /asana confirm on|off.',
    handler: async (args, ctx) => {
      const trimmed = args.trim();
      if (!trimmed) {
        ctx.ui.notify(
          'Usage: /asana me | /asana my | /asana show <gid> | /asana project <gid> | /asana search <workspace> <query> | /asana status <gid>... | /asana comments <gid> [N] | /asana comment <gid> | /asana create <text> | /asana config | /asana confirm on|off',
          "info",
        );
        return;
      }

      const firstSpace = trimmed.indexOf(" ");
      const verb = (firstSpace === -1 ? trimmed : trimmed.slice(0, firstSpace)).toLowerCase();
      const rest = firstSpace === -1 ? "" : trimmed.slice(firstSpace + 1).trim();

      let prompt: string | null = null;

      switch (verb) {
        case "me":
          prompt = `Call the asana_get_me tool to identify the authenticated Asana user and list their workspaces.`;
          break;
        case "my":
        case "tasks":
          if (!rest) {
            prompt = `Call the asana_get_my_tasks tool to list every task currently assigned to the authenticated user.`;
          } else if (rest === "incomplete" || rest === "completed") {
            prompt = `Call the asana_get_my_tasks tool with completed="${rest}" to list ${rest} tasks assigned to the authenticated user.`;
          } else {
            prompt = `Call the asana_get_my_tasks tool with these arguments as appropriate: ${rest}. If a filter is needed, set completed to "incomplete" by default.`;
          }
          break;
        case "show":
          if (!/^\d+$/.test(rest)) {
            ctx.ui.notify(
              'Usage: /asana show <task gid>\nExample: /asana show 1234567890123456',
              "warning",
            );
            return;
          }
          prompt = `Call the asana_get_task tool with gid="${rest}" to retrieve full details for that task.`;
          break;
        case "project":
          if (!/^\d+$/.test(rest)) {
            ctx.ui.notify(
              'Usage: /asana project <project gid>\nExample: /asana project 1234567890123456',
              "warning",
            );
            return;
          }
          prompt = `Call the asana_get_project tool with gid="${rest}" and include_sections=true to retrieve the project and its section list.`;
          break;
        case "search": {
          // /asana search <workspace> <query>  (workspace is a GID; query can
          // contain spaces but not equal-signs).
          const firstSep = rest.indexOf(" ");
          if (firstSep === -1 || !/^\d+$/.test(rest.slice(0, firstSep))) {
            ctx.ui.notify(
              "Usage: /asana search <workspace gid> <query>\nExample: /asana search 1234567890123456 'Wicket'",
              "warning",
            );
            return;
          }
          const workspace = rest.slice(0, firstSep);
          const query = rest.slice(firstSep + 1).trim();
          prompt = `Call the asana_search_objects tool with workspace="${workspace}" and query="${query}" (resource_type defaults to task; override to project / user / tag when relevant).`;
          break;
        }
        case "status": {
          const gids = rest.split(/\s+/).filter((s) => /^\d+$/.test(s));
          if (gids.length === 0) {
            ctx.ui.notify(
              "Usage: /asana status <project gid> [<project gid>...]\nExample: /asana status 1234567890123456 2345678901234567",
              "warning",
            );
            return;
          }
          prompt = `Call the asana_get_status_overview tool with project_gids=${JSON.stringify(gids)} to retrieve the latest status updates for those projects.`;
          break;
        }
        case "comments": {
          // /asana comments <gid> [limit]
          const parts = rest.split(/\s+/).filter(Boolean);
          const gid = parts[0] ?? "";
          const lim = parts[1];
          if (!/^\d+$/.test(gid)) {
            ctx.ui.notify(
              "Usage: /asana comments <task gid> [limit]\nExample: /asana comments 1234567890123456   or   /asana comments 1234567890123456 2",
              "warning",
            );
            return;
          }
          const limitNote = lim && /^\d+$/.test(lim) ? ` with limit=${lim}` : "";
          prompt = `Call the asana_get_task_comments tool with task_gid="${gid}"${limitNote} to fetch the most-recent comments on that task.`;
          break;
        }
        case "comment": {
          // /asana comment <story_gid>  -> full, untruncated single comment.
          // Recover the body asana_get_task_comments truncated.
          if (!/^\d+$/.test(rest)) {
            ctx.ui.notify(
              "Usage: /asana comment <story gid>\nExample: /asana comment 1234567890123456",
              "warning",
            );
            return;
          }
          prompt = `Call the asana_get_comment tool with story_gid="${rest}" to fetch the full, untruncated text of that comment.`;
          break;
        }
        case "attachments":
        case "files": {
          // /asana attachments <task_gid> -> list files + inline images on a task.
          if (!/^\d+$/.test(rest)) {
            ctx.ui.notify(
              "Usage: /asana attachments <task gid>\nExample: /asana attachments 1234567890123456",
              "warning",
            );
            return;
          }
          prompt = `Call the asana_list_attachments tool with task_gid="${rest}" to list every file and inline image attached to that task.`;
          break;
        }
        case "download": {
          // /asana download <attachment_gid> -> fetch one attachment to disk.
          if (!/^\d+$/.test(rest)) {
            ctx.ui.notify(
              "Usage: /asana download <attachment gid>\nExample: /asana download 1234567890123456\n(Get the attachment gid from /asana attachments.)",
              "warning",
            );
            return;
          }
          prompt = `Call the asana_download_attachment tool with attachment_gid="${rest}" to download that attachment to a local file. For an image, run the read tool on the returned path to view it.`;
          break;
        }
        case "config": {
          // /asana config -> interactive settings modal (TUI) or status (else).
          // File-backed (lib/confirm.ts): stages flips in the SettingsList, then
          // persists genuine deltas via setConfirmWriteEnabled — applies live,
          // no reload needed (the next write-tool call reads module state).
          await openConfigModal(ctx);
          return;
        }
        case "confirm": {
          // /asana confirm on|off -> one-shot toggle of the write review gate.
          // File-backed (lib/confirm.ts setConfirmWriteEnabled): applies live,
          // no reload needed.
          const next = rest.toLowerCase();
          if (next !== "on" && next !== "off") {
            ctx.ui.notify('Usage: /asana confirm on|off', "warning");
            return;
          }
          const value = next === "on";
          if (setConfirmWriteEnabled(value)) {
            ctx.ui.notify(`${CONFIRM_WRITE_FLAG}: ${next}.`, "info");
          } else {
            ctx.ui.notify(`Failed to persist ${CONFIRM_WRITE_FLAG} (disk write failed).`, "error");
          }
          return;
        }
        case "create":
          prompt = `Help me create an Asana task. Read the user's request carefully, resolve any project / assignee names to GIDs via asana_search_objects first, then call asana_create_tasks with the resolved fields. Request: ${rest}`;
          break;
        default:
          prompt = `The user typed "/asana ${trimmed}" with an unknown verb. Show the available verbs (me, my, show, project, search, status, comments, comment, attachments, download, create, config, confirm) and ask what they want.`;
          break;
      }

      if (prompt) ctx.ui.setEditorText(prompt);
    },
  });
}

// Settings modal for /asana config. Single flag today, but the SettingsList
// path scales if more flags are added later. Non-TUI callers get a status
// notify instead (custom components are terminal-only).
async function openConfigModal(
  ctx: ExtensionCommandContext,
): Promise<void> {
  // Reads the live file-backed value, not pi.getFlag (which is in-memory only).
  const currentOn = getConfirmWriteEnabled();

  if (ctx.mode !== "tui") {
    ctx.ui.notify(
      `Asana write review: ${currentOn ? "on" : "off"}.\nToggle: /asana confirm on|off`,
      "info",
    );
    return;
  }

  const items: SettingItem[] = [
    {
      id: CONFIRM_WRITE_FLAG,
      label: "Confirm before posting writes",
      description: CONFIRM_WRITE_FLAG_DESCRIPTION,
      currentValue: currentOn ? "on" : "off",
      values: ["on", "off"],
    },
  ];

  const pending = new Map<string, boolean>();

  await ctx.ui.custom((tui, theme, _kb, done) => {
    const container = new Container();
    container.addChild(
      new Text(theme.fg("accent", theme.bold("Asana extension settings")), 1, 1),
    );
    const settingsList = new SettingsList(
      items,
      Math.min(items.length + 2, 15),
      getSettingsListTheme(),
      (_id: string, newValue: string) => {
        pending.set(CONFIRM_WRITE_FLAG, newValue === "on");
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

  // Drop net-zero flips, persist genuine deltas. File-backed setter applies
  // live; no reload needed (the next write-tool call reads module state).
  const target = pending.get(CONFIRM_WRITE_FLAG);
  if (target === undefined || target === currentOn) return;
  if (setConfirmWriteEnabled(target)) {
    ctx.ui.notify(`${CONFIRM_WRITE_FLAG}: ${currentOn} → ${target ? "on" : "off"}.`, "info");
  } else {
    ctx.ui.notify(`Failed to persist ${CONFIRM_WRITE_FLAG} (disk write failed).`, "error");
  }
}

export default asana;
