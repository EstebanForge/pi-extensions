import assert from "node:assert/strict";

import {
	shouldRequireRtkAvailabilityForCommandHandling,
	shouldSkipCommandHandlingWhenRtkMissing,
} from "../lib/runtime-guard";
import { cloneDefaultConfig, runTest } from "./helpers";
import type { RuntimeStatus } from "../lib/types";

function runtimeStatus(rtkAvailable: boolean): RuntimeStatus {
	return { rtkAvailable };
}

runTest("rewrite mode still requires RTK availability when guard is enabled", () => {
	const config = cloneDefaultConfig();
	config.mode = "rewrite";
	config.guardWhenRtkMissing = true;

	assert.equal(shouldRequireRtkAvailabilityForCommandHandling(config), true);
	assert.equal(shouldSkipCommandHandlingWhenRtkMissing(config, runtimeStatus(false)), true);
	assert.equal(shouldSkipCommandHandlingWhenRtkMissing(config, runtimeStatus(true)), false);
});

runTest("suggest mode uses RTK availability guard to avoid repeated missing-binary rewrite probes", () => {
	const config = cloneDefaultConfig();
	config.mode = "suggest";
	config.guardWhenRtkMissing = true;

	assert.equal(shouldRequireRtkAvailabilityForCommandHandling(config), true);
	assert.equal(shouldSkipCommandHandlingWhenRtkMissing(config, runtimeStatus(false)), true);
	assert.equal(shouldSkipCommandHandlingWhenRtkMissing(config, runtimeStatus(true)), false);
});

runTest("guard disabled never blocks command handling", () => {
	const config = cloneDefaultConfig();
	config.mode = "rewrite";
	config.guardWhenRtkMissing = false;

	assert.equal(shouldRequireRtkAvailabilityForCommandHandling(config), false);
	assert.equal(shouldSkipCommandHandlingWhenRtkMissing(config, runtimeStatus(false)), false);
});

console.log("All runtime-guard tests passed.");
