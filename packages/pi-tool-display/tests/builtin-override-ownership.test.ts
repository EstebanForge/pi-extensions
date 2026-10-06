import assert from "node:assert/strict";
import { test } from "vitest";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { registerToolDisplayOverrides } from "../lib/tool-overrides";
import { DEFAULT_TOOL_DISPLAY_CONFIG, type ToolDisplayConfig } from "../lib/types";

interface RenderComponentLike {
	render(width: number): string[];
}

interface RuntimeTool extends Record<string, unknown> {
	name: string;
	description?: string;
	label?: string;
	parameters?: unknown;
	renderCall?: (...args: unknown[]) => RenderComponentLike;
	renderResult?: (...args: unknown[]) => RenderComponentLike;
	execute?: (...args: unknown[]) => unknown;
}

interface ToolEventHandlers {
	session_start?: () => Promise<void> | void;
	before_agent_start?: () => Promise<void> | void;
}

interface OwnershipApiStub {
	api: ExtensionAPI;
	registeredTools: RuntimeTool[];
	eventHandlers: ToolEventHandlers;
	activeTools: string[];
	setActiveToolsCalls: string[][];
}

const BUILT_IN_OVERRIDE_NAMES = ["read", "grep", "find", "ls", "bash", "edit", "write"] as const;

function buildConfig(overrides: Partial<ToolDisplayConfig> = {}): ToolDisplayConfig {
	return {
		...DEFAULT_TOOL_DISPLAY_CONFIG,
		...overrides,
		registerToolOverrides: {
			...DEFAULT_TOOL_DISPLAY_CONFIG.registerToolOverrides,
			...overrides.registerToolOverrides,
		},
	};
}

function createOwnershipApiStub(options: {
	allTools?: RuntimeTool[];
	activeTools?: string[];
} = {}): OwnershipApiStub {
	const registeredTools: RuntimeTool[] = [];
	const eventHandlers: ToolEventHandlers = {};
	const setActiveToolsCalls: string[][] = [];
	const activeTools = options.activeTools
		?? ["read", "grep", "find", "ls", "bash", "edit", "write"];
	const allTools = options.allTools ?? [];
	const api = {
		registerTool(tool: RuntimeTool): void {
			registeredTools.push(tool);
			// pi re-activates a name on fresh registration (activate-on-
			// registration); mirror that so exclusion-restoration tests exercise
			// the real revert path.
			if (!activeTools.includes(tool.name)) {
				activeTools.push(tool.name);
			}
		},
		on(event: keyof ToolEventHandlers, handler: () => Promise<void> | void): void {
			eventHandlers[event] = handler;
		},
		getAllTools(): RuntimeTool[] {
			const names = new Set(allTools.map((tool) => tool.name));
			const defaultBuiltIns: RuntimeTool[] = BUILT_IN_OVERRIDE_NAMES
				.filter((name) => !names.has(name))
				.map((name) => ({
					name,
					description: `Built-in ${name} tool`,
					sourceInfo: { source: "builtin", path: `<builtin:${name}>` },
				}));
			return [...defaultBuiltIns, ...allTools];
		},
		getActiveTools(): string[] {
			return [...activeTools];
		},
		setActiveTools(names: string[]): void {
			setActiveToolsCalls.push([...names]);
			activeTools.splice(0, activeTools.length, ...names);
		},
	} as unknown as ExtensionAPI;

	return { api, registeredTools, eventHandlers, activeTools, setActiveToolsCalls };
}

async function runLifecycle(eventHandlers: ToolEventHandlers): Promise<void> {
	await eventHandlers.session_start?.();
	await eventHandlers.before_agent_start?.();
}

function registeredNames(registeredTools: RuntimeTool[]): string[] {
	return registeredTools.map((tool) => tool.name);
}

test("built-in overrides are not registered at factory time", () => {
	const { api, registeredTools } = createOwnershipApiStub();

	registerToolDisplayOverrides(api, () => buildConfig());

	assert.deepEqual(
		registeredNames(registeredTools).filter((name) => (BUILT_IN_OVERRIDE_NAMES as readonly string[]).includes(name)),
		[],
		"factory-time registration defeats cross-extension ownership discovery",
	);
});

test("built-in overrides register once during the session lifecycle", async () => {
	const { api, registeredTools, eventHandlers } = createOwnershipApiStub();

	registerToolDisplayOverrides(api, () => buildConfig());
	await runLifecycle(eventHandlers);

	const names = registeredNames(registeredTools).filter((name) => (BUILT_IN_OVERRIDE_NAMES as readonly string[]).includes(name));
	assert.equal(names.length, BUILT_IN_OVERRIDE_NAMES.length, `expected all built-ins registered, got: ${names.join(",")}`);
	assert.equal(new Set(names).size, BUILT_IN_OVERRIDE_NAMES.length, "lifecycle must not double-register");
	for (const tool of registeredTools) {
		assert.equal(typeof tool.renderResult, "function", `${tool.name} must carry display renderers`);
	}
});

test("foreign-owned read is skipped while other overrides register (tool-display loads first)", async () => {
	const hashlineRead: RuntimeTool = {
		name: "read",
		description: "Hashline read",
		sourceInfo: { source: "extension", path: "/ext/pi-hashline-edit-pro/index.ts" },
	};
	const { api, registeredTools, eventHandlers } = createOwnershipApiStub({ allTools: [hashlineRead] });

	registerToolDisplayOverrides(api, () => buildConfig());
	await runLifecycle(eventHandlers);

	const names = registeredNames(registeredTools);
	assert.equal(names.includes("read"), false, "hashline-owned read must not be overridden");
	for (const name of ["grep", "find", "ls", "bash", "edit", "write"]) {
		assert.equal(names.includes(name), true, `${name} should still register`);
	}
});

test("foreign-owned read is skipped when discovered only at lifecycle time (tool-display loads second)", async () => {
	// The stub only exposes hashline's read via getAllTools; there is no
	// factory-time signal. Registration must still defer to the lifecycle.
	const hashlineRead: RuntimeTool = {
		name: "read",
		description: "Hashline read",
		sourceInfo: { source: "extension", path: "/ext/pi-hashline-edit-pro/index.ts" },
	};
	const { api, registeredTools, eventHandlers } = createOwnershipApiStub({ allTools: [hashlineRead] });

	registerToolDisplayOverrides(api, () => buildConfig());
	assert.equal(registeredNames(registeredTools).includes("read"), false);
	await runLifecycle(eventHandlers);

	assert.equal(registeredNames(registeredTools).includes("read"), false);
});

test("registration does not re-activate tools another extension suppressed", async () => {
	// hashline removed edit and grep from the active list at its session_start
	// (replace/anchor_grep take over). Re-registering those names must not
	// silently reactivate them.
	const suppressed = ["read", "find", "ls", "bash", "write"];
	const { api, registeredTools, eventHandlers, activeTools } = createOwnershipApiStub({
		activeTools: suppressed,
	});

	registerToolDisplayOverrides(api, () => buildConfig());
	await runLifecycle(eventHandlers);

	const names = registeredNames(registeredTools);
	assert.equal(names.includes("edit"), true, "edit override registers even while suppressed");
	assert.equal(names.includes("grep"), true, "grep override registers even while suppressed");
	assert.deepEqual(
		[...activeTools].sort(),
		[...suppressed].sort(),
		"registration must not grow the active tool list",
	);
});

test("registration keeps already-active names active", async () => {
	const { api, eventHandlers, activeTools } = createOwnershipApiStub();

	registerToolDisplayOverrides(api, () => buildConfig());
	await runLifecycle(eventHandlers);

	assert.deepEqual([...activeTools].sort(), ["bash", "edit", "find", "grep", "ls", "read", "write"]);
});

test("user-disabled overrides never register", async () => {
	const config = buildConfig({
		registerToolOverrides: {
			...DEFAULT_TOOL_DISPLAY_CONFIG.registerToolOverrides,
			read: false,
			bash: false,
		},
	});
	const { api, registeredTools, eventHandlers } = createOwnershipApiStub();

	registerToolDisplayOverrides(api, () => config);
	await runLifecycle(eventHandlers);

	const names = registeredNames(registeredTools);
	assert.equal(names.includes("read"), false);
	assert.equal(names.includes("bash"), false);
	assert.equal(names.includes("edit"), true);
});
