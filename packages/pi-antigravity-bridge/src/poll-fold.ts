// Fold state machine for bridge_poll_result display events: consecutive
// polls collapse into ONE counted transcript entry instead of one entry per
// poll (observed live 2026-10-21: 60 "Poll git_commit" entries from a single
// wait, all flushed in bursts when the parked round-trip resolved).
//
// Runs close on a target switch, on any non-poll display event, or at turn
// end; the caller persists each closed run as an "agy-poll-run" entry.

export interface PollRunData {
	/** The pi tool the model kept polling, e.g. "git_commit". */
	target: string;
	count: number;
	/** Strongest poll outcome seen: running < done < failed. Sticky so a
	 *  still-running poll after a terminal one cannot downgrade the summary. */
	state: "running" | "done" | "failed";
	firstAt: string;
	lastAt: string;
}

const STATE_RANK: Record<PollRunData["state"], number> = { running: 0, done: 1, failed: 2 };

export class PollRunFolder {
	#run: PollRunData | undefined;

	/** The open run, for a live status-line counter. */
	get open(): PollRunData | undefined {
		return this.#run;
	}

	/** Fold one poll event. Returns a run to persist when this poll switched
	 *  targets away from the open run; the new poll always starts or extends
	 *  a run, so callers append the return value BEFORE reading `open`. */
	add(target: string, state: PollRunData["state"], at: Date): PollRunData | undefined {
		let closed: PollRunData | undefined;
		if (this.#run && this.#run.target !== target) closed = this.#close();
		if (!this.#run) {
			this.#run = { target, count: 0, state: "running", firstAt: at.toISOString(), lastAt: at.toISOString() };
		}
		this.#run.count += 1;
		this.#run.lastAt = at.toISOString();
		if (STATE_RANK[state] > STATE_RANK[this.#run.state]) this.#run.state = state;
		return closed;
	}

	/** Close and return the open run, if any. Idempotent. */
	flush(): PollRunData | undefined {
		return this.#run ? this.#close() : undefined;
	}

	#close(): PollRunData {
		const run = this.#run as PollRunData;
		this.#run = undefined;
		return run;
	}
}
