import { describe, expect, it } from "vitest";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const pkg = join(dirname(fileURLToPath(import.meta.url)), "..");

const EXPECTED_SKILLS = [
  "egm-bootstrap",
  "egm-brainstorm",
  "egm-draft",
  "egm-drift-report",
  "egm-resolve",
  "egm-review",
  "egm-review-loop",
];

const EXPECTED_AGENTS = [
  "bootstrap_orchestrator.md",
  "codebase_details.md",
  "comprehension.md",
  "design_critic.md",
  "implementation_readiness.md",
  "structural.md",
  "style.md",
  "synthesizer.md",
  "zoom_out.md",
];

const EXPECTED_STANDARDS = [
  "feature-spec-standard.md",
  "heilmeier-standard.md",
  "implementation-readiness-standard.md",
  "re-implementation-standard.md",
  "zoom-out-standard.md",
];

function frontmatter(path: string): string {
  const text = readFileSync(path, "utf8");
  const match = /^---\r?\n([\s\S]*?)\r?\n---/.exec(text);
  if (!match) throw new Error(`no frontmatter in ${path}`);
  return match[1];
}

function field(fm: string, name: string): string | undefined {
  return new RegExp(`^${name}:\\s*(.+)$`, "m").exec(fm)?.[1];
}

describe("pi-egm vendored content", () => {
  it("ships exactly the upstream skill set", () => {
    const dirs = readdirSync(join(pkg, "skills")).sort();
    expect(dirs).toEqual([...EXPECTED_SKILLS].sort());
    for (const dir of dirs) {
      expect(existsSync(join(pkg, "skills", dir, "SKILL.md")), dir).toBe(true);
    }
  });

  it("declares valid, Pi-compatible frontmatter in every skill", () => {
    for (const dir of EXPECTED_SKILLS) {
      const fm = frontmatter(join(pkg, "skills", dir, "SKILL.md"));
      expect(field(fm, "name"), dir).toBe(dir);
      expect(field(fm, "license"), dir).toBe("Apache-2.0");
      expect(field(fm, "disable-model-invocation"), dir).toBe("true");
      const description = field(fm, "description");
      expect(description, dir).toBeTruthy();
      expect(description!.length, dir).toBeLessThanOrEqual(1024);
    }
  });

  it("points every skill at the Pi harness notes", () => {
    for (const dir of EXPECTED_SKILLS) {
      const text = readFileSync(join(pkg, "skills", dir, "SKILL.md"), "utf8");
      expect(text, dir).toContain("../../PI.md");
    }
  });

  it("ships exactly the nine goldfish personas", () => {
    const files = readdirSync(join(pkg, "agents")).sort();
    expect(files).toEqual([...EXPECTED_AGENTS].sort());
    for (const file of files) {
      const fm = frontmatter(join(pkg, "agents", file));
      expect(field(fm, "name"), file).toMatch(/^egm-/);
      expect(field(fm, "description"), file).toBeTruthy();
    }
  });

  it("ships the document standards and execution instructions", () => {
    for (const file of EXPECTED_STANDARDS) {
      expect(existsSync(join(pkg, "resources", "document_standards", file)), file).toBe(true);
    }
    expect(existsSync(join(pkg, "resources", "execution_instructions.md"))).toBe(true);
  });

  it("resolves every agents/ and resources/ reference in skills and PI.md", () => {
    const sources = [
      ...EXPECTED_SKILLS.map((dir) => join(pkg, "skills", dir, "SKILL.md")),
      join(pkg, "PI.md"),
    ];
    const refs = new Set<string>();
    for (const source of sources) {
      const text = readFileSync(source, "utf8");
      for (const m of text.matchAll(/(?:agents|resources)\/[a-z0-9_-]+(?:\/[a-z0-9_-]+)*\.md/g)) {
        refs.add(m[0]);
      }
    }
    expect(refs.size).toBeGreaterThan(0);
    for (const ref of refs) {
      expect(existsSync(join(pkg, ref)), ref).toBe(true);
    }
  });
});

describe("pi-egm package surface", () => {
  it("declares pi skills and extensions manifests that exist", () => {
    const manifest = JSON.parse(readFileSync(join(pkg, "package.json"), "utf8"));
    const skills: string[] = manifest.pi.skills;
    const extensions: string[] = manifest.pi.extensions;
    expect(skills).toEqual(["./skills"]);
    expect(extensions).toEqual(["./extensions"]);
    for (const p of [...skills, ...extensions]) {
      expect(existsSync(join(pkg, p)), p).toBe(true);
    }
    expect(manifest.license).toBe("Apache-2.0");
  });

  it("ships the command extension", () => {
    expect(existsSync(join(pkg, "extensions", "index.ts"))).toBe(true);
  });
});
