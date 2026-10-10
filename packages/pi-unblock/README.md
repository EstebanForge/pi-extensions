# pi-unblock

Event-driven unblock gate for [Pi](https://pi.dev). No model-facing tool: the trigger is deterministic, so the session cannot talk itself out of it.

## What it does

**Failure-loop consults.** When the same tool fails `threshold` times in a row (shell failures keyed on the command root, so unrelated commands don't stack), the extension consults a peer reviewer through a one-shot headless run and injects the guidance as a visible `[SYSTEM NOTICE ...]` message delivered mid-run (steer). Stale answers (the conversation moved on) degrade to a plain notification. Failed consults still consume the streak reset and the cooldown — the gate never retry-storms a broken reviewer CLI. Publish and manual (`/unblock`) consults run outside that budget and cooldown.

**Publish boundary.** `git push` and `gh pr create` (including inside compound commands) pass a confirm dialog first. Declined commands are blocked without running. Accepted commands get a synchronous consult whose answer is injected before the command runs.

**Manual consult.** `/unblock [focus text]` consults the reviewer on demand with the recent transcript slice as material.

## Design boundaries

- Exploratory commands (`grep`, `rg`, `find`, `ls`, ...) never build a failure streak — their exit 1 on no-match is a normal result.
- One-turn decay: a streak that did not repeat across a turn boundary dies.
- Auto consults are capped per session (default 3); after the cap, only `/unblock` and the publish gate consult.
- Consults default to read-only postures per peer (claude read tools, codex read-only sandbox, agy plan mode with the skip flag off).
- Reviewer answers are ANSI-stripped before they can reach a transcript, and never enter the executor context on failure.
- Headless JSON/print modes degrade: the publish gate skips with a log line instead of blocking.

## Configuration

Project-scoped `.pi/unblock-settings.json`, every key optional:

```json
{
	"reviewer": "claude",
	"binary": null,
	"model": null,
	"threshold": 3,
	"cooldownSec": 120,
	"timeoutSec": 45,
	"maxAutoConsultsPerSession": 3,
	"preprompt": "",
	"contextMaxTurns": 4,
	"maxOutputCharsPerTurn": 4000,
	"autoUnblockOnFailure": true,
	"confirmOnPush": true,
	"ignoredCommands": []
}
```

`preprompt` is always sent ahead of the consult frame — use it as the standing adversarial instruction (e.g. "Attack the premise first").

## Install

```
pi install npm:@estebanforge/pi-unblock
```

## Known limitations

- Publish matcher residual gaps: quoted re-execution (`bash -c 'git push'`) and wrapper argument forms (`nice -n 5 git push`) bypass the gate. Plain `git push`, flags (`git -C repo push`), wrappers (`sudo`/`env`/`command`), absolute paths, and compound segments are covered.
- The consult prompt includes tails (2 KB) of recent tool output, so secrets your commands printed travel to the reviewer CLI. Reviewer CLIs run under your own credentials; treat the reviewer as inside your trust boundary. Heuristic redaction is a possible future addition.
- In-flight reviewer processes are detached: on pi exit they run to their timeout instead of being killed with the session.
- A publish bypass (re-issuing the reviewed command) never expires within the session.
- `binary` in `.pi/unblock-settings.json` is project trust, same class as project extensions: a cloned repo can point it at an arbitrary executable.
