# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [1.0.0] - 2026-08-28

### Added

- `zendesk_get_ticket`: fetch one ticket by numeric id or a full `/agent/tickets/N` URL, with requester, assignee, and organization resolved via side-loading.
- `zendesk_get_comments`: read the full comment thread (public replies and internal notes flagged), authors resolved via side-loading.
- `zendesk_search`: search tickets with the Zendesk search API; `type:ticket` prepended unless the query already targets other types.
- `zendesk_get_user` / `zendesk_get_organization`: look up a requester, assignee, or organization by id.
- `zendesk_download_attachment`: save a ticket attachment to an OS temp file for viewing; images render through the native pi `read` tool. Attachment content URLs are pre-signed and downloaded without an auth header.
- `zendesk_get_view`: list the tickets in a saved view (filter) by id or `/agent/filters/{id}` URL, with requester and assignee resolved. Requires the `ticket_views:read` scope.
- OAuth client-credentials auth (`ZENDESK_SUBDOMAIN`, `ZENDESK_CLIENT_ID`, `ZENDESK_CLIENT_SECRET`) with in-memory token caching; ready ahead of Zendesk's API-token deprecation (all API tokens stop working 2027-04-30). Requested scopes: `tickets:read users:read organizations:read ticket_views:read`.
- `/zendesk` command: bare status plus `ticket`, `comments`, `search`, `view`, `user`, and `org` prefills.
- Tool guidance injected into the system prompt: URL parsing, HTML-escaping rule for comment bodies, attachment download flow, scope hints, rate-limit notes.
