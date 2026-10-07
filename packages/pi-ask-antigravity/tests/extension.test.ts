import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { describe, expect, it, test } from "vitest";
import factory, {
	type ModelEntry,
	buildFinalPrompt,
	filterHiddenModels,
	mergeCatalog,
	parseModelLine,
	resolveModel,
	reviewerAgentMd,
	stageReviewerAgent,
} from "../extensions/index.js";

// The REAL `agy models` stdout shape (verified live 2026-10, trimmed to two
// flash families):
// two columns, "<slug>  <display label>". --model takes only the slug (col 1);
// the label is display-only. Gemini and Claude bases split their tier out to a
// separate --effort; unverified families keep agy's exact slug with
// NO --effort, and the retired gpt-oss family is filtered out outright.
const RAW = [
	"gemini-3.8-flash-high     Gemini 3.8 Flash (High)",
	"gemini-3.8-flash-medium   Gemini 3.8 Flash (Medium)",
	"gemini-3.8-flash-low      Gemini 3.8 Flash (Low)",
	"gemini-3.6-flash-high     Gemini 3.6 Flash (High)",
	"gemini-3.6-flash-medium   Gemini 3.6 Flash (Medium)",
	"gemini-3.6-flash-low      Gemini 3.6 Flash (Low)",
	"gemini-3.1-pro-high       Gemini 3.1 Pro (High)",
	"gemini-3.1-pro-low        Gemini 3.1 Pro (Low)",
	"claude-opus-5-5-low       Claude Opus 5.5 (Low)",
	"claude-opus-5-5-medium    Claude Opus 5.5 (Medium)",
	"claude-opus-5-5-high      Claude Opus 5.5 (High)",
	"claude-sonnet-5-5-low     Claude Sonnet 5.5 (Low)",
	"claude-sonnet-5-5-medium  Claude Sonnet 5.5 (Medium)",
	"claude-sonnet-5-5-high    Claude Sonnet 5.5 (High)",
	"gpt-oss-120b-medium       GPT-OSS 120B (Medium)",
].join("\n");

const entries = mergeCatalog(
	filterHiddenModels(RAW.split("\n").map(parseModelLine).filter((e): e is ModelEntry => e !== null)),
);
const DEFAULT_THINKING = "medium";

test("filterHiddenModels: drops the hidden family even while agy still lists it", () => {
	assert.ok(RAW.includes("gpt-oss-120b-medium"), "fixture must carry the line the filter removes");
	assert.equal(entries.some((e) => e.full.startsWith("gpt-oss-")), false);
});

test("resolveModel: bare base ids resolve to the nearest tier variant", () => {
	// The provider advertises the bare id (antigravity/claude-sonnet-5-5),
	// but a bare base is invalid upstream without --effort: the resolver
	// must pick a variant, not pass the base through raw.
	assert.deepEqual(resolveModel("claude-sonnet-5-5", entries, DEFAULT_THINKING), {
		model: "claude-sonnet-5-5",
		effort: "medium",
	});
	assert.deepEqual(resolveModel("claude-opus-5-5", entries, DEFAULT_THINKING, "high"), {
		model: "claude-opus-5-5",
		effort: "high",
	});
});

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
		// "-thinking" is NOT a low/medium/high tier (unknown suffix).
		assert.equal(parseModelLine("claude-opus-4-6-thinking  Claude Opus 4.6 (Thinking)")?.tier, null);
		// Tiered Claude slugs parse like Gemini: suffix = tier, family "other".
		assert.deepEqual(parseModelLine("claude-sonnet-5-5-low     Claude Sonnet 5.5 (Low)"), {
			full: "claude-sonnet-5-5-low",
			family: "other",
			version: null,
			tier: "low",
		});
		// A bare-slug line (no label) still parses: col1 = the whole line.
		assert.equal(parseModelLine("claude-sonnet-5-5-high")?.full, "claude-sonnet-5-5-high");
	});

	test("resolveModel: friendly alias splits Gemini base + default effort", () => {
		assert.deepEqual(resolveModel("flash", entries, DEFAULT_THINKING), {
			model: "gemini-3.8-flash",
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
			model: "gemini-3.8-flash",
			effort: "high",
		});
		assert.deepEqual(resolveModel("3.6 flash low", entries, DEFAULT_THINKING), {
			model: "gemini-3.6-flash",
			effort: "low",
		});
	});

	test("resolveModel: short aliases pick the tiered Claude entry and split base+effort", () => {
		// Claude ships low/medium/high like Gemini now: the alias resolves to
		// the base slug and the tier rides --effort (agy rejects a bare base).
		assert.deepEqual(resolveModel("sonnet", entries, DEFAULT_THINKING), {
			model: "claude-sonnet-5-5",
			effort: "medium",
		});
		assert.deepEqual(resolveModel("opus", entries, DEFAULT_THINKING), {
			model: "claude-opus-5-5",
			effort: "medium",
		});
		// gpt-oss is filtered from the catalog and its alias is gone: resolution
		// returns null so the caller passes the raw string and agy rejects it
		// loudly instead of the tool offering a dying model.
		assert.equal(resolveModel("gpt-oss", entries, DEFAULT_THINKING), null);
		assert.equal(resolveModel("gpt-oss-120b-medium", entries, DEFAULT_THINKING), null);
	});

	test("resolveModel: an exact tiered slug splits to base + effort (not passed whole)", () => {
		assert.deepEqual(resolveModel("gemini-3.6-flash-high", entries, DEFAULT_THINKING), {
			model: "gemini-3.6-flash",
			effort: "high",
		});
		assert.deepEqual(resolveModel("claude-sonnet-5-5-low", entries, DEFAULT_THINKING), {
			model: "claude-sonnet-5-5",
			effort: "low",
		});
		// An exact slug from a filtered family no longer resolves either.
		assert.equal(resolveModel("gpt-oss-120b-medium", entries, DEFAULT_THINKING), null);
		// Unknown input stays null: the caller passes it raw to agy.
		assert.equal(resolveModel("futuremodel-9-ultra", entries, DEFAULT_THINKING), null);
	});

	test("resolveModel: explicit preferred tier beats alias tier, default, and clamps to the family", () => {
	// thinking/effort param wins over the alias's own tier and the default.
	assert.deepEqual(resolveModel("flash high", entries, DEFAULT_THINKING, "low"), {
		model: "gemini-3.8-flash",
		effort: "low",
	});
	// Pro has no medium variant; the explicit tier clamps to the nearest
	// listed tier (distance tie low/high -> higher rank wins).
	assert.deepEqual(resolveModel("pro", entries, DEFAULT_THINKING, "medium"), {
		model: "gemini-3.1-pro",
		effort: "high",
	});
	// The explicit tier beats the Claude default and clamps to listed tiers.
	assert.deepEqual(resolveModel("sonnet", entries, DEFAULT_THINKING, "high"), {
		model: "claude-sonnet-5-5",
		effort: "high",
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
			model: "claude-sonnet-5-5",
			effort: "medium",
		});
		// The dropped family is not resurrected by any overlay.
		assert.equal(resolveModel("gpt-oss", geminiOnly, DEFAULT_THINKING), null);
	});
});

// --- Prompt assembly (headless plan-mode hardening) ------------------------
// Root cause probed 2026-09-28: `agy -p --mode plan` soft-denies run_command
// and the turn ends AT the denial (exit 0, empty stdout, no second model
// turn), so one unguarded command attempt kills the whole run. The prompt is
// the only lever the tool owns without touching user config.

describe("buildFinalPrompt (headless plan-mode hardening)", () => {
	test("plan mode appends the no-commands guard", () => {
		const out = buildFinalPrompt("Review the diff.\n---\ndiff body", "plan", false);
		assert.ok(out.startsWith("Review the diff."));
		assert.match(out, /Do not run shell commands/);
		assert.match(out, /ends the session immediately/);
		assert.ok(
			out.endsWith("state exactly what is missing in your answer instead of trying to fetch it."),
		);
	});

	test("plan + digest keeps digest prefix first, guard last", () => {
		const out = buildFinalPrompt("body", "plan", true);
		assert.ok(out.startsWith("(Use compact digests, not full file contents.)\n"));
		assert.ok(out.includes("(Use compact digests, not full file contents.)\nbody\n"));
		assert.ok(out.endsWith("instead of trying to fetch it."));
	});

	test("accept-edits never carries the guard", () => {
		// Edit runs keep their tools under skip-permissions; appending the guard
		// would break delegated edits and command use.
		assert.equal(buildFinalPrompt("do the edit", "accept-edits", false), "do the edit");
		assert.equal(
			buildFinalPrompt("do the edit", "accept-edits", true),
			"(Use compact digests, not full file contents.)\ndo the edit",
		);
	});
});

// --- Plan-mode reviewer agent (damper, not enforcement) ---------------------
// The restricted agent's toolset omits file-editing tools as a damper. The
// CLI does not enforce review-only (upstream #1181: writes bypass the
// permission system, the toolset is not honored reliably on 1.3.x), so the
// prompt guard carries the honest discipline: no file mutation, prefer
// staged material, and a denied command ends the run.

describe("plan-mode reviewer agent (damper, not enforcement)", () => {
	test("agent-damper plan run forbids file mutation and steers away from commands", () => {
		const out = buildFinalPrompt("review this", "plan", false, true);
		assert.match(out, /Do not create, modify, or delete any files/);
		assert.doesNotMatch(out, /Do not run shell commands/);
		assert.match(out, /Prefer the staged material and view_file/);
		assert.match(out, /a denied command ends the run|denied, the run ends/);
	});

	test("agent-damper accept-edits run is unchanged", () => {
		assert.equal(buildFinalPrompt("do the edit", "accept-edits", false, true), "do the edit");
	});

	test("reviewerAgentMd: toolset must never contain a file-editing tool", () => {
		const md = reviewerAgentMd("pi-bridge-ask-x");
		assert.match(md, /^name: pi-bridge-ask-x$/m);
		assert.match(md, /commandExecutionPolicy: auto/);
		assert.match(md, /mainAgent: true/);
		assert.doesNotMatch(md, /create_file/);
		assert.doesNotMatch(md, /edit_file/);
		assert.doesNotMatch(md, /write_file/);
		assert.match(md, /- view_file/);
		assert.match(md, /- run_command/);
	});

	test("stageReviewerAgent: creates a unique pid-marked agent dir under root", () => {
		const root = fs.mkdtempSync(path.join(os.tmpdir(), "ask-agents-"));
		const a = stageReviewerAgent(root);
		const b = stageReviewerAgent(root);
		assert.notEqual(a.name, b.name);
		assert.match(a.name, /^pi-bridge-ask-/);
		assert.ok(fs.existsSync(path.join(a.dir, "agent.md")));
		assert.equal(fs.readFileSync(path.join(a.dir, ".pid"), "utf8").trim(), String(process.pid));
		fs.rmSync(root, { recursive: true, force: true });
	});
});
