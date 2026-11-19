import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "vitest";
import { agyAuthenticationMessage, agyInstallCommand, installAgyCli } from "../src/agy-install.js";

test("Linux and macOS download to a file before executing it", () => {
	for (const platform of ["linux", "darwin"] as const) {
		assert.deepEqual(agyInstallCommand(platform), {
			command: "bash",
			args: ["-c", "t=$(mktemp) && trap 'rm -f \"$t\"' EXIT && curl -fsSL https://antigravity.google/cli/install.sh -o \"$t\" && bash \"$t\""],
		});
	}
});

test("Windows uses the official PowerShell installer", () => {
	assert.deepEqual(agyInstallCommand("win32"), {
		command: "powershell.exe",
		args: ["-NoProfile", "-ExecutionPolicy", "Bypass", "-Command", "irm https://antigravity.google/cli/install.ps1 | iex"],
	});
});

test("installer success tells the user to authenticate agy and restart", async () => {
	let seen: unknown;
	const result = await installAgyCli({
		platform: "linux",
		run: async (command) => {
			seen = command;
			return { code: 0, output: "installed" };
		},
		verify: () => true,
	});
	assert.deepEqual(seen, agyInstallCommand("linux"));
	assert.deepEqual(result, { ok: true, output: "installed" });
	assert.match(agyAuthenticationMessage(), /Run `agy`/);
	assert.match(agyAuthenticationMessage(), /Google sign-in/);
	assert.match(agyAuthenticationMessage(), /[Rr]estart pi/);
});

test("installer failure is visible and includes bounded output", async () => {
	const result = await installAgyCli({
		platform: "win32",
		run: async () => ({ code: 1, output: "download failed" }),
	});
	assert.deepEqual(result, { ok: false, error: "download failed" });
});

test("a zero installer exit without a usable agy is a failure with the installer's own tail", async () => {
	const result = await installAgyCli({
		run: async () => ({ code: 0, output: "Notice: 'agy' is already installed at /opt/agy/bin/agy.\nlines in between\n" }),
		verify: () => false,
	});
	assert.match(result.ok ? "" : result.error, /installer finished, but agy is not available/);
	assert.match(result.ok ? "" : result.error, /set AGY_BIN/);
	assert.match(result.ok ? "" : result.error, /already installed at \/opt\/agy\/bin\/agy/);
});

test("a failed curl cannot masquerade as a successful pipeline", { skip: process.platform === "win32" }, async () => {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), "agy-install-pipefail-"));
	const curl = path.join(dir, "curl");
	fs.writeFileSync(curl, "#!/usr/bin/env bash\nexit 22\n", { mode: 0o755 });
	const previousPath = process.env.PATH;
	process.env.PATH = `${dir}${path.delimiter}${previousPath ?? ""}`;
	try {
		const result = await installAgyCli({ verify: () => true });
		assert.equal(result.ok, false);
	} finally {
		process.env.PATH = previousPath;
		fs.rmSync(dir, { recursive: true, force: true });
	}
});

test("the downloaded script reaches the consumer as a file, not a pipe", { skip: process.platform === "win32" }, async () => {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), "agy-install-tempfile-"));
	const marker = path.join(dir, "payload-seen");
	fs.writeFileSync(
		path.join(dir, "curl"),
		[
			"#!/usr/bin/env bash",
			'out=""',
			'prev=""',
			'for a in "$@"; do [[ "$prev" == "-o" ]] && out="$a"; prev="$a"; done',
			// The payload is itself a script: the inner `bash "$t"` proves the
			// download arrived on disk as an executable file (issue #19: under
			// curl|bash a consumer exiting early faked a download failure).
			`printf '%s\\n' ${JSON.stringify(`printf payload-ran > ${JSON.stringify(marker)}`)} > "$out"`,
			"",
		].join("\n"),
		{ mode: 0o755 },
	);
	// No bash shim in this dir: a fake bash would catch the shims' own
	// `#!/usr/bin/env bash` lookups and recurse. Only curl is intercepted.
	const previousPath = process.env.PATH;
	process.env.PATH = `${dir}${path.delimiter}${previousPath ?? ""}`;
	try {
		const result = await installAgyCli({ verify: () => true });
		assert.equal(result.ok, true);
		assert.equal(fs.existsSync(marker), true);
	} finally {
		process.env.PATH = previousPath;
		fs.rmSync(dir, { recursive: true, force: true });
	}
});

test("installer timeout kills the whole pipeline", { skip: process.platform === "win32" }, async () => {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), "agy-install-timeout-"));
	const marker = path.join(dir, "orphan-survived");
	const curl = path.join(dir, "curl");
	fs.writeFileSync(curl, `#!/usr/bin/env bash\nsleep 0.2\ntouch ${JSON.stringify(marker)}\n`, { mode: 0o755 });
	const previousPath = process.env.PATH;
	process.env.PATH = `${dir}${path.delimiter}${previousPath ?? ""}`;
	try {
		const result = await installAgyCli({ timeoutMs: 25, verify: () => true });
		assert.equal(result.ok, false);
		assert.match(result.ok ? "" : result.error, /exceeded/);
		await new Promise((resolve) => setTimeout(resolve, 350));
		assert.equal(fs.existsSync(marker), false);
	} finally {
		process.env.PATH = previousPath;
		fs.rmSync(dir, { recursive: true, force: true });
	}
});

test("installer runner exceptions become normal failures", async () => {
	const result = await installAgyCli({
		platform: "linux",
		run: async () => {
			throw new Error("bash not found");
		},
	});
	assert.deepEqual(result, { ok: false, error: "bash not found" });
});
