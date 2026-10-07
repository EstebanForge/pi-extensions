import { afterEach, describe, expect, it } from "vitest";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { getSettingsPath, loadStripRead } from "../lib/settings";

// Point PI_CODING_AGENT_DIR at a throwaway dir per test; settings.ts reads
// it on every call, so no module reset is needed.
let dir: string | undefined;

function useDir(): string {
	dir = mkdtempSync(join(tmpdir(), "pi-image-inline-test-"));
	process.env.PI_CODING_AGENT_DIR = dir;
	return dir;
}

afterEach(() => {
	if (dir) {
		rmSync(dir, { recursive: true, force: true });
		dir = undefined;
	}
	delete process.env.PI_CODING_AGENT_DIR;
});

describe("loadStripRead", () => {
	it("defaults to false when the settings file is missing", () => {
		useDir();
		expect(loadStripRead()).toBe(false);
	});

	it("reads stripRead true for lockdown runs", () => {
		const d = useDir();
		writeFileSync(join(d, "pi-image-inline.json"), JSON.stringify({ stripRead: true }));
		expect(loadStripRead()).toBe(true);
	});

	it("reads false explicitly", () => {
		const d = useDir();
		writeFileSync(join(d, "pi-image-inline.json"), JSON.stringify({ stripRead: false }));
		expect(loadStripRead()).toBe(false);
	});

	it("treats wrong-typed and corrupt files as false (fail closed to vision)", () => {
		const d = useDir();
		writeFileSync(join(d, "pi-image-inline.json"), JSON.stringify({ stripRead: "yes" }));
		expect(loadStripRead()).toBe(false);
		writeFileSync(join(d, "pi-image-inline.json"), "{not json");
		expect(loadStripRead()).toBe(false);
	});

	it("resolves the settings file under PI_CODING_AGENT_DIR", () => {
		const d = useDir();
		expect(getSettingsPath()).toBe(join(d, "pi-image-inline.json"));
	});
});
