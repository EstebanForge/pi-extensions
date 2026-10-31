# pi-agents-shared

Plain library, no Pi entrypoint: consumers depend on it and Pi installs it transitively. Do not install it as a Pi extension.

Child-process lifecycle shared by @estebanforge agent packages. The first consumer is [pi-egm](../pi-egm), which runs Goldfish reviewers as fresh headless child sessions.

## What it owns

`runProcess(opts)` spawns a child detached (own process group), enforces a hard timeout and abort signals against the whole tree, and settles on stream `close`, never on process `exit`, so trailing buffered stdout is never truncated.

- **Line mode** (`onLine`): newline-delimited output for JSONL peers; a trailing partial line flushes at close; raw stdout is not retained.
- **Raw mode** (default): stdout accumulates into `stdoutRaw`; `onChunk` streams bytes live for status tails.
- **stdin transport**: pass large payloads via `stdin`, never argv (E2BIG). Absent `stdin` switches the pipe to `ignore`, which keeps `pi -p` children from hanging on an open stdin.
- **Kill semantics**: `killTree` (handed over via `onSpawn`) sends SIGTERM to the process group, escalating to SIGKILL after a grace period.
- **Caps**: stderr accumulation and pathological single-line buffers are capped, keeping the tail.

Zero domain knowledge: no prompts, no model families, no session semantics. Callers map tasks to argv and own all output parsing.

## Provenance

`runProcess` originated in `@estebanforge/pi-ask-shared`'s peer-process lifecycle. It is vendored here rather than imported so that pi-ask-shared stays frozen while this package evolves with the agent packages. Both are MIT.
