import type { BackgroundRun, BackgroundRunRegistry } from "./registry.js";

export interface StopHandlerOptions {
	/** Kills the run's process. Must be idempotent; the registry latch ignores double settles. */
	kill: (run: BackgroundRun) => void;
	/** Called after a successful stop; owners send the failure wake here. */
	onStopped: (run: BackgroundRun) => void;
}

/**
 * Builds the /<tool>-stop command handler. Pure string-in, string-out: the
 * owning package wires it to pi.registerCommand and displays the reply.
 *
 * Behavior:
 * - no arg, one running run: stop it
 * - no arg, several running: list them, stop nothing
 * - no arg, none running: say so
 * - arg: unique id-prefix match, stop it; settled matches report as not running
 */
export function createStopHandler(
	registry: BackgroundRunRegistry,
	options: StopHandlerOptions,
): (args: string) => Promise<string> {
	return async (args: string) => {
		const query = args.trim();
		if (!query) {
			return stopBestMatch(registry, options);
		}
		const run = registry.find(query);
		if (!run) {
			const running = registry.list("running");
			if (running.length > 0) {
				return `No run matches "${query}". Running: ${running.map((r) => r.runId).join(", ")}`;
			}
			return `No run matches "${query}" and nothing is running.`;
		}
		if (run.status !== "running") {
			return `Run ${run.runId} is not running (status: ${run.status}).`;
		}
		return stopRun(registry, options, run);
	};
}

function stopBestMatch(registry: BackgroundRunRegistry, options: StopHandlerOptions): string {
	const running = registry.list("running");
	if (running.length === 0) {
		return "No running background runs.";
	}
	if (running.length > 1) {
		return `Several runs are active, name one: ${running.map((r) => `${r.runId} (${r.summary})`).join(", ")}`;
	}
	return stopRun(registry, options, running[0]);
}

function stopRun(registry: BackgroundRunRegistry, options: StopHandlerOptions, run: BackgroundRun): string {
	options.kill(run);
	registry.settle(run.runId, { status: "failed", error: "stopped by /stop command" });
	options.onStopped(run);
	return `Stopped ${run.runId} (${run.summary}).`;
}
