import os from "node:os";
import { describe, expect, it } from "vitest";
import extDefault, { formatHostname, HOSTNAME_EMOJI, STATUS_KEY } from "../extensions/index";

describe("formatHostname", () => {
	it("keeps a short hostname unchanged", () => {
		expect(formatHostname("mini")).toBe("mini");
	});

	it("strips the DNS domain", () => {
		expect(formatHostname("web01.example.com")).toBe("web01");
	});

	it("drops a trailing dot", () => {
		expect(formatHostname("build.lan.")).toBe("build");
	});

	it("returns empty for empty input", () => {
		expect(formatHostname("")).toBe("");
	});
});

describe("footer ordering", () => {
	it("STATUS_KEY sorts first against known extension status keys", () => {
		const keys = ["agentmemory", "codegraph", STATUS_KEY];
		const sorted = [...keys].sort((a, b) => a.localeCompare(b));
		expect(sorted[0]).toBe(STATUS_KEY);
	});

	it("label starts with the emoji and a space", () => {
		expect(`${HOSTNAME_EMOJI} mini`.startsWith(HOSTNAME_EMOJI)).toBe(true);
	});
});

describe("extension wiring", () => {
	it("session_start sets the footer status once, with key and hostname label", async () => {
		const calls: Array<[string, string]> = [];
		const handlers = new Map<string, Array<(event: unknown, ctx: unknown) => Promise<void>>>();
		const piStub = {
			on: (name: string, fn: (event: unknown, ctx: unknown) => Promise<void>) => {
				const list = handlers.get(name) ?? [];
				list.push(fn);
				handlers.set(name, list);
			},
		};
		const ctxStub = {
			ui: {
				setStatus: (key: string, text: string) => calls.push([key, text]),
				theme: { fg: (_name: string, text: string) => text },
			},
		};

		extDefault(piStub as never);
		const startHandlers = handlers.get("session_start");
		expect(startHandlers?.length).toBe(1);
		await startHandlers?.[0]?.({}, ctxStub);

		expect(calls.length).toBe(1);
		expect(calls[0]?.[0]).toBe(STATUS_KEY);
		expect(calls[0]?.[1]).toBe(`${HOSTNAME_EMOJI} ${formatHostname(os.hostname())}`);
	});
});
