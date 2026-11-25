# Approval gate (agy native tools)

agy is not a plain model: it runs its own agent loop with its own native tools (`run_command`, `create_file`, `edit_file`, ...). Those calls execute inside agy with no pi involvement, so pi's permission extensions never saw them. The approval gate closes that gap: agy native tool calls pass through a pi-side approval in a form the existing permission-extension ecosystem gates with zero changes.

Mechanics: the extension stages an `.agents/hooks.json` group into its session-private bridge dir (the per-pid directory that is passed to this session's agy as an extra `--add-dir`); the Antigravity server/CLI discovers hooks in its add-dir directories and fires a `PreToolUse` hook before each mutating native tool runs. Because only this session's agy receives the directory, standalone IDE or CLI sessions in the same workspace never load the gate: their tool calls cannot be denied while pi is idle, and cannot be parked into a live pi turn (issue #5 isolation). The hook script (generated, per-pid, mode 0600 because it embeds the bridge token) POSTs the call to the bridge and polls for a decision. The bridge parks it, the provider interrupts the pi-side view of the agy turn with a `toolUse` for a SHADOW tool named `bash`/`write`/`edit` (same schema as the real builtin plus internal `__agy*` marker fields), and pi's whole `tool_call` surface applies: any installed permission extension gates the call unchanged, and only if nothing blocks does the fallback policy run. The decision travels back to the hook and agy enforces it; on deny the reason text is what agy's model sees. Marker calls never execute locally (a ticket check denies forged ones); non-marker calls delegate to a factory twin of the real builtin, so normal pi bash/write/edit behavior is unchanged: the bash twin gets the session's `shellCommandPrefix` and `shellPath` settings, like pi's own bash. The gate stages even with `bridgeTools: "none"`: the MCP listener then starts for the gate alone and exposes no pi tools. If a required gate cannot be staged (for example, the listener fails to start), provider turns are refused until a restart stages it. Delegated `AskAntigravity` consults ride the same gate: a wanted gate adds the staged gate dir to the consult spawn, so when an antigravity turn is streaming the consult's mutating calls park into that turn's approval surface, and otherwise they are denied fail-closed with a reason aimed at delegated runs; an unstaged wanted gate refuses the tool up-front. Read-only agy tools stay ungated. Every decision lands in the daily log with tool names, source, and latency.

Upgrades from 1.6.x: that line staged the gate group into the shared workspace `.agents/hooks.json`, where standalone sessions loaded it. The extension now sweeps gate groups left in the workspace file by sessions whose pid is dead at every session start; groups of live sessions and foreign groups are never touched.

Configuration (`/agy` config keys or environment):

```jsonc
{
  "approvals": {
    "gateMode": "auto",  // auto | shadow | dedicated | off
    "mode": "ask"        // ask | allow | deny  (fallback when no extension gates)
  }
}
// env: AGY_APPROVALS=shadow AGY_APPROVALS_MODE=ask
```

`auto` (default) keeps the gate OFF until one of the known pi permission packages is detected (pi settings `packages` name-match or known config markers). `shadow` forces it on; `off` forces it off. `dedicated` currently stages the same shadow tools (the explicit `antigravity_approve` variant is planned; the config value is accepted today so the schema is stable). The fallback `mode` is consulted only when no extension blocked the call: `ask` shows a pi confirm dialog (headless runs deny, fail-closed), `allow` approves, `deny` blocks. Timeouts deny fail-closed: the staged hook timeout always exceeds the park budget, but a hook that outlives its timeout soft-passes upstream (verified against the ACP server), so the park always answers first.

If you write your own gate extension, it sees a normal pi tool call:

```typescript
export default function (pi) {
	pi.on("tool_call", async (event) => {
		if (event.input?.__agyGate && event.input.command?.startsWith("rm ")) {
			return { block: true, reason: "rm is not allowed through the agy gate" };
		}
	});
}
```

ACP turns get the same gate through the staged home: the connection merges
this session's gate group into `<stagedHome>/config/hooks.json` at spawn,
next to the staged MCP config (`mergeGateGroupIntoAcpHome`; foreign groups -
the user's global hooks - are preserved). Probed live on agy 1.5.12 with a
workspace positive control: the server honors PreToolUse hooks from the
staged home's config/ (the probe validates the group shape end to end -
PreToolUse, matcher, command - via `scripts/probe-acp-hooks.mjs`; issue
#18). Delivery is verified on agy 1.5.12 only; the wiring warns when an
older agy serves a gated ACP session. The full park round trip on a live
ACP turn is still pending; see docs/TODO.md sections 1 and 3.
