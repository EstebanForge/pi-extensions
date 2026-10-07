import { afterEach, describe, expect, it } from "vitest";
import { mkdtempSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import factory from "../extensions/index";

// Minimal ExtensionAPI stand-in: captures handler registrations and
// appendEntry calls; flags read back what registerFlag seeded.
type Handler = (event: Record<string, unknown>, ctx: { cwd: string }) => unknown;

class FakePi {
	handlers = new Map<string, Handler>();
	entries: Array<{ type: string; data: unknown }> = [];
	flags = new Map<string, boolean | string>();

	on(type: string, handler: Handler) {
		this.handlers.set(type, handler);
	}
	registerEntryRenderer() {}
	registerFlag(name: string, options: { default?: boolean }) {
		this.flags.set(name, options.default ?? false);
	}
	getFlag(name: string) {
		return this.flags.get(name);
	}
	appendEntry(type: string, data: unknown) {
		this.entries.push({ type, data });
	}

	result(toolName: string, event: Record<string, unknown>, cwd = "/w") {
		return this.handlers.get("tool_result")?.({ toolName, ...event }, { cwd });
	}
}

const IMAGE = { type: "image", data: "aGk=", mimeType: "image/png" };

function pngFile(dir: string, name = "shot.png"): string {
	const path = join(dir, name);
	// 1x1 PNG header bytes suffice: nothing here decodes pixels.
	writeFileSync(path, Buffer.from("89504e470d0a1a0a", "hex"));
	return path;
}

afterEach(() => {
	delete process.env.PI_CODING_AGENT_DIR;
});

describe("tool_result wiring", () => {
	it("passes structuredContent back through when redacting, even when undefined", () => {
		const pi = new FakePi();
		factory(pi as never);
		const event = {
			toolCallId: "t1",
			input: {},
			content: [IMAGE],
			structuredContent: undefined,
			isError: false,
		};
		const result = pi.result("agent_browser", event) as Record<string, unknown>;
		expect(result).toEqual({
			content: [{ type: "text", text: expect.stringContaining("rendered in terminal") }],
			structuredContent: undefined,
		});
		expect("structuredContent" in result).toBe(true);
	});

	it("returns undefined when a capture result carries no images", () => {
		const pi = new FakePi();
		factory(pi as never);
		const result = pi.result("agent_browser", {
			toolCallId: "t2",
			input: {},
			content: [{ type: "text", text: "plain" }],
			isError: false,
		});
		expect(result).toBeUndefined();
		expect(pi.entries).toHaveLength(0);
	});

	it("emits one entry per image at top level, none for nested calls", () => {
		const pi = new FakePi();
		factory(pi as never);
		const dir = mkdtempSync(join(tmpdir(), "pii-wiring-"));
		const path = pngFile(dir);
		const observations = [{ path, pixels: { width: 4, height: 4 } }];
		const base = {
			input: {},
			content: [IMAGE, IMAGE],
			isError: false,
			details: { imageObservations: observations },
		};
		pi.result("agent_browser", { toolCallId: "top", ...base });
		pi.result("agent_browser", {
			toolCallId: "top/0",
			parentToolCallId: "top",
			...base,
		});
		expect(pi.entries).toHaveLength(2);
		expect(pi.entries[0]).toEqual({ type: "image-inline", data: { path, mtimeMs: expect.any(Number) } });
		rmSync(dir, { recursive: true, force: true });
	});

	it("exempts read by default and strips it under lockdown with the loop-safe placeholder", () => {
		const pi = new FakePi();
		factory(pi as never);
		const event = { toolCallId: "r1", input: {}, content: [IMAGE], isError: false };
		expect(pi.result("read", event)).toBeUndefined();

		pi.flags.set("image-inline-strip-read", true);
		const result = pi.result("read", event) as { content: Array<{ text: string }> };
		expect(result.content[0].text).not.toContain("call the read tool");
	});

	it("drops the cli start-time entry when the command fails", () => {
		const pi = new FakePi();
		factory(pi as never);
		const start = pi.handlers.get("tool_execution_start")!;
		start({ toolCallId: "c1", toolName: "exec_command", args: { command: "agent-browser screenshot x.png" } }, { cwd: "/w" });
		const result = pi.result("exec_command", {
			toolCallId: "c1",
			input: { command: "agent-browser screenshot x.png" },
			content: [{ type: "text", text: "boom" }],
			isError: true,
		});
		expect(result).toBeUndefined();
		// The stale start time must not survive to a later unrelated result.
		const later = pi.result("exec_command", {
			toolCallId: "c1",
			input: { command: "agent-browser screenshot x.png" },
			content: [{ type: "text", text: "Saved screenshot to /nowhere/x.png" }],
			isError: false,
		});
		expect(later).toBeUndefined();
		expect(pi.entries).toHaveLength(0);
	});

	it("inlines a fresh file produced by a shell capture, tui-only", () => {
		const pi = new FakePi();
		factory(pi as never);
		const dir = mkdtempSync(join(tmpdir(), "pii-wiring-"));
		const path = pngFile(dir, "fresh.png");
		const start = pi.handlers.get("tool_execution_start")!;
		start({ toolCallId: "c2", toolName: "exec_command", args: { cmd: "agent-browser screenshot fresh.png" } }, { cwd: dir });
		// Backdate the file to prove the mtime gate accepts within slack.
		utimesSync(path, new Date(), new Date(Date.now() - 1000));
		const result = pi.result("exec_command", {
			toolCallId: "c2",
			input: { cmd: "agent-browser screenshot fresh.png" },
			content: [{ type: "text", text: `Saved screenshot to ${path}` }],
			isError: false,
		});
		expect(result).toBeUndefined();
		expect(pi.entries).toEqual([{ type: "image-inline", data: { path, mtimeMs: expect.any(Number) } }]);
		rmSync(dir, { recursive: true, force: true });
	});

	it("ignores old files that merely appear in shell capture output", () => {
		const pi = new FakePi();
		factory(pi as never);
		const dir = mkdtempSync(join(tmpdir(), "pii-wiring-"));
		const path = pngFile(dir, "old.png");
		utimesSync(path, new Date(), new Date(Date.now() - 60_000));
		const start = pi.handlers.get("tool_execution_start")!;
		start({ toolCallId: "c3", toolName: "exec_command", args: { command: `agent-browser screenshot ${path}` } }, { cwd: dir });
		pi.result("exec_command", {
			toolCallId: "c3",
			input: { command: `agent-browser screenshot ${path}` },
			content: [{ type: "text", text: `Saved screenshot to ${path}` }],
			isError: false,
		});
		expect(pi.entries).toHaveLength(0);
		rmSync(dir, { recursive: true, force: true });
	});
});
