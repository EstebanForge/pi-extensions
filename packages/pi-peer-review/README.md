# pi-peer-review

Adversarial peer review for [Pi](https://pi.dev). The premise: the executor model is the weaker model in the pair, so a stronger reviewer checks its work. Two doors, one reviewer, no model-facing tool — the triggers are deterministic, so the session cannot talk itself out of them.

## The two doors

**Review door: `/peer-review` (main command).** Reviews every change since the last check (or the session start, with `full`) under an adversarial frame:

- Material: your prompts since the last review, the executor's final message (labelled as a claim to verify), the real diff against a content-addressed snapshot, per-file verification facts (which test/typecheck/lint commands ran, whether files changed after the last passing one).
- Contract: the reviewer must tag findings `BLOCKER:` / `RISK:` / `NIT:` (max 5), cite `file:line` evidence or write `UNVERIFIED:` lines instead of guessing, and answer `NO_BLOCKERS` when nothing rises to blocking. A marker-free answer is shown to you but never auto-sent.
- Delivery: you always see the full text. `BLOCKER` and `RISK` findings are also injected into the model's next prompt as untrusted claims: "verify each against the code, fix the real ones, list the rejected ones".
- On a second pass over the same work, the frame switches to verification mode: prove the previous findings closed, hunt regressions, no new NITs.
- Budget-honest: an empty delta consults nothing, a failed or timed-out review never advances the pointer (coverage is not lost), a mid-run call is refused, and the consult timeout is a code constant (>= 120s) so file-reading reviews cannot livelock.

```text
/peer-review              review changes since the last check
/peer-review codex        same, forcing codex as the reviewer for this call
/peer-review full         review everything since session start
/peer-review auth flow    review, focused on the auth work
```

Works in any folder: with git it snapshots trees through a throwaway index (untracked files included, your real index untouched); without git it falls back to an mtime walk plus content hashes and runs an honest audit of current files (findings that may predate the executor are tagged `UNATTRIBUTABLE` and shown, not injected).

**Stuck door: `/unblock` and `/advice` (aliases).** The original gate, unchanged:

- **Failure-loop consults.** When the same tool fails `threshold` times in a row (shell failures keyed on the command root), the extension consults the reviewer through a one-shot headless run and injects the guidance mid-run (steer). Stale answers degrade to a notification. Failed consults still consume the streak reset and the cooldown — the gate never retry-storms a broken reviewer CLI.
- **Publish boundary.** `git push` and `gh pr create` (including inside compound commands) pass a confirm dialog first, which now shows "N files changed since last peer review". Accepted commands get a synchronous consult — against the peer-review frame when there is unreviewed work — whose answer blocks the call until the model re-issues it.
- `/unblock [focus text]` and `/advice [focus text]` are the same command (same handler, same arguments): consult the reviewer on demand with the recent transcript slice as material.

`settings` works from every door: `/peer-review settings`, `/unblock settings`, `/advice settings`.

## Design boundaries

- Exploratory commands (`grep`, `rg`, `find`, `ls`, ...) never build a failure streak — their exit 1 on no-match is a normal result.
- One-turn decay: a streak that did not repeat across a turn boundary dies.
- Auto consults are capped per session (default 3); after the cap, only the manual doors and the publish gate consult.
- Consults default to read-only postures per peer (claude read tools, codex read-only sandbox, agy plan mode with the skip flag off).
- Reviewer answers are ANSI-stripped before they can reach a transcript, and never enter the executor context on failure.
- Secret guard: env files, key material, and credential stores are never inlined (names listed instead), and everything that does inline passes a redaction pass first.
- Headless JSON/print modes degrade: the publish gate skips with a log line instead of blocking; the settings editor prints a snapshot.
- Telemetry is local-only: `.pi/unblock-log.jsonl` records settled runs and review outcomes.

## Configuration

Project-scoped `.pi/unblock-settings.json`, every key optional:

```json
{
	"reviewer": "claude",
	"binary": null,
	"model": null,
	"effort": null,
	"claudeModel": null,
	"claudeEffort": null,
	"codexModel": null,
	"codexEffort": null,
	"agyModel": null,
	"agyEffort": null,
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

- `model` / `effort`: defaults for whichever reviewer is active; `effort` is the thinking/reasoning level (claude: `default|low|medium|high|xhigh`, codex: `minimal..max`, agy: `low|medium|high`). Null uses the CLI's own default.
- The six per-reviewer keys (`claudeModel`, `codexEffort`, ...) beat the global pair when set, so each peer can keep its own model and effort.
- `/peer-review claude` (or `codex`, `agy`) overrides the reviewer for that one call while keeping the per-reviewer defaults.
- `timeoutSec` clamps to `5..2147483`; peer-review consults get `max(120s, 3 x timeoutSec)` regardless, because reading repos takes longer than unblocking.
- `preprompt` is always sent ahead of every frame — the standing adversarial instruction (e.g. "Attack the premise first").

Every key is editable through the settings editor; it enforces the same clamps the loader applies (`threshold` >= 2, `timeoutSec` 5..2147483, ...).

## Install

```
pi install npm:@estebanforge/pi-peer-review
```

## Known limitations

- Publish matcher residual gaps: quoted re-execution (`bash -c 'git push'`) and wrapper argument forms (`nice -n 5 git push`) bypass the gate. Plain `git push`, flags (`git -C repo push`), wrappers (`sudo`/`env`/`command`), absolute paths, and compound segments are covered.
- Without git, files written through bash (heredocs, `python -`) are invisible to the candidate walk; the frame says so. With git they are caught by the tree diff.
- Monorepo note: the delta covers the whole worktree, so human edits in sibling packages land in your review material.
- In-flight reviewer processes are detached: on pi exit they run to their timeout instead of being killed with the session.
- A publish bypass (re-issuing the reviewed command) never expires within the session.
- `binary` in `.pi/unblock-settings.json` is project trust, same class as project extensions: a cloned repo can point it at an arbitrary executable.
