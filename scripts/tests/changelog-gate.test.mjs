// Gates for the release-time changelog check: a version section must exist,
// be non-empty, and [Unreleased] must not carry entries. Pins all three
// historical failure shapes (pi-ask-claude 1.0.3 no section, pi-agentmemory
// 1.1.2 empty section, bridge 1.8.1 everything under [Unreleased]).
import { describe, expect, it } from "vitest";
import { checkChangelog } from "../lib/changelog-gate.mjs";

const stamp = (v, d = "2026-10-13") => `## [${v}] - ${d}`;

describe("checkChangelog", () => {
  it("accepts the bracketed heading variant with entries", () => {
    const text = `# Changelog\n\n${stamp("1.8.2")}\n\n### Fixed\n\n- **A fix.** Why it exists.\n\n## [1.8.1] - 2026-10-12\n\n### Changed\n\n- old\n`;
    expect(checkChangelog(text, "1.8.2")).toEqual([]);
  });

  it("accepts the bare em-dash and parenthesized heading variants", () => {
    expect(checkChangelog("## 1.8.1 — 2026-10-13\n\n- entry\n", "1.8.1")).toEqual([]);
    expect(checkChangelog("## 1.1.2 (2026-10-08)\n\n- entry\n", "1.1.2")).toEqual([]);
  });

  it("matches the version exactly (1.8.1 is not 1.8.10)", () => {
    const text = `${stamp("1.8.10")}\n\n- entry\n`;
    expect(checkChangelog(text, "1.8.1").join("\n")).toContain('no "## [1.8.1]');
    expect(checkChangelog(text, "1.8.10")).toEqual([]);
  });

  it("fails when the target version has no section (pi-ask-claude 1.0.3)", () => {
    const text = `${stamp("1.0.2")}\n\n- old\n`;
    expect(checkChangelog(text, "1.0.3").join("\n")).toContain('no "## [1.0.3]');
  });

  it("fails when the target section exists but is empty (pi-agentmemory 1.1.2)", () => {
    const text = `${stamp("1.1.2")}\n\n## [Unreleased]\n\n### Changed\n\n- real entry\n`;
    const problems = checkChangelog(text, "1.1.2");
    expect(problems.join("\n")).toContain("empty");
  });

  it("fails when entries still sit under [Unreleased] (bridge 1.8.1)", () => {
    const text = `## [Unreleased]\n\n### Changed\n\n- **The fix.** Body.\n\n${stamp("1.8.0")}\n\n- old\n`;
    const problems = checkChangelog(text, "1.8.1");
    expect(problems.join("\n")).toContain("Unreleased");
  });

  it("accepts an Unreleased heading with only subheading scaffolding", () => {
    const text = `## [Unreleased]\n\n### Changed\n\n${stamp("1.0.1")}\n\n- entry\n`;
    expect(checkChangelog(text, "1.0.1")).toEqual([]);
  });

  it("accepts a changelog with no Unreleased heading at all", () => {
    expect(checkChangelog(`${stamp("1.0.1")}\n\n- entry\n`, "1.0.1")).toEqual([]);
  });

  it("fails on duplicate sections for the target version", () => {
    const text = `${stamp("1.0.1")}\n\n- a\n\n${stamp("1.0.1")}\n\n- b\n`;
    expect(checkChangelog(text, "1.0.1")).toContainEqual(expect.stringContaining("twice"));
  });

  it("requires a real date, not a placeholder", () => {
    expect(checkChangelog("## [1.0.1] - TBD\n\n- entry\n", "1.0.1")).toContainEqual(
      expect.stringContaining("date"),
    );
  });

  it("ignores headings inside fenced code blocks", () => {
    const text = `${stamp("1.0.1")}\n\n\`\`\`\n## [9.9.9] - 2020-01-01\n\`\`\`\n\n- entry\n`;
    expect(checkChangelog(text, "1.0.1")).toEqual([]);
  });

  it("handles CRLF line endings", () => {
    const text = `${stamp("1.0.1")}\r\n\r\n- entry\r\n`;
    expect(checkChangelog(text, "1.0.1")).toEqual([]);
  });

  it("counts a section holding only a code block as empty", () => {
    const text = `${stamp("1.0.1")}\n\n\`\`\`\nnotes\n\`\`\`\n`;
    expect(checkChangelog(text, "1.0.1").join("\n")).toContain("is empty");
  });

  it("ignores tilde fences", () => {
    const text = `## [Unreleased]\n\n~~~\nscratch\n~~~\n\n${stamp("1.0.1")}\n\n- entry\n`;
    expect(checkChangelog(text, "1.0.1")).toEqual([]);
  });

  it("sees entries under a decorated Unreleased heading", () => {
    const text = `## [Unreleased] - next\n\n- pending\n\n${stamp("1.0.1")}\n\n- entry\n`;
    expect(checkChangelog(text, "1.0.1").join("\n")).toContain("Unreleased");
  });

  it("does not confuse a prerelease heading with its release version", () => {
    const text = `## [1.0.1-rc.1] - 2026-10-01\n\n- rc\n\n${stamp("1.0.1")}\n\n- final\n`;
    expect(checkChangelog(text, "1.0.1")).toEqual([]);
  });
});
