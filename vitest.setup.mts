// getAgentDir() prefers PI_CODING_AGENT_DIR over HOME, so an exported value
// on a developer machine (or CI runner) would point every suite that does not
// pin its own roots at a real agent dir. Pin a throwaway dir per worker;
// suites needing a specific layout set their own value and restore it.
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

process.env.PI_CODING_AGENT_DIR = mkdtempSync(join(tmpdir(), "vitest-agentdir-"));
