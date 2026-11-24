# Handoff sync mode for pi-antigravity-bridge (canonical history)

Status: rev 2, post peer review (Codex + Claude, both NO-GO on rev 1; every blocker verified against the tree and resolved here).

## Problem

Our digest handoff truncates. Real-session replay showed 84.6% of fresh-conversation handoff builds truncate at the 24k ACP cap, and 59% of handoff windows exceed 120k chars. Canonical history sync replaces the digest on ACP: rolling sha256 prefix checkpoints, continue-vs-rebuild plans, and lossless history delivery. The user chose it as an opt-in mode; digest stays default.

## Mode semantics

New config field `handoff: "digest" | "sync"`, default `"digest"`. Env `AGY_HANDOFF` parses alongside the `AGY_DIGEST` env block in `config.ts`. Settings-picker row + `/agy handoff digest|sync` handler follow the existing `/agy digest` pattern. Semantics:

- `handoff: "sync"` + engine `acp`: the fresh-pass digest build is replaced by the sync plan machinery. Digest settle writes (park-time `store.set` at provider.ts ~:2093 and the settle site at ~:2226) and the binding-diff `store.delete` (~:2219) are bypassed on sync turns; sync owns the settle contract (see "Settle placement").
- `handoff: "sync"` + engine `stream-json`: sync is ACP-only. Stream-json keeps the digest path unchanged, and the stream-json driver gains no outcome fields (nothing consumes them there).
- `handoff: "digest"`: today's behavior byte-for-byte. Sync code is unreachable without the flag; the driver callbacks are optional and digest mode passes none.
- Mode switch: governed by the persist contract (below) so either direction self-heals in one turn. The active mode for a parked turn is latched at park time (same mechanism as the engine latch in `runtime.ts`), so `/agy handoff` flips mid-park cannot mix contracts.

## Current-input boundary (resolves Codex B1/B3, Claude B2, Q1/Q3)

A provenance hook (delivered-user object identity, `currentUserSourceIndex`) is deferred to v2. v1 derives the boundary from request context plus prior boundaries, with this exact chain:

1. Run detection: the trailing user run per the adjacent-user merge, then truncated at any `isBacklogUserShape` member (compaction summaries, branch summaries, bash-run notes — provider.ts ~:118; a run member matching one truncates the run to the messages after it). Backlog shapes are history, never current input.
2. Candidate prior boundary, first match wins: `inFlight.target.entryCount` if `matchesCheckpoint(projection, inFlight.target)` — kept through `invalidate()` ("cancellation cannot erase an earlier user"); else `checkpoint.entryCount` if the checkpoint matches; else 0.
3. `currentStart = max(runStart, priorBoundary)`, with the retry guard: the clamp applies ONLY when `priorBoundary < entryCount`. On an identical retry after a failed turn, `inFlight.target` covers the whole transcript (`entryCount == end`); without the guard the clamp yields an empty current input and the provider errors "No user message to send to agy" (provider.ts ~:1829), stalling pi's retry. With the guard, the retry re-sends the trailing user run as current input — re-execution of a never-confirmed turn is correct, not a duplicate.
4. History slice: `resume → []`; `rebuild → entries[0..currentStart)`; `continue → entries[checkpoint.entryCount..currentStart)`.

Index spaces: run detection and watermarks work on message indices; checkpoints and prior boundaries work on entry indices (system messages excluded). Every conversion goes through the projection entry's `sourceIndex` field; no raw cross-use of indices.

Known residual over-ship (accepted, logged): after compaction or a branch, both prior candidates fail (0) and the run merge may re-ship an already-delivered input as current once. Provenance (v2) would prevent even this; our B7 telemetry gate makes it visible.

## Settle placement (resolves Claude B1/B4/B5)

Sync mode introduces its own settle contract inside `runTurnDriver`; the digest settle block is not reused. Ordering:

- Ephemeral/isolated turns (`cacheRetention none`, `disableContinuation`) and the legacy resume paths (late redelivery, strand redelivery, retry-dropped resume, `compactionResume`) never touch sync state: they run the legacy flow and, when they touch a bound session, call `sync.fail(named-reason)` so the next turn plans rebuild. These paths are enumerated in the plan tests.
- Continuation with a plan that is not `resume`: close the driver, `roundTrips.failAll`, `sync.fail("changed-live-history")`, then re-prepare the plan as a non-continuation. Without this the provider would re-attach to the live handle, never call `onSessionBound`, and `finish()` would checkpoint a transcript whose steering input never reached agy — permanent input loss. The parked turn's mode latch (above) closes the mid-park `/agy handoff` flip variant of the same hole.
- `sync.finish(outcome, assistant)` runs where digest settles run, but writes only sync state: park-time persist keeps `rotationGuardArmed()` semantics (no set over a rotation), the settle persist is skipped when a rotation is armed or a rotation latch is pending, and the sync path CLEARS the `pendingCompactionHandoff` latch it consumed (digest mode re-ships the summary once otherwise).
- A binding-diff outcome under sync (agy changed its session) maps to `invalidate("unexpected-session-change")` + rebuild input via the load-failure path; the digest `store.delete`-on-mismatch rule does not run.

## Persist contract (resolves Codex B2, Claude B6)

Sync persist writes `{conversationId, lastStepIdx: -1, lastMessageCount: 0, sync: snapshot}` — no `digestBoundary`, no `digestSummaryId`, and a ZEROED watermark. Rationale: after any sync era, digest mode must re-offer the full backlog once (bounded by the digest cap) rather than trust a watermark it cannot validate. A full-length watermark with a stale fingerprint would reset to 0 anyway and then permanently skip older-than-window messages; count 0 with absent boundary is `boundaryTrusted`-true and safe. Consequence accepted: every sync→digest flip re-offers history once.

Skip rules: persist is skipped when there is no conversation id at all (unbound), for isolated turns, and when a rotation is armed. A rebuild into a fresh conversation while an OLD record exists (abort, changed-prefix, unconfirmed-turn) DOES persist — it inherits the new binding; the zeroed digest watermark is what makes that safe.

Store plumbing: `SessionStore.get()` copies fields one-by-one and would silently drop `sync` (every turn would then plan `missing-checkpoint`); `get()` and the persist merge's `narrowStoreMap` must carry `sync` through `narrowSessionSync` validation. A record with `sync` but no watermark fields must narrow cleanly.

## Gate and fallback interplay (resolves Claude B3)

`gateOpen = config.systemPrompt && !existing?.conversationId` keys on record existence. Sync rebuilds force fresh conversations while the record survives, so sync mode keys the gate on the sync plan's `conversationId == null` instead. The digest fix-3 `acpFallback` build is skipped in sync mode: `onSessionLoadFailed` returns the complete rebuild input (full serialized history), which subsumes the fallback. Digest mode keeps both behaviors unchanged.

## Churn gate (resolves Claude B7)

Per-call context-hook rewrites change the projection between calls; prefix chains then never match and every turn becomes a rebuild into a fresh conversation. v1 gate: a `sync-plan` telemetry event (info, AGY_DEBUG-visible) fires every turn with the plan kind and reason; after 3 consecutive rebuild-causing turns on one session, a warn event fires and the session falls back to digest behavior for its lifetime (recorded in the sync state, not config). This bounds the blast radius of hook ecosystems without importing overlay machinery.

## What we port (v1)

### history-projection.ts — port near-verbatim (pure, no deps)

Semantic entries: system messages excluded; adjacent text merged; images hashed by sha256 over the DECODED bytes (`update(data, "base64")`, not the base64 text); toolCall args key-sorted via `stable()`; assistant `aborted`/`error` become `status`; toolResult keeps `toolCallId/toolName/isError`; thinking/usage/UI metadata never enter. Entry id `"m" + ordinal + "-" + hash.slice(0,16)` (position-sensitive) plus `sourceIndex` for the boundary conversions. Rolling chain `prefixes[n] = sha256(prefixes[n-1] + ":" + entry.hash)`. `EMPTY_HISTORY_HASH = sha256("pi-history-v1")`. Exports: `projectHistory`, `historyCheckpoint`, `matchesCheckpoint`, `historyInput`, `serializeHistory` (3 fixed framing lines + JSONL per entry, undefined when empty), `HistoryCheckpoint {entryCount, hash, entryId?}`.

### session-sync.ts — plan builder + coordinator (pure), minus overlay concepts

`SessionSyncState {version: 1, epoch, checkpoint?, expectedAssistantHash?, inFlight?: {turnId, base?, target, submission: "prepared"|"dispatching", expectedAssistantHash?}, invalidReason?, digestFallback?: boolean}`. No `profileHash`, no `retireAfterTurn` in v1. `narrowSessionSync` field-by-field, malformed to `invalidReason: "invalid-sync-state"`, never throws.

Plan decision order (port verbatim): `invalidReason` → rebuild; continuation + `inFlight` → absorb-fail `changed-inflight-prefix` / new user `new-user-during-turn` / else `resume`; `inFlight` without continuation → `unsettled-submission`; `!checkpoint` → `changed-prefix` | `missing-checkpoint`; else `continue`. Rebuild bumps `epoch`; every invalidation carries its named reason.

Coordinator FSM `idle → syncing → running → idle` with `draining` from syncing/running: `prepare`, `bound` (resume requires same turnId; rebuild bumps epoch), `dispatching`, `park` (target + expectedAssistantHash, submission stays prepared), `terminal` (checkpoint = full projection; sets expectedAssistantHash for the NEXT turn's reconcile), `invalidate(reason)` (keeps `inFlight` — the input boundary must survive invalidation). Two-step settle: a checkpoint absorbs an assistant only when the next projection's hash matches `expectedAssistantHash`.

### acp/history-sync.ts — per-turn orchestrator, minus overlay/recall/profile

Constructor `(store, key, messages, existing, {continuation, isolated?, modeLatch})`; projects (message→entry conversion via `sourceIndex`), loads coordinator from `existing?.sync`, prepares the plan. `conversationId` null while an unbound rebuild is pending. `inputFor` builds `{prompt, images?, contextBlock?}`: history images ride natively deduped by `mimeType:data`; contextBlock `{uri: "urn:pi-bridge:history:v1", text: serializeHistory(history)}`.

Frame guard: `Buffer.byteLength(JSON.stringify(input)) + 2048` margin against our `MAX_FRAME_BYTES` (32 MiB). Correction from review: an older `* 64` per-image estimate is envelope margin, not an undercount — `JSON.stringify` already contains the image base64 because images ride in `input.images`. Do NOT add image lengths on top (double-count). `MAX_FRAME_BYTES` is proven as an INBOUND line-buffer cap only; before shipping, probe outbound acceptance at 1 MiB / 4 MiB / 16 MiB on live agy (stream-json silently dropped prompts above 25 KB once). Hard fail, no truncation, message tells the user to compact.

Driver hooks: `onSessionBound` placed before `#applyTurnConfig` (~:359), binding persists before model config/prompt; changed id → `unexpected-session-change`. `onBeforePrompt` after the config step, before the prompt call — write-ahead `dispatching`. `onSessionLoadFailed` BEFORE `conn.newSession` (our fix-3 swap sits after `newSession` at acp/driver.ts ~:346-353, which orphans a session if the callback throws) — invalidate, re-prepare, unbind, return the complete rebuild input for the fresh conversation.

`park` on an unbound turn still binds (keeps the interrupted input boundary). `finish(outcome, assistant)` order: unbound + outcome id → adopt binding (coordinator not syncing → `invalidate("unconfirmed-binding")` then bound); bound + id mismatch → `unexpected-session-change`; then `aborted` FIRST (abort resolves the prompt, so `sawResult` is true — terminal must not win); OK + `!aborted` + `promptTerminal` → `terminal()`; `promptAttempted && !promptTerminal` → `delivery-unknown`; else `unconfirmed-turn`.

### Driver surface (acp/driver.ts, driver-types.ts)

Three optional lifecycle callbacks (placements above) and two outcome fields. Provenance: populate once in `#settle` with `outcome.promptAttempted ??= turn.promptStarted; outcome.promptTerminal ??= turn.sawResult` — covers `#failTurn`, connection-exit, and abort paths; parked turns never settle at park time so there is no early false terminal. `promptStarted` (:382) is set just before the `conn.prompt` call, not at the transport-write boundary — v1 documents the weaker meaning ("driver invoked the call"); the error direction is safe over-invalidation (`delivery-unknown` → rebuild), never false confirmation. A real write-boundary signal is v2.

Silent-drop trap: ACP leaves `modelOutputSeen` undefined, so the provider's silentDrop check does not fire; a prompt agy accepts but ignores would checkpoint as `terminal`. Mitigation: treat `promptTerminal` + empty response + no tool activity + shipped history as `delivery-unknown`.

### Store schema

`AgySession` gains optional `sync?: SessionSyncState`; `narrowStoreMap`, `get()`, and the persist merge carry it through `narrowSessionSync`. Compaction keeps `rotateSessionOnCompaction` (record delete → next turn `missing-checkpoint` rebuild), with the rotation guard and latch-clear rules from "Settle placement". Summary-as-history after rotation is correct: the rebuild's history includes the summary entry, framed as reference data.

## v1 simplifications (deliberate, each with its guard)

1. No overlay/recall machinery (`pi-history.ts`, `turnRecall`, `retireAfterTurn`, `currentUserSourceIndex`): compaction rebuilds (rare); boundary chain + backlog-shape truncation + retry guard replace provenance for the known shapes; residual over-ship logged; churn gate bounds hook-ecosystem damage.
2. No profile hash: warm continuation across cwd/agent changes is the explicit v1 policy.
3. Sync opt-in, stream-json untouched, digest default unchanged.

## Test plan (test-first throughout)

Unit (pure): projection hashes (text merge, decoded-byte image sha, stable args, aborted/error status, prefix chain, position-sensitive ids, sourceIndex mapping); plan builder — every rebuild reason in order, resume, continue, boundary chain cases including: backlog shape inside the run, identical-retry clamp guard (`priorBoundary == end` → no clamp), interrupted clamp via kept `inFlight.target`, branch/compaction fallback to 0; coordinator FSM (all transitions, two-step settle absorb, epoch bumps, invalidate keeps inFlight); `narrowSessionSync` malformed variants; serializeHistory framing + empty case; `inputFor` dedup + byte guard (huge payload trips; images already inside stringify — no double count).

Store: `get()`/`narrowStoreMap`/persist merge carry `sync`; digest record + sync record narrowing both ways; zeroed-watermark persist shape.

Provider-level (fake driver harness): unbound rebuild ships full history contextBlock + system prompt (gate keyed on plan, not record); bound continue ships delta-only; changed prefix rebuilds with reason; parked continuation with new user input fails round trips and re-prepares (`changed-live-history`); identical retry after failure re-sends the trailing run (no "No user message"); cancel/abort → `interrupted`, next turn rebuild; compaction rotation mid-park does not resurrect the binding; latch cleared; legacy resume paths invalidate with named reasons; isolated turns skip persist; mode flip digest→sync→digest re-offers backlog once (zeroed watermark); churn gate falls back to digest after 3 rebuild turns; digest mode regression (no callbacks = today's behavior).

Driver-level (`fake-acp-server.mjs`): `onSessionLoadFailed` before `newSession` returns the rebuild input; `onBeforePrompt` ordering; outcome fields populated in `#settle` across error/abort/exit paths; abort-before-terminal ordering.

Live: extend `scripts/smoke-handoff.mjs` with a sync-mode scenario (needle across first-turn rebuild, model switch warm continuation, cancel/recovery via rebuild), plus the 1/4/16 MiB outbound frame probe as a separate gated script before ship.

## Risks

- Two coexisting handoff contracts on one record: the persist contract makes both directions fail safe (digest re-offers; sync rebuilds); settle bypass is branch-isolated.
- Echo protocol subtlety: outcome provenance pinned by driver tests; abort-first ordering explicit.
- Hook ecosystems may churn rebuilds: churn gate caps it per session.
- Outbound frame acceptance above 32 MiB unproven: gated probe before ship; hard-fail message tells the user to compact.

## Non-goals (v1)

Overlay/compaction-avoidance, recall hook integration, profile invalidation, provenance via pi events, stream-json sync, transport-write-level attempt signal, making sync the default.
