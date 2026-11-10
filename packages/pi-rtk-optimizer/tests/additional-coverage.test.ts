import assert from "node:assert/strict";
import { existsSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";

import { clearOutputMetrics, getOutputMetricsSummary, trackOutputSavings } from "../lib/output-metrics";
import { mock, runTest } from "./helpers";
import { matchesCommandPatterns, normalizeCommandForDetection } from "../lib/techniques/command-detection";
import { compactPath } from "../lib/techniques/path-utils";
import { filterAggressive } from "../lib/techniques/source";
import { aggregateTestOutput, isTestCommand } from "../lib/techniques/test-output";
import { applyWindowsBashCompatibilityFixes } from "../lib/windows-command-helpers";
import { applyRewrittenCommandShellSafetyFixups } from "../lib/rewrite-pipeline-safety";
import { applyRtkCommandEnvironment } from "../lib/rtk-command-environment";
import { sanitizeStreamingBashExecutionResult } from "../lib/tool-execution-sanitizer";

mock.module("@earendil-works/pi-coding-agent", {
	namedExports: {
		getAgentDir: () => "/tmp/.pi/agent",
	},
});

const {
	ensureConfigExists,
	getRtkIntegrationConfigPath,
	loadRtkIntegrationConfig,
	normalizeRtkIntegrationConfig,
	saveRtkIntegrationConfig,
} = await import("../lib/config-store");

function makeTempConfigPath(): string {
	return `${getRtkIntegrationConfigPath()}.test-${Date.now()}-${Math.random().toString(16).slice(2)}.json`;
}

function cleanupFile(path: string): void {
	for (const candidate of [path, `${path}.tmp`]) {
		try {
			if (existsSync(candidate)) {
				unlinkSync(candidate);
			}
		} catch {
			// Ignore cleanup failures in tests.
		}
	}
}

runTest("config-store normalizes invalid values and clamps numeric ranges", () => {
	const normalized = normalizeRtkIntegrationConfig({
		enabled: "yes",
		mode: "invalid",
		rewriteGitGithub: false,
		outputCompaction: {
			stripAnsi: false,
			sourceCodeFilteringEnabled: "sometimes",
			sourceCodeFiltering: "extreme",
			truncate: {
				enabled: true,
				maxChars: 12,
			},
			smartTruncate: {
				enabled: true,
				maxLines: 999_999,
			},
			trackSavings: false,
		},
	});

	assert.equal(normalized.enabled, true);
	assert.equal(normalized.mode, "rewrite");
	assert.equal(Object.hasOwn(normalized, "rewriteGitGithub"), false);
	assert.equal(normalized.outputCompaction.stripAnsi, false);
	assert.equal(normalized.outputCompaction.readCompaction.enabled, true);
	assert.equal(normalized.outputCompaction.sourceCodeFilteringEnabled, true);
	assert.equal(normalized.outputCompaction.sourceCodeFiltering, "minimal");
	assert.equal(normalized.outputCompaction.truncate.maxChars, 1_000);
	assert.equal(normalized.outputCompaction.smartTruncate.maxLines, 4_000);
	assert.equal(normalized.outputCompaction.trackSavings, false);
});

runTest("config-store uses safer read defaults when readCompaction is explicit", () => {
	const normalized = normalizeRtkIntegrationConfig({
		outputCompaction: {
			readCompaction: { enabled: false },
		},
	});

	assert.equal(normalized.outputCompaction.readCompaction.enabled, false);
	assert.equal(normalized.outputCompaction.sourceCodeFilteringEnabled, false);
	assert.equal(normalized.outputCompaction.sourceCodeFiltering, "none");
	assert.equal(normalized.outputCompaction.smartTruncate.enabled, false);
});

runTest("config-store can ensure, save, and reload isolated config files", () => {
	const tempPath = makeTempConfigPath();
	cleanupFile(tempPath);

	try {
		const ensured = ensureConfigExists(tempPath);
		assert.equal(ensured.error, undefined);
		assert.equal(existsSync(tempPath), true);

		const defaultLoad = loadRtkIntegrationConfig(tempPath);
		assert.equal(defaultLoad.warning, undefined);
		assert.equal(defaultLoad.config.mode, "rewrite");
		assert.equal(defaultLoad.config.outputCompaction.readCompaction.enabled, false);

		const saved = saveRtkIntegrationConfig(
			{
				...defaultLoad.config,
				mode: "suggest",
				outputCompaction: {
					...defaultLoad.config.outputCompaction,
					truncate: {
						...defaultLoad.config.outputCompaction.truncate,
						maxChars: 250_000,
					},
				},
			},
			tempPath,
		);
		assert.equal(saved.success, true);

		const reloaded = loadRtkIntegrationConfig(tempPath);
		assert.equal(reloaded.config.mode, "suggest");
		assert.equal(reloaded.config.outputCompaction.truncate.maxChars, 200_000);
		assert.ok(readFileSync(tempPath, "utf-8").endsWith("\n"));
	} finally {
		cleanupFile(tempPath);
	}
});

runTest("config-store falls back to defaults when JSON is invalid", () => {
	const tempPath = makeTempConfigPath();
	cleanupFile(tempPath);

	try {
		writeFileSync(tempPath, "{not valid json", "utf-8");
		const loaded = loadRtkIntegrationConfig(tempPath);
		assert.equal(loaded.config.mode, "rewrite");
		assert.ok((loaded.warning ?? "").includes(tempPath));
		assert.ok((loaded.warning ?? "").includes("Failed to parse"));
	} finally {
		cleanupFile(tempPath);
	}
});

runTest("config-store malformed-file defaults are isolated from caller mutation", () => {
	const tempPath = makeTempConfigPath();
	cleanupFile(tempPath);

	try {
		writeFileSync(tempPath, "{not valid json", "utf-8");
		const firstLoad = loadRtkIntegrationConfig(tempPath);
		firstLoad.config.outputCompaction.truncate.maxChars = 42_424;
		firstLoad.config.outputCompaction.readCompaction.enabled = true;

		const secondLoad = loadRtkIntegrationConfig(tempPath);

		assert.equal(secondLoad.config.outputCompaction.truncate.maxChars, 12_000);
		assert.equal(secondLoad.config.outputCompaction.readCompaction.enabled, false);
	} finally {
		cleanupFile(tempPath);
	}
});

runTest("output metrics summarize tracked savings and clear state", () => {
	clearOutputMetrics();
	assert.equal(getOutputMetricsSummary(), "RTK output compaction metrics: no data yet.");

	const first = trackOutputSavings("1234567890", "12345", "bash", ["ansi", "truncate"]);
	assert.equal(first.tool, "bash");
	assert.equal(first.techniques, "ansi,truncate");
	assert.equal(first.savingsPercent, 50);

	trackOutputSavings("123456", "1234", "read", []);
	const summary = getOutputMetricsSummary();
	assert.ok(summary.includes("calls=2, saved=7 chars (43.8%)"));
	assert.ok(summary.includes("- bash: 1 calls, saved 5 chars (50.0%)"));
	assert.ok(summary.includes("- read: 1 calls, saved 2 chars (33.3%)"));

	clearOutputMetrics();
	assert.equal(getOutputMetricsSummary(), "RTK output compaction metrics: no data yet.");
});

runTest("aggressive source filtering ignores string and inline comment braces while tracking implementation blocks", () => {
	const withLiteralBrace = [
		"function first() {",
		'  const value = "{";',
		"  return value;",
		"}",
		"function second() {",
		"  return true;",
		"}",
	].join("\n");
	const withoutLiteralBrace = [
		"function first() {",
		'  const value = "plain";',
		"  return value;",
		"}",
		"function second() {",
		"  return true;",
		"}",
	].join("\n");
	const withInlineCommentBrace = [
		"function first() {",
		"  const value = 1; // {",
		"  return value;",
		"}",
		"function second() {",
		"  return true;",
		"}",
	].join("\n");
	const withoutInlineCommentBrace = [
		"function first() {",
		"  const value = 1; // no brace",
		"  return value;",
		"}",
		"function second() {",
		"  return true;",
		"}",
	].join("\n");

	assert.equal(filterAggressive(withLiteralBrace, "typescript"), filterAggressive(withoutLiteralBrace, "typescript"));
	assert.equal(filterAggressive(withInlineCommentBrace, "typescript"), filterAggressive(withoutInlineCommentBrace, "typescript"));
});

runTest("test output fallback counts unicode pass and fail symbols", () => {
	const result = aggregateTestOutput("✓ creates user\n✔ updates user\n✕ deletes user\n✗ archives user\n", "bun test");

	assert.ok(result?.includes("PASS: 2 passed"));
	assert.ok(result?.includes("FAIL: 2 failed"));
});

// Vitest 5.x prints "Tests  4 failed | 39 passed (43)": failed first, pipe-separated.
// The generic comma-order patterns misread it and hid real failures behind a PASS line.
runTest("test output parses vitest 5 summary with failures before passed", () => {
	const result = aggregateTestOutput(
		" Tests  4 failed | 39 passed (43) \n",
		"npx vitest run",
	);

	assert.ok(result?.includes("PASS: 39 passed"));
	assert.ok(result?.includes("FAIL: 4 failed"));
});

runTest("test output parses vitest 5 summary with skipped", () => {
	const result = aggregateTestOutput(" Tests  2 passed | 1 skipped (3) \n", "npx vitest run");

	assert.ok(result?.includes("PASS: 2 passed"));
	assert.ok(result?.includes("SKIP: 1 skipped"));
	assert.ok(!result?.includes("FAIL:"));
});

// Vitest omits the passed token entirely when zero tests pass ("Tests  4 failed (4)").
runTest("test output parses vitest 5 summary with failures only", () => {
	const result = aggregateTestOutput(" Tests  4 failed (4) \n", "npx vitest run");

	assert.ok(result?.includes("PASS: 0 passed"));
	assert.ok(result?.includes("FAIL: 4 failed"));
});

// The vitest pattern requires the "(total)" suffix, so comma-form summaries
// must still fall through to the generic comma-order patterns.
runTest("test output keeps comma-form summaries on the generic patterns", () => {
	const result = aggregateTestOutput("Tests  2 passed, 1 failed\n", "npm test");

	assert.ok(result?.includes("PASS: 2 passed"));
	assert.ok(result?.includes("FAIL: 1 failed"));
});

// A failed exit whose output parsed as 0 failures must not read as a clean pass.
runTest("test output warns when exit failed but no failures parsed", () => {
	const result = aggregateTestOutput(" Tests  12 passed (12) \n", "npx vitest run", true);

	assert.ok(result?.includes("FAIL: command exited with a failure status"));
	assert.ok(result?.includes("WARNING"));
	assert.ok(result?.includes("PASS: 12 passed"));
});

runTest("test output stays clean when exit passed with zero parsed failures", () => {
	const result = aggregateTestOutput(" Tests  12 passed (12) \n", "npx vitest run", false);

	assert.ok(!result?.includes("WARNING"));
});

// node:test spec reporter: the summary block is ground truth. Before it was
// recognized, every run fell to line counting and the summary line "ℹ fail 0"
// itself matched the fallback fail pattern - a fully green run printed a
// phantom "FAIL: 1 failed" and the exit-status warning stayed silent.
runTest("test output trusts node:test spec summary over fail-titled tests", () => {
	const output = [
		"✔ depth config fails open on malformed values (1.3ms)",
		"✔ failover chain tries each upstream once (0.2ms)",
		"ℹ tests 2",
		"ℹ suites 0",
		"ℹ pass 2",
		"ℹ fail 0",
		"ℹ cancelled 0",
		"ℹ skipped 0",
		"ℹ duration_ms 117.8",
	].join("\n");

	const result = aggregateTestOutput(output, "npm test");

	assert.ok(result?.includes("PASS: 2 passed"));
	assert.ok(!result?.includes("FAIL:"));
});

// The TAP reporter prefixes the same summary with "#". Also proves bare
// `node --test` is detected as a test command.
runTest("test output trusts node:test TAP summary under node --test", () => {
	const output = [
		"TAP version 13",
		"ok 1 - depth config fails open",
		"not ok 2 - failover chain",
		"1..2",
		"# tests 2",
		"# pass 1",
		"# fail 1",
	].join("\n");

	const result = aggregateTestOutput(output, "node --test");

	assert.ok(result?.includes("PASS: 1 passed"));
	assert.ok(result?.includes("FAIL: 1 failed"));
});

// node:test repeats each failure name under "✖ failing tests:"; the repeats
// must not crowd the five-slot failure list, and the repeated block (which
// carries the assertion detail) should win over the name-only inline block.
runTest("test output surfaces node:test failures once with their details", () => {
	const output = [
		"✔ passes with defaults (1.2ms)",
		"✖ rejects malformed config (1.5ms)",
		"ℹ tests 2",
		"ℹ pass 1",
		"ℹ fail 1",
		"",
		"✖ failing tests:",
		"✖ rejects malformed config (1.5ms)",
		"  AssertionError [ERR_ASSERTION]: 1 !== 2",
	].join("\n");

	const result = aggregateTestOutput(output, "npm test");

	assert.ok(result?.includes("FAIL: 1 failed"));
	assert.ok(result?.includes("AssertionError"));
	assert.equal(result?.split("rejects malformed config").length ?? 0, 2);
});

// The corrected fallback anchors fail evidence to line starts so prose and
// hyphenated titles cannot inflate the count; Go's per-test failures and
// summary lines must survive that tightening.
runTest("test output fallback still counts go per-test failures", () => {
	const output = [
		"=== RUN TestSplit",
		"--- FAIL: TestSplit (0.00s)",
		"    split_test.go:12: got 3, want 2",
		"FAIL",
		"FAIL\texample.com/pkg 0.01s",
	].join("\n");

	const result = aggregateTestOutput(output, "go test ./...");

	assert.ok(result?.includes("FAIL: 3 failed"));
});

runTest("test output fallback ignores hyphenated fail titles", () => {
	const result = aggregateTestOutput("✓ depth config fail-open on malformed values\n✓ warns on empty config\n", "bun test");

	assert.ok(result?.includes("PASS: 2 passed"));
	assert.ok(!result?.includes("FAIL:"));
});

runTest("test output fallback ignores mid-line standalone fail words", () => {
	const result = aggregateTestOutput("✓ can fail gracefully under load\n", "bun test");

	assert.ok(result?.includes("PASS: 1 passed"));
	assert.ok(!result?.includes("FAIL:"));
});

// Stray summary-lookalike lines logged by tests must not override a vitest run.
runTest("test output prefers vitest summary over stray node:test summary lines", () => {
	const output = [
		"logged: ℹ pass 99",
		" Tests  4 failed | 39 passed (43) ",
	].join("\n");

	const result = aggregateTestOutput(output, "npx vitest run");

	assert.ok(result?.includes("PASS: 39 passed"));
	assert.ok(result?.includes("FAIL: 4 failed"));
});

// An all-zero summary (a cargo binary with zero tests, printed first) must not
// stop the line scan: later binaries' results still need counting. The scan
// counts each binary's summary "ok" too, so the pass count over-reports by the
// number of green result lines — still closer to truth than a hard 0.
runTest("test output scans past an all-zero cargo summary for later binaries", () => {
	const output = [
		"running 0 tests",
		"test result: ok. 0 passed; 0 failed; 0 ignored; 0 measured;",
		"     Running unittests src/lib.rs",
		"running 1 test",
		"test add_works ... ok",
		"test result: ok. 1 passed; 0 failed; 0 ignored;",
	].join("\n");

	const result = aggregateTestOutput(output, "cargo test");

	assert.ok(result?.includes("PASS: 3 passed"));
});

runTest("command detection recognizes node --test behind node flags", () => {
	assert.ok(isTestCommand("node --import tsx --test"));
	assert.ok(isTestCommand("node --experimental-strip-types --test"));
});

// TAP reporters print failures as "not ok N - name"; the counts alone are not
// enough, the failure list must carry the name too.
runTest("test output surfaces TAP not ok failures", () => {
	const output = [
		"TAP version 13",
		"ok 1 - passes with defaults",
		"not ok 2 - failover chain",
		"1..2",
		"# tests 2",
		"# pass 1",
		"# fail 1",
	].join("\n");

	const result = aggregateTestOutput(output, "npm test");

	assert.ok(result?.includes("FAIL: 1 failed"));
	assert.ok(result?.includes("failover chain"));
});

runTest("command detection ignores env prefixes, blank lines, and chained suffixes", () => {
	assert.equal(normalizeCommandForDetection("NODE_ENV=test FOO=bar npm test && echo done"), "npm test");
	assert.equal(normalizeCommandForDetection("\n\n PYTHONPATH=src git status\n echo later"), "git status");
	assert.equal(normalizeCommandForDetection("   "), null);
	assert.equal(matchesCommandPatterns("CI=1 bun test | head -5", [/^bun test/]), true);
	assert.equal(matchesCommandPatterns("echo hello", [/^bun test/]), false);
});

runTest("RTK command environment preserves explicit leading RTK_DB_PATH overrides", () => {
	const command = 'RTK_DB_PATH="/custom/history.db" rtk git diff';
	assert.equal(applyRtkCommandEnvironment(command), command);

	const singleQuotedCommand = "RTK_DB_PATH='/custom/it'\\''s/history.db' rtk git diff";
	assert.equal(applyRtkCommandEnvironment(singleQuotedCommand), singleQuotedCommand);

	const exportedCommand = 'export RTK_DB_PATH="/custom/history.db"; rtk git diff';
	assert.equal(applyRtkCommandEnvironment(exportedCommand), exportedCommand);
});

runTest("RTK command environment respects inherited RTK_DB_PATH values", () => {
	const previousRtkDbPath = process.env.RTK_DB_PATH;
	const command = "rtk git status";

	try {
		process.env.RTK_DB_PATH = "/persistent/shared/history.db";

		assert.equal(applyRtkCommandEnvironment(command), command);
	} finally {
		if (previousRtkDbPath === undefined) {
			delete process.env.RTK_DB_PATH;
		} else {
			process.env.RTK_DB_PATH = previousRtkDbPath;
		}
	}
});

runTest("RTK command environment ignores blank inherited RTK_DB_PATH values", () => {
	const previousRtkDbPath = process.env.RTK_DB_PATH;

	try {
		process.env.RTK_DB_PATH = "   ";

		assert.match(applyRtkCommandEnvironment("rtk git status"), /^export RTK_DB_PATH=/);
	} finally {
		if (previousRtkDbPath === undefined) {
			delete process.env.RTK_DB_PATH;
		} else {
			process.env.RTK_DB_PATH = previousRtkDbPath;
		}
	}
});

runTest("RTK command environment single-quotes hostile temp paths", () => {
	const previousTmpDir = process.env.TMPDIR;
	const previousTmp = process.env.TMP;
	const previousTemp = process.env.TEMP;
	const hostilePath = process.platform === "win32" ? "C:\\Temp\\$(touch owned)`bad`'dir" : "/tmp/$(touch owned)`bad`'dir";

	try {
		process.env.TMPDIR = hostilePath;
		process.env.TMP = hostilePath;
		process.env.TEMP = hostilePath;

		const rewritten = applyRtkCommandEnvironment("rtk git status");
		assert.ok(rewritten.startsWith("export RTK_DB_PATH='"));
		assert.ok(rewritten.includes("$(touch owned)`bad`'\\''dir"));
		assert.ok(rewritten.endsWith("; rtk git status"));
		assert.equal(/^export RTK_DB_PATH=\"/.test(rewritten), false);
	} finally {
		process.env.TMPDIR = previousTmpDir;
		process.env.TMP = previousTmp;
		process.env.TEMP = previousTemp;
	}
});

runTest("path compaction preserves the tail and handles Windows separators", () => {
	const unixPath = "/Users/example/projects/pi-rtk-optimizer/src/techniques/path-utils.ts";
	const compactUnixPath = compactPath(unixPath, 28);
	assert.ok(compactUnixPath.length <= 28);
	assert.ok(compactUnixPath.endsWith("path-utils.ts"));
	assert.ok(compactUnixPath.includes("/"));

	const windowsPath = "C:\\Users\\Administrator\\Documents\\pi-rtk-optimizer\\src\\windows-command-helpers.ts";
	const compactWindowsPath = compactPath(windowsPath, 30);
	assert.ok(compactWindowsPath.length <= 30);
	assert.equal(compactWindowsPath.includes("\\"), true);
	assert.ok(compactWindowsPath.endsWith("windows-command-helpers.ts"));

	assert.equal(compactPath("src/file.ts", 40), "src/file.ts");
});

runTest("windows bash compatibility rewrites only when the runtime is Windows", () => {
	const command = "cd /d C:\\Users\\Administrator\\project && python script.py";
	const fixed = applyWindowsBashCompatibilityFixes(command, "win32");
	assert.deepEqual(fixed.applied, ["cd-/d", "python-utf8"]);
	assert.equal(
		fixed.command,
		'PYTHONIOENCODING=utf-8 cd "C:/Users/Administrator/project" && python script.py',
	);

	const unchanged = applyWindowsBashCompatibilityFixes(command, "linux");
	assert.deepEqual(unchanged.applied, []);
	assert.equal(unchanged.command, command);

	const alreadyUtf8 = applyWindowsBashCompatibilityFixes("PYTHONIOENCODING=utf-8 python script.py", "win32");
	assert.deepEqual(alreadyUtf8.applied, []);
	assert.equal(alreadyUtf8.command, "PYTHONIOENCODING=utf-8 python script.py");
});

runTest("windows bash compatibility rewrites compound cd slash-d operators", () => {
	assert.equal(
		applyWindowsBashCompatibilityFixes("cd /d C:\\work || echo failed", "win32").command,
		'cd "C:/work" || echo failed',
	);
	assert.equal(
		applyWindowsBashCompatibilityFixes("cd /d C:\\work ; echo done", "win32").command,
		'cd "C:/work" ; echo done',
	);
	assert.equal(
		applyWindowsBashCompatibilityFixes("cd /d C:\\work | cat", "win32").command,
		'cd "C:/work" | cat',
	);
	assert.equal(
		applyWindowsBashCompatibilityFixes('cd /d "C:\\work space" || echo failed', "win32").command,
		'cd "C:/work space" || echo failed',
	);
});

runTest("rewrite pipeline safety buffers rewritten Windows producer commands", () => {
	const rewritten = applyRewrittenCommandShellSafetyFixups("rtk git diff | grep TODO", "win32");
	assert.ok(rewritten.includes('mktemp'));
	assert.ok(rewritten.includes('trap'));
	assert.ok(rewritten.includes('rtk git diff > "$__pi_rtk_pipe_tmp"'));
	assert.ok(rewritten.includes('(grep TODO) < "$__pi_rtk_pipe_tmp"'));

	assert.equal(
		applyRewrittenCommandShellSafetyFixups("rtk git diff | grep TODO", "linux"),
		"rtk git diff | grep TODO",
	);
	assert.equal(applyRewrittenCommandShellSafetyFixups("git diff | grep TODO", "win32"), "git diff | grep TODO");
});

runTest("rewrite pipeline safety buffers leading pipelines before compound suffixes", () => {
	const andCommand = applyRewrittenCommandShellSafetyFixups("rtk git diff | grep TODO && echo done", "win32");
	assert.ok(andCommand.includes('(grep TODO) < "$__pi_rtk_pipe_tmp"'));
	assert.ok(andCommand.endsWith("&& echo done"));

	const orCommand = applyRewrittenCommandShellSafetyFixups("rtk git diff | grep TODO || echo none", "win32");
	assert.ok(orCommand.includes('(grep TODO) < "$__pi_rtk_pipe_tmp"'));
	assert.ok(orCommand.endsWith("|| echo none"));

	const semicolonCommand = applyRewrittenCommandShellSafetyFixups("rtk git diff | grep TODO; echo done", "win32");
	assert.ok(semicolonCommand.includes('(grep TODO) < "$__pi_rtk_pipe_tmp"'));
	assert.ok(semicolonCommand.endsWith("; echo done"));
});

runTest("rewrite pipeline safety keeps exported RTK_DB_PATH on rewritten producer commands", () => {
	const envScopedCommand = applyRtkCommandEnvironment("rtk git diff agent/extensions/pi-multi-auth/account-manager.ts | head -200");
	const rewritten = applyRewrittenCommandShellSafetyFixups(envScopedCommand, "win32");

	assert.ok(rewritten.startsWith("export RTK_DB_PATH="));
	assert.equal(rewritten.startsWith("RTK_DB_PATH="), false);
	assert.ok(rewritten.includes("; {"));
	assert.ok(
		rewritten.includes('rtk git diff agent/extensions/pi-multi-auth/account-manager.ts > "$__pi_rtk_pipe_tmp"'),
	);
	assert.ok(rewritten.includes('(head -200) < "$__pi_rtk_pipe_tmp"'));

	assert.equal(applyRewrittenCommandShellSafetyFixups(envScopedCommand, "linux"), envScopedCommand);
});

runTest("rewrite pipeline safety buffers explicit RTK_DB_PATH export preludes", () => {
	const command = 'export RTK_DB_PATH="/custom/history.db"; rtk git diff | head -200';
	const rewritten = applyRewrittenCommandShellSafetyFixups(command, "win32");

	assert.ok(rewritten.startsWith('export RTK_DB_PATH="/custom/history.db"; {'));
	assert.ok(rewritten.includes('rtk git diff > "$__pi_rtk_pipe_tmp"'));
	assert.ok(rewritten.includes('(head -200) < "$__pi_rtk_pipe_tmp"'));

	assert.equal(applyRewrittenCommandShellSafetyFixups(command, "linux"), command);
});

runTest("RTK command environment uses export prelude for shell compound commands", () => {
	const rewritten = applyRtkCommandEnvironment('for d in a b; do echo "$d"; done');
	assert.ok(/^export RTK_DB_PATH=/.test(rewritten));
	assert.ok(/; for d in a b; do echo "\$d"; done$/.test(rewritten));
});

runTest("streaming sanitizer strips ANSI codes and preserves non-text blocks", () => {
	const ansiResult = {
		content: [
			{ type: "text", text: "\x1B[32mworking tree clean\x1B[0m\n" },
			{ type: "image", url: "ignored" },
		],
	};
	const ansiSanitization = sanitizeStreamingBashExecutionResult(ansiResult, "rtk git status");
	assert.equal(ansiSanitization.changed, true);
	assert.equal(
		((ansiSanitization.result as typeof ansiResult).content[0] as { text: string }).text,
		"working tree clean\n",
	);
	assert.equal((ansiResult.content[0] as { text: string }).text, "\x1B[32mworking tree clean\x1B[0m\n");
	assert.deepEqual((ansiSanitization.result as typeof ansiResult).content[1], { type: "image", url: "ignored" });

	const plainResult = {
		content: [
			{
				type: "text",
				text: "[rtk] warning: builtin filters: parse failure\n\nworking tree clean\n",
			},
		],
	};
	const plainSanitization = sanitizeStreamingBashExecutionResult(plainResult, "rtk git status");
	assert.equal(plainSanitization.changed, false);
	assert.equal(plainSanitization.result, plainResult);
	assert.equal(
		(plainResult.content[0] as { text: string }).text,
		"[rtk] warning: builtin filters: parse failure\n\nworking tree clean\n",
	);
});

console.log("All additional coverage tests passed.");
