import { describe, expect, it, afterEach, beforeEach } from "vitest";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	classifySlug,
	resolveCodexModel,
	REASONING_VALUES,
	type CodexModelEntry,
} from "@estebanforge/pi-ask-shared";
import factory from "../extensions/index.js";

// Synthetic catalog mirroring the real `codex debug models --bundled` shape
// for the GPT-6 era (verified against codex-cli 0.159.3).
const FULL_EFFORTS = ["low", "medium", "high", "xhigh", "max", "ultra"];
// luna supports everything except ultra (verified against the live catalog).
const LUNA_EFFORTS = ["low", "medium", "high", "xhigh", "max"];

function entry(
	slug: string,
	opts: { efforts?: string[]; upgrade?: string | null; hidden?: boolean } = {},
): CodexModelEntry {
	const { family, version } = classifySlug(slug);
	return {
		full: slug,
		family,
		version,
		efforts: opts.efforts ?? (slug.includes("luna") ? LUNA_EFFORTS : FULL_EFFORTS),
		upgrade: opts.upgrade ?? null,
		hidden: opts.hidden ?? false,
	};
}

const CATALOG: CodexModelEntry[] = [
	entry("gpt-6.1-sol"),
	entry("gpt-6-astra"),
	entry("gpt-6-sol"),
	entry("gpt-6-luna"),
	entry("gpt-5.6-sol", { upgrade: "gpt-6-sol" }),
	entry("gpt-5.6-terra", { upgrade: "gpt-6-sol" }),
	entry("gpt-5.6-luna", { upgrade: "gpt-6-luna" }),
	entry("gpt-5.5", { efforts: LUNA_EFFORTS, upgrade: "gpt-6-sol" }),
	// Hidden catalog entries: reachable as exact ids, never via aliases.
	entry("gpt-daybreak-blue-latest", { hidden: true }),
	entry("codex-auto-review", { hidden: true }),
];

const CHAIN: CodexModelEntry[] = [
	entry("gpt-4-alpha", { upgrade: "gpt-5-beta" }),
	entry("gpt-5-beta", { upgrade: "gpt-6.1-sol" }),
	entry("gpt-6.1-sol"),
];

describe("classifySlug (GPT-6 taxonomy)", () => {
	it("routes sol variants to the main family", () => {
		expect(classifySlug("gpt-6.1-sol")).toEqual({ family: "main", version: "6.1" });
		expect(classifySlug("gpt-6-sol")).toEqual({ family: "main", version: "6" });
	});

	it("routes plain and terra slugs to the main family", () => {
		expect(classifySlug("gpt-5.5")).toEqual({ family: "main", version: "5.5" });
		expect(classifySlug("gpt-5.6-terra")).toEqual({ family: "main", version: "5.6" });
	});

	it("routes astra to its own frontier family", () => {
		expect(classifySlug("gpt-6-astra")).toEqual({ family: "frontier", version: "6" });
	});

	it("routes luna and legacy mini/nano to the fast family", () => {
		expect(classifySlug("gpt-6-luna")).toEqual({ family: "fast", version: "6" });
		expect(classifySlug("gpt-5.6-luna")).toEqual({ family: "fast", version: "5.6" });
		expect(classifySlug("gpt-5.4-mini")).toEqual({ family: "fast", version: "5.4" });
	});

	it("leaves non-GPT slugs unclassified", () => {
		expect(classifySlug("gpt-daybreak-blue-latest")).toEqual({ family: "other", version: null });
		expect(classifySlug("codex-auto-review")).toEqual({ family: "other", version: null });
	});
});

describe("resolveModel (GPT-6 catalog)", () => {
	it("omits the flag for 'default'", () => {
		expect(resolveCodexModel("default", CATALOG)).toEqual({ flagValue: null, entry: null });
	});

	it("resolves full/gpt to the highest-version main model", () => {
		expect(resolveCodexModel("full", CATALOG).flagValue).toBe("gpt-6.1-sol");
		expect(resolveCodexModel("gpt", CATALOG).flagValue).toBe("gpt-6.1-sol");
	});

	it("resolves mini/nano to the fast family (luna), not a dead mini family", () => {
		expect(resolveCodexModel("mini", CATALOG).flagValue).toBe("gpt-6-luna");
		expect(resolveCodexModel("nano", CATALOG).flagValue).toBe("gpt-6-luna");
	});

	it("resolves astra to the frontier family", () => {
		expect(resolveCodexModel("astra", CATALOG).flagValue).toBe("gpt-6-astra");
	});

	it("resolves pinned version + family", () => {
		expect(resolveCodexModel("6 mini", CATALOG).flagValue).toBe("gpt-6-luna");
		expect(resolveCodexModel("6.1 full", CATALOG).flagValue).toBe("gpt-6.1-sol");
		expect(resolveCodexModel("6 astra", CATALOG).flagValue).toBe("gpt-6-astra");
	});

	it("resolves tier names used as aliases (sol, luna)", () => {
		expect(resolveCodexModel("sol", CATALOG).flagValue).toBe("gpt-6.1-sol");
		expect(resolveCodexModel("luna", CATALOG).flagValue).toBe("gpt-6-luna");
		expect(resolveCodexModel("6 luna", CATALOG).flagValue).toBe("gpt-6-luna");
	});

	it("migrates pinned deprecated versions via the catalog upgrade pointer", () => {
		const r = resolveCodexModel("5.6 mini", CATALOG);
		expect(r.flagValue).toBe("gpt-6-luna");
		expect(r.entry?.upgrade).toBeNull();
	});

	it("migrates exact deprecated slugs via the catalog upgrade pointer", () => {
		expect(resolveCodexModel("gpt-5.5", CATALOG).flagValue).toBe("gpt-6-sol");
		expect(resolveCodexModel("gpt-5.6-sol", CATALOG).flagValue).toBe("gpt-6-sol");
	});

	it("keeps current exact slugs verbatim", () => {
		const r = resolveCodexModel("gpt-6-astra", CATALOG);
		expect(r.flagValue).toBe("gpt-6-astra");
		expect(r.entry?.family).toBe("frontier");
	});

	it("passes unknown input through untouched", () => {
		const r = resolveCodexModel("gpt-9-hyperspatial", CATALOG);
		expect(r.flagValue).toBe("gpt-9-hyperspatial");
		expect(r.entry).toBeNull();
	});

	it("passes a family with no catalog models through", () => {
		expect(resolveCodexModel("6 pro", CATALOG).flagValue).toBe("6 pro");
	});

	it("resolves hidden catalog entries as exact ids, verbatim", () => {
		const r = resolveCodexModel("gpt-daybreak-blue-latest", CATALOG);
		expect(r.flagValue).toBe("gpt-daybreak-blue-latest");
		expect(r.entry?.full).toBe("gpt-daybreak-blue-latest");
		expect(resolveCodexModel("codex-auto-review", CATALOG).flagValue).toBe("codex-auto-review");
	});

	it("never aliases onto a hidden entry", () => {
		const onlyHiddenFast = [entry("gpt-7-luna", { hidden: true })];
		expect(resolveCodexModel("mini", onlyHiddenFast)).toEqual({ flagValue: "mini", entry: null });
	});

	it("passes visible unknown-suffix slugs through verbatim", () => {
		const withPreview = [...CATALOG, entry("gpt-6-preview")];
		const r = resolveCodexModel("gpt-6-preview", withPreview);
		expect(r.flagValue).toBe("gpt-6-preview");
	});

	it("resolves the carried effort ladder on the picked entry", () => {
		expect(resolveCodexModel("full", CATALOG).entry?.efforts).toContain("ultra");
		expect(resolveCodexModel("mini", CATALOG).entry?.efforts).not.toContain("ultra");
	});

	it("follows multi-hop upgrade chains", () => {
		expect(resolveCodexModel("gpt-4-alpha", CHAIN).flagValue).toBe("gpt-6.1-sol");
	});

	it("forwards a dead upgrade target slug instead of the retired model", () => {
		const dead = [entry("gpt-5-old", { upgrade: "gpt-6-ghost" })];
		expect(resolveCodexModel("gpt-5-old", dead).flagValue).toBe("gpt-6-ghost");
	});

	it("terminates on upgrade cycles", () => {
		const cycle = [
			entry("gpt-5-a", { upgrade: "gpt-5-b" }),
			entry("gpt-5-b", { upgrade: "gpt-5-a" }),
		];
		expect(resolveCodexModel("gpt-5-a", cycle).flagValue).toBe("gpt-5-b");
	});
});

describe("reasoning effort values", () => {
	it("tracks the current ladder and drops the retired minimal tier", () => {
		expect(REASONING_VALUES).toEqual(["low", "medium", "high", "xhigh", "max", "ultra"]);
		expect(REASONING_VALUES).not.toContain("minimal");
	});
});

describe("pi-ask-codex extension entry", () => {
  it("registers the AskCodex tool", async () => {
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

    await factory(pi);

    expect(tools).toContain("AskCodex");
  });
});

// --- execute() against a fake codex fixture: time-budget notice ------------

describe("execute(): time-budget notice and non-positive timeout guard", () => {
	let tempRoot: string;
	let toolDef: { name: string; execute: (...a: any[]) => Promise<any> } | null = null;
	const prevBin = process.env.CODEX_BIN;
	const prevPromptFile = process.env.FIXTURE_PROMPTFILE;

	const writeCodexFixture = (): string => {
		const script = `#!/usr/bin/env node
const args = process.argv.slice(2);
if (args.includes("--version")) { process.stdout.write("codex-cli 0.0.0-fake\\n"); process.exit(0); }
if (args.includes("models")) { process.exit(0); }
if (process.env.FIXTURE_PROMPTFILE) {
  require("node:fs").writeFileSync(process.env.FIXTURE_PROMPTFILE, args[args.length - 1] ?? "");
}
process.stdout.write(JSON.stringify({ type: "thread.started", thread_id: "99999999-8888-7777-6666-555555555555" }) + "\\n");
process.stdout.write(JSON.stringify({ type: "item.completed", item: { type: "agent_message", text: "OK" } }) + "\\n");
process.exit(0);
`;
		const p = join(tempRoot, `codex-fixture-${Date.now()}`);
		writeFileSync(p, script, { mode: 0o755 });
		return p;
	};

	const makePi = () => {
		const tools: any[] = [];
		const pi: any = new Proxy(
			{
				registerTool: (def: any) => void tools.push(def),
				registerCommand: () => {},
				getFlag: () => undefined,
				exec: async () => ({ code: 0, stdout: "", stderr: "" }),
			},
			{
				get(target, prop) {
					return prop in target ? (target as any)[prop] : () => {};
				},
			},
		);
		return { pi, tools };
	};

	const callExecute = (overrides: { params?: Record<string, unknown> } = {}) =>
		toolDef!.execute(
			"t",
			{ prompt: "hi", ...overrides.params },
			new AbortController().signal,
			undefined,
			{ cwd: tempRoot, model: { provider: "zai", baseUrl: "zai" } },
		);

	beforeEach(async () => {
		tempRoot = mkdtempSync(join(tmpdir(), "codex-exec-"));
		process.env.CODEX_BIN = writeCodexFixture();
		const { pi, tools } = makePi();
		await factory(pi);
		toolDef = tools[0];
	});

	afterEach(() => {
		rmSync(tempRoot, { recursive: true, force: true });
		if (prevBin === undefined) delete process.env.CODEX_BIN;
		else process.env.CODEX_BIN = prevBin;
		if (prevPromptFile === undefined) delete process.env.FIXTURE_PROMPTFILE;
		else process.env.FIXTURE_PROMPTFILE = prevPromptFile;
	});

	it("appends the time-budget notice to the positional prompt at the resolved default (10m)", async () => {
		const promptFile = join(tempRoot, "prompt.txt");
		process.env.FIXTURE_PROMPTFILE = promptFile;
		await callExecute({ params: { prompt: "summarize the diff" } });
		const seen = readFileSync(promptFile, "utf8");
		expect(seen.startsWith("summarize the diff")).toBe(true);
		expect(seen).toContain("[TIME BUDGET]");
		expect(seen).toContain("about 10 minutes");
	});

	it("rejects non-positive timeoutMinutes without spawning", async () => {
		const promptFile = join(tempRoot, "prompt-zero.txt");
		process.env.FIXTURE_PROMPTFILE = promptFile;
		const res = await callExecute({ params: { prompt: "x", timeoutMinutes: 0 } });
		expect(res.content?.[0]?.text).toMatch(/positive number of minutes/);
		expect(existsSync(promptFile)).toBe(false);
	});
});
