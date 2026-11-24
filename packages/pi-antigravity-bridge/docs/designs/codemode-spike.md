# Codemode-over-MCP spike: findings and go/no-go

Status: spike complete 2026-11-24. Probe: `scripts/probe-codemode.mjs`
(AGY_ACP_LIVE=1, real billed turns on agy 1.5.16, 9/9 checks green).

## What the probe proved

1. Single-tool advertisement works. A bridge MCP catalog exposing exactly
   one `codemode` tool (`{code}`) is called by the engine, once per task,
   with a real script payload.
2. Nested calls never re-enter the engine's model context. The wire carried
   one tools/call while the sandbox executed `tools.add(2,3)` and
   `tools.echo(...)` host-side. This is the core codemode economics: N
   nested tool round-trips cost the model one tool call plus the script
   text.
3. The MCP registration survives session/load on a fresh engine process.
   Turn 2 ran on a new process with the conversation id re-attached
   (session/load re-sends `mcpServers`) and the script tool still worked.
4. Cost is negligible. Codemode turn: 16.2k total tokens (18.2k input incl.
   13.9k cache read, 182 output, ~11s) versus a plain baseline reply of
   15.8k total (30 output, ~2s). The single tool description adds ~2.5k
   input tokens over the baseline; the dominant cost is the system prompt
   both turns share. Output tokens rise modestly because the model writes
   JavaScript.

## Why the bridge needs no new dependency

The engine never runs scripts itself. Pi already ships a native `codemode`
tool (`@earendil-works/pi-codemode` sandbox, scripts call the agent loop's
own tools via `tools.*`). When the bridge advertises that tool over MCP and
the engine calls it, the call round-trips into pi like any bridge tool and
pi's codemode tool executes the script with pi's tools injected. The probe
simulated the pi side with its own sandbox to keep the transport
deterministic; the wiring on the pi side already exists.

What actually exists in the tree today:

- `extensions/index.ts` `listTools()` builds the MCP catalog live from pi's
  active tools; a session with the codemode tool active already advertises
  it to the engine.
- The STILL RUNNING early-ack plus `bridge_poll_result` already covers any
  bridge call past ~20s, so long scripts are handled by the generic path.
- `mcpServers` registration on both session/new and session/load carries
  the token header (verified by the probe's fresh-process leg).

## What adoption would require (opt-in follow-up, not started)

- A catalog mode that gates the bridge to codemode-only projection
  (codemode plus a preserved model-only set), reusing the existing live
  catalog rebuild. This is a product decision, like the bridge's other
  tool-exposure modes, not new plumbing.
- A description that teaches the ENGINE'S model the script grammar; the
  probe hand-wrote a compact one and the model wrote correct scripts at
  effort low on the first try.
- Consider caching declarations (`renderDeclarations`) if the exposed tool
  set grows large.

## Verdict

GO for a small opt-in follow-up after the current release ships (catalog
mode plus wording). No-go for bundling into the sync-port release: the
probe shows the mechanism is sound and cheap, but the catalog mode is a
user-facing product surface and deserves its own change, tests, and docs.
