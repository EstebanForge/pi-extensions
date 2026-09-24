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
