/**
 * pi-zendesk-me - Zendesk Support read tools for pi.
 *
 * Adds 7 LLM-callable tools that query the Zendesk Support API v2 using an
 * OAuth confidential client (client-credentials grant). Read-only: fetch a
 * ticket (by id or pasted agent URL), read the comment thread, search, look
 * up users and organizations, download attachments to a temp file for
 * viewing, and list the tickets in a saved view (agent-UI filter). No API
 * tokens - Zendesk retires those on 2027-04-30 - and no MCP server install.
 *
 * Based on: Zendesk Support API v2
 *           https://developer.zendesk.com/api-reference/ticketing/introduction/
 *           OAuth migration: https://developer.zendesk.com/documentation/authentication/oauth-migration/
 */
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { getTicketTool } from "../lib/tools/get-ticket";
import { getCommentsTool } from "../lib/tools/get-comments";
import { searchTool } from "../lib/tools/search";
import { getUserTool } from "../lib/tools/get-user";
import { getOrganizationTool } from "../lib/tools/get-organization";
import { downloadAttachmentTool } from "../lib/tools/download-attachment";
import { getViewTool } from "../lib/tools/get-view";
import { hasZendeskCredentials } from "../lib/auth";

// Compact tool guidance appended to the system prompt. Intentionally small:
// the tool descriptions carry the detail; this tells the agent what the
// extension is for, the URL shortcut, and the two gotchas (HTML bodies,
// read-only scope).
const TOOL_GUIDANCE = [
  "These Zendesk tools are read-only and act on the tenant configured via ZENDESK_SUBDOMAIN.",
  "zendesk_get_ticket and zendesk_get_comments accept a raw ticket id or a pasted agent URL like https://{subdomain}.zendesk.com/agent/tickets/7942 - pass the URL as-is.",
  "Ticket descriptions and comment bodies come back as stripped plain text; the underlying Zendesk fields are HTML, so never paste raw HTML at the user.",
  "To view attachments (images, PDFs): zendesk_get_comments lists them as 'attachment: #ID name'; call zendesk_download_attachment with that #ID, then use the native `read` tool on the returned path to view the image.",
  "Saved ticket lists (filters in the agent UI, URLs like https://{subdomain}.zendesk.com/agent/filters/20824934716439) are readable with zendesk_get_view - pass the URL as-is.",
  "Authentication uses Zendesk OAuth client credentials (ZENDESK_SUBDOMAIN, ZENDESK_CLIENT_ID, ZENDESK_CLIENT_SECRET); tokens are fetched and cached internally. API tokens are deprecated by Zendesk - never ask the user for one.",
  "A 403 error means the OAuth client's Allowed scopes are narrower than the read scope set; a 429 includes a retry hint. Do not retry in a tight loop.",
].join(" ");

function zendeskMe(pi: ExtensionAPI): void {
  pi.registerTool(getTicketTool);
  pi.registerTool(getCommentsTool);
  pi.registerTool(searchTool);
  pi.registerTool(getUserTool);
  pi.registerTool(getOrganizationTool);
  pi.registerTool(downloadAttachmentTool);
  pi.registerTool(getViewTool);

  pi.on("before_agent_start", async (event) => {
    return {
      systemPrompt: [event.systemPrompt, TOOL_GUIDANCE]
        .filter(Boolean)
        .join("\n\n"),
    };
  });

  // /zendesk <verb> - prefix the editor with an explicit instruction so the
  // agent reaches for the right tool deterministically. Same prefill pattern
  // as pi-slack and pi-asana.
  //
  //   /zendesk ticket <id-or-url>  -> zendesk_get_ticket
  //   /zendesk comments <id-or-url> -> zendesk_get_comments
  //   /zendesk search <query>       -> zendesk_search
  //   /zendesk user <id>            -> zendesk_get_user
  //   /zendesk org <id>             -> zendesk_get_organization
  //
  // Bare /zendesk prints credential status + usage.
  pi.registerCommand("zendesk", {
    description:
      "Zendesk read tools. Usage: /zendesk ticket <id-or-url> | /zendesk comments <id-or-url> | /zendesk search <query> | /zendesk view <id-or-url> | /zendesk user <id> | /zendesk org <id>.",
    handler: async (args, ctx) => {
      if (!hasZendeskCredentials()) {
        ctx.ui.notify(
          "Zendesk: ZENDESK_SUBDOMAIN, ZENDESK_CLIENT_ID, or ZENDESK_CLIENT_SECRET is not set. " +
            "Create a Confidential OAuth client (Admin Center > Apps and integrations > APIs > OAuth clients) " +
            "with Allowed scopes 'tickets:read users:read organizations:read', then export the three env vars " +
            "in the shell that runs pi. API tokens are not supported (Zendesk retires them 2027-04-30).",
          "warning",
        );
        return;
      }

      const trimmed = args.trim();
      if (!trimmed) {
        ctx.ui.notify(
          "Zendesk: authenticated for https://${process.env.ZENDESK_SUBDOMAIN?.trim()}.zendesk.com (read-only). " +
            "Usage: /zendesk ticket <id-or-url> | /zendesk comments <id-or-url> | /zendesk search <query> | /zendesk view <id-or-url> | /zendesk user <id> | /zendesk org <id>",
          "info",
        );
        return;
      }

      const firstSpace = trimmed.indexOf(" ");
      const verb = (
        firstSpace === -1 ? trimmed : trimmed.slice(0, firstSpace)
      ).toLowerCase();
      const rest = firstSpace === -1 ? "" : trimmed.slice(firstSpace + 1).trim();

      let prompt: string | null = null;

      switch (verb) {
        case "ticket":
        case "comments": {
          if (!rest) {
            ctx.ui.notify(
              `Usage: /zendesk ${verb} <id-or-url>\nExample: /zendesk ${verb} https://{subdomain}.zendesk.com/agent/tickets/7942`,
              "warning",
            );
            return;
          }
          const tool = verb === "ticket" ? "zendesk_get_ticket" : "zendesk_get_comments";
          prompt = `Call the ${tool} tool with ticket="${rest}" to read that Zendesk ticket${
            verb === "ticket" ? " with people resolved" : "'s full comment thread"
          }.`;
          break;
        }
        case "search":
        case "find":
          if (!rest) {
            ctx.ui.notify(
              'Usage: /zendesk search <query>\nExample: /zendesk search status:open priority:urgent billing',
              "warning",
            );
            return;
          }
          prompt = `Call the zendesk_search tool with query=${JSON.stringify(rest)} to search Zendesk tickets.`;
          break;
        case "view":
        case "filter": {
          if (!rest) {
            ctx.ui.notify(
              `Usage: /zendesk ${verb} <id-or-url>\nExample: /zendesk ${verb} https://{subdomain}.zendesk.com/agent/filters/20824934716439`,
              "warning",
            );
            return;
          }
          prompt = `Call the zendesk_get_view tool with view="${rest}" to list the tickets in that Zendesk saved view.`;
          break;
        }
        case "user": {
          if (!/^\d+$/.test(rest)) {
            ctx.ui.notify("Usage: /zendesk user <numeric-id>", "warning");
            return;
          }
          prompt = `Call the zendesk_get_user tool with user=${rest} to look up that Zendesk user.`;
          break;
        }
        case "org":
        case "organization": {
          if (!/^\d+$/.test(rest)) {
            ctx.ui.notify("Usage: /zendesk org <numeric-id>", "warning");
            return;
          }
          prompt = `Call the zendesk_get_organization tool with organization=${rest} to look up that Zendesk organization.`;
          break;
        }
        default:
          prompt = `The user typed "/zendesk ${trimmed}" with an unknown verb. Show the available verbs (ticket, comments, search, view, user, org) and ask what they want.`;
          break;
      }

      if (prompt) ctx.ui.setEditorText(prompt);
    },
  });
}

export default zendeskMe;
