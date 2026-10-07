# TODO

## 1. Approval gate: live end-to-end verification

The gate is wired and unit-pinned but has never run against a live
agy turn. Enable it, drive an agy turn that mutates a file, and watch the
round trip: PreToolUse hook -> POST /approval park -> shadow toolUse ->
decision -> hook stdout -> agy enforces.

- Enable without a third-party extension: `AGY_APPROVALS=shadow AGY_APPROVALS_MODE=ask` (interactive pi; headless denies). Deny path: a fake gate extension that blocks marker calls (`pi.on("tool_call")` + `{block: true, reason}`).
- Probe artifacts live outside the repo: `~/tmp/pi-antigravity-bridge-probes/` (run scripts via `npx tsx` from the repo cwd - they import src/*.ts).
- Live-behavior risks to watch: hook timeout soft-passes (V3) - the staged timeout must keep exceeding the park budget; denied calls emit no `tool_call` session/update frames on ACP (V2); edit-class arg names beyond `create_file` are docs-attested, never live-captured - check the confirm-dialog text on a real `run_command` and a real `replace_file_content`.
- On pass: clear the "NOT yet live-verified" notes (AGENTS.md, this file).

## 2. Explicit `antigravity_approve` variant (dedicated mode)

`approvals.gateMode: "dedicated"` currently stages the same shadow tools
(warn-logged remap). Planned: one registered tool `antigravity_approve` with
input `{toolName, args}`, for setups that prefer explicit names (gotgenes
`shellTools` alias users). Full v2 spec preserved in git history:
`dd7845b:docs/TODO.md` (sections 2.1-2.9).

## 3. ACP permission parking: live end-to-end verification

The park is wired and pinned against the fake ACP server but has never run
against a live agy server. Drive an ACP turn that triggers
`session/request_permission` (skipPermissions off), pick from the dialog,
and confirm the server resumes; then repeat the identical request and
confirm the always-memory answers without a second dialog.

- Probe setup lives outside the repo: `~/tmp/pi-antigravity-bridge-probes/` (run scripts via `npx tsx` from the repo cwd).
- Live-behavior risks to watch: how the real server handles a `cancelled`
  outcome (our deny when it offers no reject option), and whether the
  dialog park holds the turn open as long as the fake server does.
- On pass: note it here and clear the caveat in docs/APPROVAL-GATE.md.

## 4. agy `verbosity` setting: probe and adopt for both engines

agy's Settings screen exposes Verbosity (low / medium / high; docs key
`verbosity`): "Controls how much detail is shown for the agent's tool calls,
commands, and thoughts" - high shows every tool call, command, and thought in
full. Upstream changed the default from high to medium at some version (their
CHANGELOG: conversation view now groups related tool calls and thoughts into
concise summaries), so bridge turns likely receive SUMMARIZED thought/step
payloads on default installs. Screenshots: clip-20261007-0803/04/05
(settings, picker, high selected; local clip2zen dir, not in repo).

Worth probing because it touches several bridge surfaces on BOTH engines:

- stream-json: do `agent_thought` frames carry full text at high (today the
  driver's THINKING_TOKEN_FLOOR=64 implies text is often missing), and do
  tool steps arrive per-call instead of grouped? diff-render and the
  /agy tasks logs could get richer inputs.
- ACP: same question for `session/update` thought chunks and `tool_call
  content[]` (Gate C) - fuller diffs/paths/commands per frame.
- Mechanism: locate where the setting persists (agy settings.json? which
  path?), whether it is readable programmatically, and whether a non-TUI
  override exists (flag or settings key we can set per session without
  touching the user's interactive choice).
- Decision after the probe: a bridge config knob (passthrough or a
  documented "set agy Verbosity to high" note), or leave as-is if medium
  frames already carry everything the bridge consumes (verify, do not
  assume: compare one real turn's frames at low vs medium vs high).

## 5. readOnly with real enforcement (blocked on upstream / gate verification)

`readOnly` shipped fail-closed (2026-10-07): provider turns under it are
refused, because NO agy primitive enforces review-only on provider turns
(probe-proven: plan is a no-op with --disable-slash-commands and still writes
without it; --agent toolsets are ignored on stream-json; file writes bypass
permissions). Upstream report filed with the probe artifacts.

Enforcement paths to re-evaluate:

- Upstream fix (preferred): a real stream-json review-only gate, or honored
  --agent toolsets, or permission coverage for file writes. Re-test the four
  probes in ~/tmp/pi-antigravity-bridge-probes/ro-*.mts after any upstream
  release; if writes get gated, readOnly flips from refusal to plan-forcing.
- Approval-gate enforcement (our side): force `approvals` on under readOnly
  with a deny policy for mutating native tools. The hook staging exists and
  the hook firing is live-verified (2026-09-22), but the full
  park -> shadow toolUse -> decision round-trip is NOT yet live-verified
  (TODO 1). Do not build on it before that round-trip is proven; a deny-only
  hook script is a small variant of the staged gate.

Update 2026-10-07 (post-upstream-report): the report is filed as
google-antigravity/antigravity-cli#1181 (headless angle on #295). The probe
round also disproved two earlier beliefs, now corrected in README and the
refusal texts: (1) the -p path does NOT gate plan writes either (an earlier
"gated" observation was the command auto-deny, not plan mode); (2) an --agent
file outside the discovery root silently no-ops (agy accepts unknown agent
names), so the 2026-09-28 restricted-toolset claim needs a re-probe on 1.3.x
at the real discovery root before being relied on. Enforcement paths above
are unchanged, but AskAntigravity's plan mode must no longer be described as
"enforcing": only its staged restricted agent adds a toolset-level damper.

6. Parked-turn stranding on mid-turn config flip (peer-review caveat, 2026-10-07): turning readOnly or mode=plan on while a bridge tool call is parked mid-agy-turn makes the CONTINUATION turn refuse; the live agy turn is never resolved or aborted and waits out turnTimeoutMin. Consider aborting parked turns when the refusal fires.
