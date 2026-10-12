import { afterEach, describe, expect, it } from "vitest";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { getSettingsPath, loadVisionLockdown, saveVisionLockdown } from "../lib/settings";

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

describe("loadVisionLockdown", () => {
	it("defaults to false when the settings file is missing", () => {
		useDir();
		expect(loadVisionLockdown()).toBe(false);
	});

	it("reads visionLockdown true for lockdown runs", () => {
		const d = useDir();
		writeFileSync(join(d, "pi-image-inline.json"), JSON.stringify({ visionLockdown: true }));
		expect(loadVisionLockdown()).toBe(true);
	});

	it("reads false explicitly", () => {
		const d = useDir();
		writeFileSync(join(d, "pi-image-inline.json"), JSON.stringify({ visionLockdown: false }));
		expect(loadVisionLockdown()).toBe(false);
	});

	it("treats wrong-typed and corrupt files as false (fail closed to vision)", () => {
		const d = useDir();
		writeFileSync(join(d, "pi-image-inline.json"), JSON.stringify({ visionLockdown: "yes" }));
		expect(loadVisionLockdown()).toBe(false);
		writeFileSync(join(d, "pi-image-inline.json"), "{not json");
		expect(loadVisionLockdown()).toBe(false);
	});

	it("resolves the settings file under PI_CODING_AGENT_DIR", () => {
		const d = useDir();
		expect(getSettingsPath()).toBe(join(d, "pi-image-inline.json"));
	});
});

describe("saveVisionLockdown", () => {
	it("writes the value and round-trips through loadVisionLockdown", () => {
		useDir();
		saveVisionLockdown(true);
		expect(loadVisionLockdown()).toBe(true);
		saveVisionLockdown(false);
		expect(loadVisionLockdown()).toBe(false);
	});

	it("preserves unknown keys already in the file", () => {
		const d = useDir();
		writeFileSync(join(d, "pi-image-inline.json"), JSON.stringify({ futureKey: 7 }));
		saveVisionLockdown(true);
		const parsed = JSON.parse(readFileSync(join(d, "pi-image-inline.json"), "utf8"));
		expect(parsed).toEqual({ futureKey: 7, visionLockdown: true });
	});

	it("creates the file when missing", () => {
		useDir();
		saveVisionLockdown(true);
		expect(JSON.parse(readFileSync(getSettingsPath(), "utf8"))).toEqual({ visionLockdown: true });
	});
});
