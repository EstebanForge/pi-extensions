// Controller: the event-driven unblock logic between pi's extension events
// and the consult core. Ports are injected (notify, inject, runConsult,
// clock) so tests drive it with stub peers; extensions/index.ts adapts the
// real pi API onto it.
//
// Contract notes (from the hardened v1 design):
// - Failure-loop consults are async and injected at the next turn; a consult
//   that lands after a turn boundary moved on is stale and degrades to a
//   notify instead of transcript injection.
// - Failed consults consume the streak reset and the cooldown anchor (the
//   gate must not retry-storm a broken reviewer CLI).
// - Publish-boundary consults are synchronous and blocking behind a user
//   confirm; they are human-ordered, so they do not spend the auto budget.
// - Auto consults never fire without the autoUnblockOnFailure flag; the
//   /unblock command path (manualConsult) bypasses the budget but still
//   respects the in-flight mutex.
import { runConsult as defaultRunConsult, type ConsultPeer } from "@estebanforge/pi-ask-shared";
import { buildConsultPrompt, buildNotice, type FailureLine, type TranscriptTurn } from "./assemble.js";
import {
	isPublishCommand,
	noteConsultSettled,
	noteConsultStarted,
	noteToolResult,
	newUnblockState,
	type TriggerDecision,
	type UnblockState,
} from "./policy.js";
import { resolveCliFor, type UnblockSettings } from "./settings.js";

/** Shell tools pi reports for command execution; policy keys them as exec. */
const SHELL_TOOLS = new Set(["bash", "powershell", "exec"]);

/** Per-observation output tail kept for the transcript slice. */
const TAIL_CAP_CHARS = 2000;
/** Ring of recent observations feeding the consult transcript slice. */
const RING_MAX = 8;

export interface ObservationRecord {
	turn: number;
	tool: string;
	ok: boolean;
	command?: string;
	tail: string;
}

export interface ControllerPorts {
	notify(text: string): void;
	/** Inject a message into the model context at the next turn. */
	inject(text: string): void;
	runConsult: typeof defaultRunConsult;
	nowMs(): number;
	/** Publish-boundary confirmation. Absent in UIs without dialogs
	 *  (headless JSON/print): the gate degrades to skip-and-log. */
	confirm?(title: string, detail: string): Promise<boolean>;
}

export class UnblockController {
	private readonly ports: ControllerPorts;
	settings: UnblockSettings;
	private readonly state: UnblockState = newUnblockState();
	private turn = 0;
	/** Turn the in-flight consult started at; staleness stamp. */
	private consultTurn = -1;
	private readonly ring: ObservationRecord[] = [];

	constructor(settings: UnblockSettings, ports: ControllerPorts) {
		this.settings = settings;
		this.ports = ports;
	}

	onTurnStart(): void {
		this.turn += 1;
	}

	/** Record one tool result. Fires an async failure-loop consult when the
	 *  policy triggers; never blocks the caller. */
	onToolResult(toolName: string, ok: boolean, command: string | undefined, output: string): void {
		const isShell = SHELL_TOOLS.has(toolName);
		const tool = isShell ? "exec" : toolName;
		const obs: ObservationRecord = {
			turn: this.turn,
			tool: toolName,
			ok,
			command,
			tail: output.slice(-TAIL_CAP_CHARS),
		};
		this.ring.push(obs);
		if (this.ring.length > RING_MAX) this.ring.shift();

		const decision: TriggerDecision = noteToolResult(
			this.state,
			{ tool, ok, turn: this.turn, command },
			{
				threshold: this.settings.threshold,
				maxAutoConsults: this.settings.maxAutoConsultsPerSession,
				ignoredCommands: this.settings.ignoredCommands,
			},
		);

		if (!decision.trigger) return;
		if (!this.settings.autoUnblockOnFailure) {
			this.ports.notify(
				`unblock: ${decision.key} failed ${decision.count}x (auto-consult disabled)`,
			);
			return;
		}
		const started = noteConsultStarted(this.state, this.ports.nowMs(), {
			cooldownSec: this.settings.cooldownSec,
			maxAutoConsults: this.settings.maxAutoConsultsPerSession,
		});
		if (!started) {
			this.ports.notify("unblock: consult gate blocked (cooldown/budget)");
			return;
		}
		this.consultTurn = this.turn;
		void this.runFailureConsult(decision.key, decision.count);
	}

	/** Async loop consult: settles the policy state either way, injects when
	 *  fresh, notifies when stale or failed. */
	private async runFailureConsult(key: string, count: number): Promise<void> {
		const settled = this.consult(key, count);
		try {
			const result = await settled;
			noteConsultSettled(this.state);
			const stale = this.turn > this.consultTurn;
			if (stale) {
				this.ports.notify(`unblock: reviewer answered after the turn moved on\n${result.answer}`);
				return;
			}
			this.ports.inject(buildNotice(result.answer));
		} catch (err) {
			// Failed consults still consume the streak reset + cooldown (both
			// anchored at start); the executor transcript never sees the error.
			noteConsultSettled(this.state);
			const reason = err instanceof Error ? err.message : String(err);
			this.ports.notify(`unblock: consult failed — ${reason}`);
		}
	}

	/** Publish boundary: synchronous, blocking, behind a confirm. Returns a
	 *  block verdict when the user declines (the shell command never runs).
	 *  Headless UIs (no confirm support) degrade to skip-gate-and-log. */
	async onBeforePublish(command: string): Promise<{ block: true; reason: string } | undefined> {
		if (!this.settings.confirmOnPush) return undefined;
		if (!isPublishCommand(command)) return undefined;
		let approved: boolean;
		try {
			if (!this.ports.confirm) throw new Error("no confirm UI");
			approved = await this.ports.confirm("Publish?", command);
		} catch {
			this.ports.notify(`unblock: no confirm UI available; letting ${commandRootOf(command)} run`);
			return undefined;
		}
		if (!approved) {
			return { block: true, reason: "publish declined at the unblock gate" };
		}
		// Human-ordered consult: synchronous, no auto-budget spend, but the
		// in-flight mutex still applies.
		if (!noteConsultStarted(this.state, this.ports.nowMs(), { cooldownSec: 0, maxAutoConsults: Infinity })) {
			this.ports.notify("unblock: a consult is already in flight; publishing without review");
			return undefined;
		}
		try {
			const result = await this.consult(`publish:${commandRootOf(command)}`, 1);
			this.ports.inject(buildNotice(result.answer));
		} catch (err) {
			const reason = err instanceof Error ? err.message : String(err);
			this.ports.notify(`unblock: pre-publish consult failed — ${reason}`);
		} finally {
			noteConsultSettled(this.state);
		}
		return undefined;
	}

	/** Manual /unblock: explicit human consult, bypasses the auto budget. */
	async manualConsult(focus?: string): Promise<void> {
		if (
			!noteConsultStarted(this.state, this.ports.nowMs(), {
				cooldownSec: 0,
				maxAutoConsults: Infinity,
			})
		) {
			this.ports.notify("unblock: a consult is already in flight");
			return;
		}
		try {
			const result = await this.consult("manual", 1, focus);
			this.ports.inject(buildNotice(result.answer));
		} catch (err) {
			const reason = err instanceof Error ? err.message : String(err);
			this.ports.notify(`unblock: consult failed — ${reason}`);
		} finally {
			noteConsultSettled(this.state);
		}
	}

	/** Shared consult runner over the current ring + failure records. */
	private consult(triggerKey: string, failureCount: number, focus?: string) {
		const failures: FailureLine[] = this.ring
			.filter((r) => !r.ok)
			.slice(-3)
			.map((r) => ({
				command: r.command ?? r.tool,
				exitCode: 1,
				stderrTail: r.tail,
			}));
		const turns: TranscriptTurn[] = this.ring.slice(-this.settings.contextMaxTurns).map((r) => ({
			index: r.turn,
			tool: r.tool,
			summary: r.command ? `$ ${r.command}` : r.tool,
			output: r.tail,
		}));
		const prompt = buildConsultPrompt({
			triggerKey: focus ? `${triggerKey} — focus: ${focus}` : triggerKey,
			failureCount,
			recentFailures: failures,
			transcriptTurns: turns,
			settings: {
				preprompt: this.settings.preprompt,
				contextMaxTurns: this.settings.contextMaxTurns,
				maxOutputCharsPerTurn: this.settings.maxOutputCharsPerTurn,
			},
		});
		const { binary, args } = resolveCliFor(this.settings.reviewer, this.settings.binary);
		return this.ports.runConsult({
			peer: this.settings.reviewer as ConsultPeer,
			binary,
			args,
			prompt,
			timeoutMs: this.settings.timeoutSec * 1000,
			model: this.settings.model,
		});
	}
}

function commandRootOf(command: string): string {
	return command.trim().split(/\s+/)[0] ?? command;
}
