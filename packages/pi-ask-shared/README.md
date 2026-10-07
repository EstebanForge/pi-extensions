# @estebanforge/pi-ask-shared

Shared runtime for the `@estebanforge` ask extensions (`pi-ask-claude`, `pi-ask-codex`, `pi-ask-antigravity`). Plain library, no Pi entrypoint: each ask package lists it in `dependencies`, and Pi installs it transitively when a package is installed standalone.

## What it provides

- `BackgroundRunRegistry`: per-tool registry of background runs. RunId generation, concurrency cap, settle-exactly-once latch, TTL sweep for settled runs, dispose latch for session shutdown.
- `createWakeSender` / `buildWakeContent`: pushes a finished run back into the conversation via `ExtensionAPI.sendMessage` with `triggerTurn: true` and `deliverAs: "followUp"`. Guards a stale host with a latch plus catch-all, wraps peer output in an UNTRUSTED banner, optional redaction hook.
- `createStopHandler`: pure logic for the `/<tool>-stop` command (unique-prefix match, ambiguity listing, settle on stop).
- `backgroundFlagText`: the model-facing description for the `background` flag. Byte-identical across tools except the resume-handle name.

## Design constraints

- Each tool owns its own registry instance. Pi loads packages with separate module roots, so nothing here may rely on cross-package shared state.
- The registry is process state only. Process handles stay with the owning tool; it passes a `kill` callback to the stop handler.
- Running runs are never swept by TTL: the tool's own timeout owns the running lifecycle.
