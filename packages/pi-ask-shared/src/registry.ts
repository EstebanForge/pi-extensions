/**
 * One background run tracked by an ask tool. The registry is process-state
 * only; the owning tool attaches the real child handle outside this record
 * and passes a kill callback where needed.
 */
export interface BackgroundRun {
	runId: string;
	/** One-line prompt summary. Keeps /stop listings and wake messages meaningful across branches. */
	summary: string;
	startedAt: number;
	settledAt?: number;
	status: "running" | "done" | "failed";
	/** Full peer answer, set on done. */
	output?: string;
	/** Resume-handle line, e.g. `sessionId=abc`. Fresh runs have none until close. */
	handle?: string;
	/** Failure reason, set on failed. */
	error?: string;
}

export interface RegistryOptions {
	/** Tool label used in error messages, e.g. "ask-claude". */
	toolName: string;
	/** Max simultaneously running background runs. Default 4. */
	maxConcurrent?: number;
	/** Settled runs older than this are swept. Default 1h. Running runs are owned by their own timeout. */
	ttlMs?: number;
	/** RunId factory, injectable for tests. */
	makeRunId?: () => string;
}

const DEFAULT_MAX_CONCURRENT = 4;
const DEFAULT_TTL_MS = 60 * 60 * 1000;

/**
 * Tracks background runs for one tool. Instances are intentionally per-tool:
 * Pi loads packages with separate module roots, so each extension gets its own
 * instance and no cross-package state is shared.
 */
export class BackgroundRunRegistry {
	#runs = new Map<string, BackgroundRun>();
	#disposed = false;
	readonly #toolName: string;
	readonly #maxConcurrent: number;
	readonly #ttlMs: number;
	readonly #makeRunId: () => string;

	constructor(options: RegistryOptions) {
		this.#toolName = options.toolName;
		this.#maxConcurrent = options.maxConcurrent ?? DEFAULT_MAX_CONCURRENT;
		this.#ttlMs = options.ttlMs ?? DEFAULT_TTL_MS;
		this.#makeRunId = options.makeRunId ?? defaultMakeRunId;
	}

	/** Registers a running run. Throws RangeError when the concurrency cap is reached. */
	start(summary: string): BackgroundRun {
		this.#assertActive();
		const running = this.list("running").length;
		if (running >= this.#maxConcurrent) {
			throw new RangeError(
				`${this.#toolName}: ${running} background runs already active (max ${this.#maxConcurrent}); settle one or use blocking mode`,
			);
		}
		const run: BackgroundRun = {
			runId: this.#makeRunId(),
			summary,
			startedAt: Date.now(),
			status: "running",
		};
		this.#runs.set(run.runId, run);
		return run;
	}

	get(runId: string): BackgroundRun | undefined {
		return this.#runs.get(runId);
	}

	/**
	 * Settles a run exactly once. Later settles are rejected so timeout, abort
	 * and close handlers can all fire without double-sending a wake.
	 */
	settle(runId: string, patch: { status: "done" | "failed"; output?: string; handle?: string; error?: string }): boolean {
		const run = this.#runs.get(runId);
		if (!run || run.status !== "running") {
			return false;
		}
		run.status = patch.status;
		run.output = patch.output;
		run.handle = patch.handle;
		run.error = patch.error;
		run.settledAt = Date.now();
		return true;
	}

	/** Unique id-prefix lookup for /stop. Ambiguous prefixes return undefined. */
	find(prefix: string): BackgroundRun | undefined {
		const hits = this.list().filter((run) => run.runId.includes(prefix));
		return hits.length === 1 ? hits[0] : undefined;
	}

	list(status?: BackgroundRun["status"]): BackgroundRun[] {
		const all = [...this.#runs.values()];
		return status ? all.filter((run) => run.status === status) : all;
	}

	/**
	 * Drops settled runs past the TTL. Running runs are never swept here: their
	 * lifecycle belongs to the tool's own timeout. `ageOf` defaults to the run's
	 * own settledAt; tests inject a fixed now through it.
	 */
	sweep(now: number = Date.now(), ageOf: (run: BackgroundRun) => number = (run) => run.settledAt ?? now): string[] {
		const dropped: string[] = [];
		for (const run of this.list()) {
			if (run.status === "running") {
				continue;
			}
			if (now - ageOf(run) > this.#ttlMs) {
				this.#runs.delete(run.runId);
				dropped.push(run.runId);
			}
		}
		return dropped;
	}

	/**
	 * Latches disposal (session shutdown, reload). Returns still-running runs so
	 * the owner can kill their processes. Reads and settles stay legal after
	 * disposal; only new work and wake sends are blocked.
	 */
	dispose(): BackgroundRun[] {
		this.#disposed = true;
		return this.list("running");
	}

	isDisposed(): boolean {
		return this.#disposed;
	}

	#assertActive(): void {
		if (this.#disposed) {
			throw new Error(`${this.#toolName}: registry disposed; background runs are unavailable`);
		}
	}
}

function defaultMakeRunId(): string {
	const uuid = crypto.randomUUID();
	// Short, readable, prefix-matchable. Collision risk is irrelevant at max 4 runs.
	return `bg_${uuid.slice(0, 8)}`;
}
