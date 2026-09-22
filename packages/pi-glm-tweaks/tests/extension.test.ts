import { afterAll, afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import factory from "../extensions/index.js";

type SessionStartHandler = (event: unknown, ctx: unknown) => void | Promise<void>;

interface TestPi {
	registerCommand: (name: string, def: unknown) => void;
	registerFlag: (name: string, def: unknown) => void;
	on: (name: string, handler: SessionStartHandler) => void;
	registerProvider: (provider: string, def: unknown) => void;
	registerTool: (tool: unknown) => void;
	getFlag: (name: string) => boolean | undefined;
}

function makePi(models: Array<{ provider: string; id: string }>) {
	const commands: string[] = [];
	const handlers: Record<string, SessionStartHandler> = {};

	const state = { registered: undefined as { provider: string; def: unknown } | undefined };
	const tools: unknown[] = [];

	const pi = {
		registerCommand: (name: string) => void commands.push(name),
		registerFlag: () => {},
		on: (name: string, handler: SessionStartHandler) => void (handlers[name] = handler),
		registerProvider: (provider: string, def: unknown) => void (state.registered = { provider, def }),
		registerTool: (tool: unknown) => void tools.push(tool),
		getFlag: (_name: string) => undefined as boolean | undefined,
	};

	const ctx = {
		model: models[0],
		modelRegistry: {
			getAll: () => models,
			getApiKeyForProvider: async () => "test-key",
		},
		ui: { notify: () => {} },
	};

	return { pi, commands, handlers, state, tools, ctx };
}

describe("pi-glm-tweaks extension entry", () => {
	// Pin an empty settings file for every test in this block: without
	// PI_CODING_AGENT_DIR they would read the developer's real
	// ~/.pi/agent/pi-glm-tweaks.json and register against whatever API route
	// the host install has set. (The route describe below pins its own.)
	const settingsDir = mkdtempSync(join(tmpdir(), "glm-tweaks-test-"));
	writeFileSync(join(settingsDir, "pi-glm-tweaks.json"), "{}");
	beforeEach(() => {
		process.env.PI_CODING_AGENT_DIR = settingsDir;
	});
	afterEach(() => {
		delete process.env.PI_CODING_AGENT_DIR;
	});
	afterAll(() => {
		rmSync(settingsDir, { recursive: true, force: true });
	});

	it("registers the glm-tweaks command", async () => {
		const { pi, commands } = makePi([]);
		await factory(pi as unknown as TestPi);
		expect(commands).toContain("glm-tweaks");
	});

	it("re-registers glm-5.3 with the 5.3 thinking map (low enabled, no disabled)", async () => {
		const { pi, handlers, state, ctx } = makePi([
			{ provider: "zai", id: "glm-5.2" },
			{ provider: "zai", id: "glm-5.3" },
			{ provider: "zai", id: "glm-4.7" },
		]);
		await factory(pi as unknown as TestPi);
		await handlers.session_start(undefined, ctx);

		const { registered } = state;
		expect(registered).toBeDefined();
		const models = (registered!.def as { models: Array<Record<string, unknown>> }).models;
		const glm53 = models.find((m) => m.id === "glm-5.3") as {
			thinkingLevelMap: Record<string, string | null>;
		};
		expect(glm53.thinkingLevelMap).toEqual({
			off: "low",
			minimal: null,
			medium: null,
			low: "low",
			high: "high",
			xhigh: null,
			max: "max",
		});

		// Untargeted models pass through untouched; 5.2 keeps its own map.
		const glm47 = models.find((m) => m.id === "glm-4.7");
		expect(glm47).toEqual({ provider: "zai", id: "glm-4.7" });
		const glm52 = models.find((m) => m.id === "glm-5.2") as {
			thinkingLevelMap: Record<string, string | null>;
		};
		expect(glm52.thinkingLevelMap.low).toBeNull();
	});

	it("does not re-register when no targeted model is present", async () => {
		const { pi, handlers, state, ctx } = makePi([{ provider: "zai", id: "glm-4.7" }]);
		await factory(pi as unknown as TestPi);
		await handlers.session_start(undefined, ctx);
		expect(state.registered).toBeUndefined();
	});

	it("rewrites rejected thinking.type=disabled to enabled+low on glm-5.3, leaves glm-5.2 alone", async () => {
		const { pi, handlers, ctx } = makePi([{ provider: "zai", id: "glm-5.3" }]);
		await factory(pi as unknown as TestPi);

		const run = (model: { provider: string; id: string }, payload: Record<string, unknown>) => {
			const evt = { payload: JSON.parse(JSON.stringify(payload)) };
			// ctx is a shared mutable object; swap the model for this call.
			(ctx as { model: unknown }).model = model;
			return handlers.before_provider_request(evt, ctx) as Record<string, unknown>;
		};

		// Pi's zai branch with level "off": thinking disabled, no effort.
		// 5.3 must be rewritten to z.ai's migration shape.
		const out53 = run({ provider: "zai", id: "glm-5.3" }, {
			thinking: { type: "disabled", clear_thinking: false },
		});
		expect(out53.thinking).toEqual({ type: "enabled", clear_thinking: false });
		expect(out53.reasoning_effort).toBe("low");

		// Same payload on 5.2 (canDisableThinking) passes through untouched.
		const out52 = run({ provider: "zai", id: "glm-5.2" }, {
			thinking: { type: "disabled", clear_thinking: false },
		});
		expect(out52.thinking).toEqual({ type: "disabled", clear_thinking: false });
		expect(out52.reasoning_effort).toBeUndefined();

		// Enabled payloads on 5.3 are untouched (guard fires only on disabled).
		const out53e = run({ provider: "zai", id: "glm-5.3" }, {
			thinking: { type: "enabled", clear_thinking: false },
			reasoning_effort: "max",
		});
		expect(out53e.thinking).toEqual({ type: "enabled", clear_thinking: false });
		expect(out53e.reasoning_effort).toBe("max");
	});

	it("targets glm-5.3-flash and glm-5.3-flash[1m] with the 5.3 thinking map and vision input", async () => {
		// Flash shares the 5.3 wire contract (thinking always on, low|high|max)
		// but is the FIRST multimodal GLM-5: input must carry "image" or pi
		// refuses to attach images to the model.
		const { pi, handlers, state, ctx } = makePi([
			{ provider: "zai", id: "glm-5.3-flash" },
			{ provider: "zai", id: "glm-5.3-flash[1m]" },
		]);
		await factory(pi as unknown as TestPi);
		await handlers.session_start(undefined, ctx);

		const models = (state.registered!.def as { models: Array<Record<string, unknown>> }).models;
		for (const id of ["glm-5.3-flash", "glm-5.3-flash[1m]"]) {
			const m = models.find((x) => x.id === id) as {
				input: string[];
				thinkingLevelMap: Record<string, string | null>;
				compat: Record<string, unknown>;
			};
			expect(m.thinkingLevelMap).toEqual({
				off: "low",
				minimal: null,
				medium: null,
				low: "low",
				high: "high",
				xhigh: null,
				max: "max",
			});
			expect(m.input).toEqual(["text", "image"]);
			expect(m.compat.thinkingFormat).toBe("zai");
			expect(m.compat.zaiToolStream).toBe(true);
		}
	});

	it("rewrites thinking.type=disabled on flash (endpoint silently thinks and bills anyway)", async () => {
		// Probed 2026-08-26: the coding endpoint does NOT reject disabled for
		// flash — it accepts it and runs lightweight thinking anyway (billed
		// reasoning tokens appeared). The guard must make the wire explicit.
		const { pi, handlers, ctx } = makePi([{ provider: "zai", id: "glm-5.3-flash" }]);
		await factory(pi as unknown as TestPi);

		const evt = { payload: { thinking: { type: "disabled", clear_thinking: false } } };
		const out = handlers.before_provider_request(evt, ctx) as Record<string, any>;
		expect(out.thinking).toEqual({ type: "enabled", clear_thinking: false });
		expect(out.reasoning_effort).toBe("low");
	});

	it("applies the flash fallback to unknown glm-5.4-flash, preserving vision input", async () => {
		const { pi, handlers, state, ctx } = makePi([{ provider: "zai", id: "glm-5.4-flash" }]);
		await factory(pi as unknown as TestPi);
		await handlers.session_start(undefined, ctx);

		const models = (state.registered!.def as { models: Array<Record<string, unknown>> }).models;
		const m = models.find((x) => x.id === "glm-5.4-flash") as { input: string[] };
		expect(m.input).toEqual(["text", "image"]);
	});

	it("keeps text-only models text-only when the spec says so", async () => {
		const { pi, handlers, state, ctx } = makePi([
			{ provider: "zai", id: "glm-5.2" },
			{ provider: "zai", id: "glm-5.3" },
		]);
		await factory(pi as unknown as TestPi);
		await handlers.session_start(undefined, ctx);

		const models = (state.registered!.def as { models: Array<Record<string, unknown>> }).models;
		for (const id of ["glm-5.2", "glm-5.3"]) {
			expect((models.find((x) => x.id === id) as { input: string[] }).input).toEqual(["text"]);
		}
	});

	it("registers published per-token costs (pricing page, list prices)", async () => {
		// z.ai published rates (docs.z.ai/guides/overview/pricing, per 1M tok):
		// 5.2/5.3 = 1.4 in / 4.4 out / 0.26 cached; flash = 0.15/0.50/0.03 list
		// (50% promo through 2026-09-09 — list prices encoded, promo is
		// temporary). Regression guard: buildGlmModel used to zero costs,
		// wiping pi's built-in glm-5.2 rates on re-registration.
		const { pi, handlers, state, ctx } = makePi([
			{ provider: "zai", id: "glm-5.2" },
			{ provider: "zai", id: "glm-5.3" },
			{ provider: "zai", id: "glm-5.3-flash" },
		]);
		await factory(pi as unknown as TestPi);
		await handlers.session_start(undefined, ctx);

		const models = (state.registered!.def as { models: Array<Record<string, any>> }).models;
		const costOf = (id: string) => models.find((m) => m.id === id)!.cost;
		expect(costOf("glm-5.2")).toEqual({ input: 1.4, output: 4.4, cacheRead: 0.26, cacheWrite: 0 });
		expect(costOf("glm-5.3")).toEqual({ input: 1.4, output: 4.4, cacheRead: 0.26, cacheWrite: 0 });
		expect(costOf("glm-5.3-flash")).toEqual({ input: 0.15, output: 0.5, cacheRead: 0.03, cacheWrite: 0 });
	});

	it("applies the 5.3 spec fallback to unknown glm-5.4 (forward compat), not to glm-4.x", async () => {
		const { pi, handlers, state, ctx } = makePi([
			{ provider: "zai", id: "glm-5.4" },
			{ provider: "zai", id: "glm-5.4[1m]" },
			{ provider: "zai", id: "glm-5.1" },
		]);
		await factory(pi as unknown as TestPi);
		await handlers.session_start(undefined, ctx);

		const models = (state.registered!.def as { models: Array<Record<string, unknown>> }).models;
		for (const id of ["glm-5.4", "glm-5.4[1m]"]) {
			const m = models.find((x) => x.id === id) as {
				thinkingLevelMap: Record<string, string | null>;
			};
			expect(m.thinkingLevelMap).toEqual({
				off: "low",
				minimal: null,
				medium: null,
				low: "low",
				high: "high",
				xhigh: null,
				max: "max",
			});
		}
		// glm-5.1 predates the new contract: untouched, no fallback.
		expect(models.find((x) => x.id === "glm-5.1")).toEqual({ provider: "zai", id: "glm-5.1" });
	});

	it("model_select clamps a stale xhigh up to max, not down to high", async () => {
		const { pi, handlers, ctx } = makePi([{ provider: "zai", id: "glm-5.3" }]);
		const set: string[] = [];
		const notes: string[] = []
		const pi2 = {
			...pi,
			getThinkingLevel: () => "xhigh",
			setThinkingLevel: (l: string) => void set.push(l),
		} as unknown as TestPi;
		(ctx as { ui: { notify: (m: string) => void } }).ui = {
			notify: (m: string) => void notes.push(m),
		};
		await factory(pi2);

		handlers.model_select({ model: { provider: "zai", id: "glm-5.3" } }, ctx);

		// xhigh was the pre-1.5.0 label for wire "max": the clamp must land on
		// max (same wire effort) instead of silently halving to high.
		expect(set).toEqual(["max"]);
		expect(notes[0]).toContain('Switched to max');
	});
});

describe("zai_web_search tool registration", () => {
	const toolName = (t: unknown) => (t as { name: string }).name;

	it("registers the tool by default (undefined flag = default ON)", async () => {
		const { pi, tools } = makePi([]);
		await factory(pi as unknown as TestPi);
		expect(tools.map(toolName)).toContain("zai_web_search");
	});

	it("does not register the tool when glm-web-search is opted out", async () => {
		const { pi, tools } = makePi([]);
		const optedOut = { ...pi, getFlag: (name: string) => (name === "glm-web-search" ? false : undefined) };
		await factory(optedOut as unknown as TestPi);
		expect(tools.map(toolName)).not.toContain("zai_web_search");
	});

	it("fails visibly with the opt-out hint when no Z.AI key exists anywhere", async () => {
		const { pi, tools, ctx } = makePi([]);
		await factory(pi as unknown as TestPi);
		const tool = tools.find((t) => toolName(t) === "zai_web_search") as {
			execute: (id: string, params: Record<string, unknown>, signal: AbortSignal | undefined, onUpdate: unknown, ctx: unknown) => Promise<unknown>;
		};

		// No provider key in the registry and no env var: execute must throw
		// (an empty result set would silently look like "no results found").
		// The makePi stub returns "test-key" — neutralize it so nothing
		// resolves and the tool must fail BEFORE any network traffic.
		(ctx as { modelRegistry: { getApiKeyForProvider: () => Promise<string | undefined> } }).modelRegistry = {
			getApiKeyForProvider: async () => undefined,
		};
		const hadEnv = process.env.ZAI_API_KEY;
		delete process.env.ZAI_API_KEY;
		try {
			await expect(tool.execute("t1", { query: "anything" }, undefined, undefined, ctx)).rejects.toThrow(
				/no Z\.AI API key.*glm-tweaks glm-web-search/s,
			);
		} finally {
			if (hadEnv !== undefined) process.env.ZAI_API_KEY = hadEnv;
		}
	});
});

describe("glm-api-route setting", () => {
	const tempDirs: string[] = [];

	function withRouteSetting(value: string) {
		const dir = mkdtempSync(join(tmpdir(), "glm-tweaks-test-"));
		tempDirs.push(dir);
		writeFileSync(join(dir, "pi-glm-tweaks.json"), JSON.stringify({ "glm-api-route": value }));
		process.env.PI_CODING_AGENT_DIR = dir;
	}

	afterEach(() => {
		delete process.env.PI_CODING_AGENT_DIR;
		for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
	});

	it("registers anthropic route models against api.z.ai/api/anthropic with pinned compat", async () => {
		withRouteSetting("anthropic");
		const { pi, handlers, state, ctx } = makePi([{ provider: "zai", id: "glm-5.3" }]);
		await factory(pi as unknown as TestPi);
		await handlers.session_start(undefined, ctx);

		const models = (state.registered!.def as { models: Array<Record<string, unknown>> }).models;
		const glm53 = models.find((m) => m.id === "glm-5.3") as Record<string, any>;
		expect(glm53.api).toBe("anthropic-messages");
		expect(glm53.baseUrl).toBe("https://api.z.ai/api/anthropic");
		// Unprobed ttl must never be requested: pin long retention off.
		expect(glm53.compat.supportsLongCacheRetention).toBe(false);
		// OpenAI-shape compat flags do not carry over.
		expect(glm53.compat.thinkingFormat).toBeUndefined();
		expect(glm53.compat.zaiToolStream).toBeUndefined();
		// The thinking map still drives UI-hide/clamp on both routes.
		expect(glm53.thinkingLevelMap.high).toBe("high");
	});

	it("coding route (default) keeps the documented OpenAI-shape contract", async () => {
		// Pin an empty settings file: without PI_CODING_AGENT_DIR this test
		// would read the developer's real ~/.pi/agent/pi-glm-tweaks.json and
		// fail whenever the host install has glm-api-route=anthropic.
		withRouteSetting("coding");
		const { pi, handlers, state, ctx } = makePi([{ provider: "zai", id: "glm-5.3" }]);
		await factory(pi as unknown as TestPi);
		await handlers.session_start(undefined, ctx);

		const models = (state.registered!.def as { models: Array<Record<string, unknown>> }).models;
		const glm53 = models.find((m) => m.id === "glm-5.3") as Record<string, any>;
		expect(glm53.api).toBe("openai-completions");
		expect(glm53.baseUrl).toBe("https://api.z.ai/api/coding/paas/v4");
		expect(glm53.compat.thinkingFormat).toBe("zai");
		expect(glm53.compat.zaiToolStream).toBe(true);
	});

	it("api route (standard z.ai platform API) registers against api.z.ai/api/paas/v4 with the OpenAI shape", async () => {
		withRouteSetting("api");
		const { pi, handlers, state, ctx } = makePi([{ provider: "zai", id: "glm-5.3" }]);
		await factory(pi as unknown as TestPi);
		await handlers.session_start(undefined, ctx);

		const models = (state.registered!.def as { models: Array<Record<string, unknown>> }).models;
		const glm53 = models.find((m) => m.id === "glm-5.3") as Record<string, any>;
		expect(glm53.api).toBe("openai-completions");
		expect(glm53.baseUrl).toBe("https://api.z.ai/api/paas/v4");
		// Same thinking contract as the coding route: only billing differs.
		expect(glm53.compat.thinkingFormat).toBe("zai");
	});

	it("legacy and unknown persisted route values resolve safely", async () => {
		// "coding" is the pre-1.5.0 persisted form and the fallback for
		// unset/garbage; "anthropic" is the other pre-1.5.0 form. Garbage
		// must fall back to coding, never throw or miswire the base URL.
		const cases: Array<[string, string]> = [
			["coding", "https://api.z.ai/api/coding/paas/v4"],
			["anthropic", "https://api.z.ai/api/anthropic"],
			["legacy-v1", "https://api.z.ai/api/coding/paas/v4"],
		];
		for (const [persisted, expectedBaseUrl] of cases) {
			withRouteSetting(persisted);
			const { pi, handlers, state, ctx } = makePi([{ provider: "zai", id: "glm-5.3" }]);
			await factory(pi as unknown as TestPi);
			await handlers.session_start(undefined, ctx);
			const models = (state.registered!.def as { models: Array<Record<string, unknown>> }).models;
			const glm53 = models.find((m) => m.id === "glm-5.3") as Record<string, any>;
			expect(glm53.baseUrl).toBe(expectedBaseUrl);
		}
	});

	it("anthropic route replaces Pi's budget-based thinking with enabled+reasoning_effort", async () => {
		withRouteSetting("anthropic");
		const { pi, handlers, ctx } = makePi([{ provider: "zai", id: "glm-5.3" }]);
		const pi2 = { ...pi, getThinkingLevel: () => "max" } as unknown as TestPi;
		await factory(pi2);
		// The branch keys off the REGISTERED model's api field, mirroring
		// what session_start built from the persisted route.
		(ctx as { model: { api?: string } }).model = { provider: "zai", id: "glm-5.3", api: "anthropic-messages" };

		// Pi's anthropic provider emits budget-based thinking; the route
		// branch must REPLACE the object, not merge into it.
		const evt = { payload: { thinking: { type: "enabled", budget_tokens: 8192, display: "summarized" } } };
		const out = handlers.before_provider_request(evt, ctx) as Record<string, any>;
		expect(out.thinking).toEqual({ type: "enabled", reasoning_effort: "max" });
		// budget_tokens/display dropped, no top-level effort field (the
		// endpoint ignores a top-level reasoning_effort silently).
		expect(out.reasoning_effort).toBeUndefined();
	});

	it("anthropic route never leaves thinking disabled (silent-ignore hazard)", async () => {
		withRouteSetting("anthropic");
		const { pi, handlers, ctx } = makePi([{ provider: "zai", id: "glm-5.3" }]);
		// Level "off" maps to null in the 5.3 map: the branch must fall
		// back to the lightest legal effort, NOT pass a disabled shape
		// through (z.ai ignores it and bills max-depth thinking anyway).
		const pi2 = { ...pi, getThinkingLevel: () => "off" } as unknown as TestPi;
		await factory(pi2);
		(ctx as { model: { api?: string } }).model = { provider: "zai", id: "glm-5.3", api: "anthropic-messages" };

		const evt = { payload: { thinking: { type: "disabled" } } };
		const out = handlers.before_provider_request(evt, ctx) as Record<string, any>;
		expect(out.thinking).toEqual({ type: "enabled", reasoning_effort: "low" });
	});

	it("anthropic route falls back to the lightest DOCUMENTED effort per spec (glm-5.2 off → high, not low)", async () => {
		// Peer-review finding (v1.5.0): glm-5.2's map has no "off" key, so an
		// unmapped level hit the hardcoded "low" fallback — an effort glm-5.2
		// does not document (its wire tiers are high|max). The fallback must
		// be spec-aware: 5.2 → high, 5.3 → low.
		withRouteSetting("anthropic");
		const { pi, handlers, ctx } = makePi([{ provider: "zai", id: "glm-5.2" }]);
		const pi2 = { ...pi, getThinkingLevel: () => "off" } as unknown as TestPi;
		await factory(pi2);
		(ctx as { model: { api?: string } }).model = { provider: "zai", id: "glm-5.2", api: "anthropic-messages" };

		const evt = { payload: { thinking: { type: "enabled", budget_tokens: 4096 } } };
		const out = handlers.before_provider_request(evt, ctx) as Record<string, any>;
		expect(out.thinking).toEqual({ type: "enabled", reasoning_effort: "high" });
	});

	it("coding route is untouched by the anthropic branch (disabled rewrite still OpenAI-shaped)", async () => {
		const { pi, handlers, ctx } = makePi([{ provider: "zai", id: "glm-5.3" }]);
		await factory(pi as unknown as TestPi);

		const evt = { payload: { thinking: { type: "disabled", clear_thinking: false } } };
		const out = handlers.before_provider_request(evt, ctx) as Record<string, any>;
		expect(out.thinking).toEqual({ type: "enabled", clear_thinking: false });
		expect(out.reasoning_effort).toBe("low");
	});

	it("route branch follows the registered model, not a concurrent settings flip", async () => {
		// Cross-session hazard (peer-review finding): session A flips
		// glm-api-route on disk while session B still runs a model registered
		// as openai-completions. The request-shape branch must follow
		// ctx.model.api, so B's next request keeps the coding shape.
		withRouteSetting("anthropic");
		const { pi, handlers, ctx } = makePi([{ provider: "zai", id: "glm-5.3" }]);
		await factory(pi as unknown as TestPi);
		(ctx as { model: { api?: string } }).model = { provider: "zai", id: "glm-5.3", api: "openai-completions" };

		const evt = { payload: { thinking: { type: "disabled", clear_thinking: false } } };
		const out = handlers.before_provider_request(evt, ctx) as Record<string, any>;
		// Coding-route safety net fired (OpenAI shape), NOT the anthropic
		// replacement — despite anthropic being on disk.
		expect(out.thinking).toEqual({ type: "enabled", clear_thinking: false });
		expect(out.reasoning_effort).toBe("low");
		expect(typeof out.thinking.reasoning_effort).toBe("undefined");
	});
});
