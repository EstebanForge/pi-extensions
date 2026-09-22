# @estebanforge/pi-zendesk-me

Zendesk Support read tools for [pi](https://github.com/earendil-works/pi-coding-agent) that act on **your** Zendesk tenant.

The extension adds 7 LLM-callable tools that query the Zendesk Support API v2 over HTTPS: fetch a ticket (by id or a pasted agent URL), read the full comment thread, search, look up users and organizations, download attachments (images included) to a temp file for viewing, and list the tickets in a saved view (filter). Read-only: no ticket can be created, edited, or commented on from here. No MCP server install required.

Authentication uses a **Zendesk OAuth confidential client** with the client-credentials grant. No API tokens: Zendesk is retiring them, and this extension starts on the path that survives.

## Tools

| Tool | Description |
|------|-------------|
| `zendesk_get_ticket` | Fetch one ticket with requester, assignee, and organization resolved via side-loading in a single call |
| `zendesk_get_comments` | Read the full comment thread; public replies and internal notes flagged, authors resolved |
| `zendesk_search` | Search with Zendesk search syntax (`status:open priority:urgent billing`); `type:ticket` prepended by default |
| `zendesk_get_user` | Look up a requester or assignee by id (name, email, role, notes) |
| `zendesk_get_organization` | Look up an organization by id (domains, details, notes) |
| `zendesk_download_attachment` | Save a ticket attachment to a temp file; view images with the native `read` tool |
| `zendesk_get_view` | List the tickets in a saved view (agent-UI filter, `/agent/filters/{id}` URLs work) |

Convenience details that save round-trips and mistakes:

- **Ticket URLs work as input.** `zendesk_get_ticket` and `zendesk_get_comments` accept `https://{subdomain}.zendesk.com/agent/tickets/7942` exactly as copied from the agent UI, or a bare `7942`.
- **Comment bodies arrive as stripped plain text.** Zendesk stores HTML; the tools strip tags before the text reaches the model, so nothing renders raw markup.
- **Ids ride along with names.** Output shows `Ada Lovelace <ada@example.com>` plus the underlying ids, so a follow-up `zendesk_get_user` never needs a re-fetch.
- **Images are viewable, not just listed.** `zendesk_get_comments` prints `attachment: #ID name (size)`; `zendesk_download_attachment` saves the bytes and the agent views the image with the native `read` tool. Zendesk content URLs are pre-signed: downloads follow the redirect with no auth header (an auth header breaks the storage signature).

## Setup

### 1. Create an OAuth client

In Zendesk Admin Center: **Apps and integrations** > **APIs** > **OAuth clients** > **Add OAuth client**.

Direct URL:

```text
https://{subdomain}.zendesk.com/admin/apps-integrations/apis/oauth-clients
```

| Setting | Value |
|---------|-------|
| Client kind | **Confidential** (required for client credentials) |
| Redirect URLs | Not needed for this flow; leave as is |
| Allowed scopes | `tickets:read users:read organizations:read ticket_views:read` |

Set **Allowed scopes** to exactly that read set. Allowed scopes are a ceiling: no token this client mints can exceed them, even if the client secret leaks. Blank means "anything", so do not leave it blank.

Save and copy the **Secret**. It is shown once.

### 2. Export the credentials

```bash
export ZENDESK_SUBDOMAIN="{subdomain}"          # your tenant: https://{subdomain}.zendesk.com
export ZENDESK_CLIENT_ID="..."
export ZENDESK_CLIENT_SECRET="..."
```

### 3. Install

```bash
pi install npm:@estebanforge/pi-zendesk-me
```

No browser approval step, no user account to pick. The client-credentials token acts as the OAuth client itself, scoped to the read set above.

## Commands

| Command | Description |
|---------|-------------|
| `/zendesk` | Show credential status and usage |
| `/zendesk ticket <id-or-url>` | Fetch a ticket (prefills `zendesk_get_ticket`) |
| `/zendesk comments <id-or-url>` | Read a thread (prefills `zendesk_get_comments`) |
| `/zendesk search <query>` | Search tickets (prefills `zendesk_search`) |
| `/zendesk view <id-or-url>` | List tickets in a saved view/filter (prefills `zendesk_get_view`) |
| `/zendesk user <id>` | Look up a user (prefills `zendesk_get_user`) |
| `/zendesk org <id>` | Look up an organization (prefills `zendesk_get_organization`) |

## Notes

- **Read-only by design.** The requested scopes contain no `write`, so the token cannot mutate tickets even by accident. Write tools would need a scope change plus new code; neither is planned.
- **Rate limits**: standard plans allow ~700 requests/min. The extension surfaces Zendesk's `429` `Retry-After` hint in the error text instead of retrying in a loop.
- **403 means scope**: with OAuth, `403 Forbidden` on a read almost always means the client's Allowed scopes were configured narrower than the read set (`tickets:read users:read organizations:read ticket_views:read`). Fix it in Admin Center, not in code.
- **Credential hygiene**: the client secret is a bearer credential for your whole Zendesk tenant. Keep it out of files pi commits; a dedicated read-scoped client keeps the blast radius to reading.
- **Visibility**: what the client can see is governed by the Zendesk account's permissions for OAuth clients; internal notes appear flagged as `INTERNAL NOTE` when returned.

## Development

```bash
npm install
npm run typecheck   # tsc --noEmit
npm test            # vitest run
npm run test:watch
```

## License

MIT
