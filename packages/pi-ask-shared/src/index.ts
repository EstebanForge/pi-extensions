export { BackgroundRunRegistry, type BackgroundRun, type RegistryOptions } from "./registry.js";
export {
	configPaths,
	loadLayeredRaw,
	saveLayeredConfig,
	tryReadJson,
	type ConfigPaths,
	type LayeredRaw,
	type SaveResult,
} from "./config.js";
export { compareVersionsDesc } from "./versions.js";
export * from "./peers/claude.js";
export {
	runProcess,
	RunSpawnError,
	GRACE_AFTER_KILL_MS,
	DEFAULT_STDERR_CAP_CHARS,
	DEFAULT_LINE_BUF_MAX_CHARS,
	type RunProcessOptions,
	type RunProcessOutcome,
} from "./run.js";
export { buildWakeContent, createWakeSender, type WakeInfo, type WakeSenderOptions, type WakeTarget } from "./wake.js";
export { createStopHandler, type StopHandlerOptions } from "./stop.js";
export { backgroundFlagText, summarizePrompt } from "./text.js";
