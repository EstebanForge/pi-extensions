import assert from "node:assert/strict";
import { describe, expect, it, test } from "vitest";
import factory, {
	type ModelEntry,
	mergeCatalog,
	parseModelLine,
	resolveModel,
} from "../extensions/index.js";

// The REAL `agy models` stdout shape (verified live via `ct agy models`):
// two columns, "<slug>  <display label>". --model takes only the slug (col 1);
// the label is display-only. Gemini bases split their tier out to a separate
// --effort; fixed families (claude-*, gpt-oss-*) keep agy's exact slug with
// NO --effort.
const RAW = [
	"gemini-3.6-flash-high     Gemini 3.6 Flash (High)",
	"gemini-3.6-flash-medium   Gemini 3.6 Flash (Medium)",
	"gemini-3.6-flash-low      Gemini 3.6 Flash (Low)",
	"gemini-3.5-flash-high     Gemini 3.5 Flash (High)",
	"gemini-3.5-flash-medium   Gemini 3.5 Flash (Medium)",
	"gemini-3.5-flash-low      Gemini 3.5 Flash (Low)",
	"gemini-3.1-pro-high       Gemini 3.1 Pro (High)",
	"gemini-3.1-pro-low        Gemini 3.1 Pro (Low)",
	"claude-sonnet-4-6         Claude Sonnet 4.6 (Thinking)",
	"claude-opus-4-6-thinking  Claude Opus 4.6 (Thinking)",
	"gpt-oss-120b-medium       GPT-OSS 120B (Medium)",
].join("\n");

const entries = mergeCatalog(
	RAW.split("\n").map(parseModelLine).filter((e): e is ModelEntry => e !== null),
);
const DEFAULT_THINKING = "medium";

describe("pi-ask-antigravity extension entry", () => {
  // This factory stays silent (registers nothing) when pi-antigravity-bridge
  // owns the AskAntigravity tool, which it detects by scanning install paths.
  // That detection is environment-dependent, so the publish gate asserts the
  // module loads, exports a callable factory, and invoking it never throws —
  // whether it registers or gracefully defers to the bridge.
  it("exposes a callable async factory that runs without throwing", async () => {
    expect(typeof factory).toBe("function");

    const tools: string[] = [];
    const commands: string[] = [];
    const pi: any = new Proxy(
      {
        registerTool: (def: any) => void tools.push(def?.name),
        registerCommand: (name: string) => void commands.push(name),
        getFlag: () => undefined,
        exec: async () => ({ code: 0, stdout: "", stderr: "" }),
      },
      {
        get(target, prop) {
          return prop in target ? (target as any)[prop] : () => {};
        },
      },
    );

    await expect(factory(pi)).resolves.toBeUndefined();
  });
});

describe("parseModelLine + resolveModel (two-column agy output)", () => {
	test("parseModelLine: splits the slug (col 1) off the display label", () => {
		// The label must never reach --model: full is the slug only.
		assert.deepEqual(parseModelLine("gemini-3.6-flash-high     Gemini 3.6 Flash (High)"), {
			full: "gemini-3.6-flash-high",
			family: "flash",
			version: "3.6",
			tier: "high",
		});
		// "-thinking" and a bare slug are NOT low/medium/high tiers.
		assert.equal(parseModelLine("claude-opus-4-6-thinking  Claude Opus 4.6 (Thinking)")?.tier, null);
		assert.equal(parseModelLine("claude-sonnet-4-6         Claude Sonnet 4.6 (Thinking)")?.tier, null);
		// A bare-slug line (no label) still parses: col1 = the whole line.
		assert.equal(parseModelLine("claude-sonnet-4-6")?.full, "claude-sonnet-4-6");
	});

	test("resolveModel: friendly alias splits Gemini base + default effort", () => {
		assert.deepEqual(resolveModel("flash", entries, DEFAULT_THINKING), {
			model: "gemini-3.6-flash",
			effort: "medium",
		});
		// Pro has no medium variant; its family default is high.
		assert.deepEqual(resolveModel("pro", entries, DEFAULT_THINKING), {
			model: "gemini-3.1-pro",
			effort: "high",
		});
	});

	test("resolveModel: explicit tier and pinned version", () => {
		assert.deepEqual(resolveModel("flash high", entries, DEFAULT_THINKING), {
			model: "gemini-3.6-flash",
			effort: "high",
		});
		assert.deepEqual(resolveModel("3.5 flash low", entries, DEFAULT_THINKING), {
			model: "gemini-3.5-flash",
			effort: "low",
		});
	});

	test("resolveModel: short aliases resolve to valid agy slugs with NO effort", () => {
		// Fixed-thinking families: agy rejects --effort, so the slug carries any
		// tier suffix itself (gpt-oss-120b-medium) and effort is absent.
		assert.deepEqual(resolveModel("sonnet", entries, DEFAULT_THINKING), { model: "claude-sonnet-4-6" });
		assert.deepEqual(resolveModel("opus", entries, DEFAULT_THINKING), {
			model: "claude-opus-4-6-thinking",
		});
		assert.deepEqual(resolveModel("gpt-oss", entries, DEFAULT_THINKING), {
			model: "gpt-oss-120b-medium",
		});
	});

	test("resolveModel: an exact tiered slug splits to base + effort (not passed whole)", () => {
		assert.deepEqual(resolveModel("gemini-3.6-flash-high", entries, DEFAULT_THINKING), {
			model: "gemini-3.6-flash",
			effort: "high",
		});
		assert.deepEqual(resolveModel("claude-sonnet-4-6", entries, DEFAULT_THINKING), {
			model: "claude-sonnet-4-6",
		});
	});

	test("resolveModel: explicit preferred tier beats alias tier, default, and clamps to the family", () => {
	// thinking/effort param wins over the alias's own tier and the default.
	assert.deepEqual(resolveModel("flash high", entries, DEFAULT_THINKING, "low"), {
		model: "gemini-3.6-flash",
		effort: "low",
	});
	// Pro has no medium variant; the explicit tier clamps to the nearest
	// listed tier (distance tie low/high -> higher rank wins).
	assert.deepEqual(resolveModel("pro", entries, DEFAULT_THINKING, "medium"), {
		model: "gemini-3.1-pro",
		effort: "high",
	});
	// Fixed-thinking families ignore the tier: agy rejects --effort for them.
	assert.deepEqual(resolveModel("sonnet", entries, DEFAULT_THINKING, "high"), {
		model: "claude-sonnet-4-6",
	});
});

test("resolveModel: short aliases still resolve when agy omits them (static overlay)", () => {
		const geminiOnly = mergeCatalog(
			[
				"gemini-3.6-flash-high   Gemini 3.6 Flash (High)",
				"gemini-3.6-flash-medium Gemini 3.6 Flash (Medium)",
				"gemini-3.6-flash-low    Gemini 3.6 Flash (Low)",
			]
				.join("\n")
				.split("\n")
				.map(parseModelLine)
				.filter((e): e is ModelEntry => e !== null),
		);
		assert.deepEqual(resolveModel("sonnet", geminiOnly, DEFAULT_THINKING), {
			model: "claude-sonnet-4-6",
		});
		assert.deepEqual(resolveModel("gpt-oss", geminiOnly, DEFAULT_THINKING), {
			model: "gpt-oss-120b-medium",
		});
	});
});
