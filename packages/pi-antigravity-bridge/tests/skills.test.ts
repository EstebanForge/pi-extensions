// Skills discovery tests: pin scanSkills to pi's documented locations and
// per-location rules (pi docs/skills.md "Locations"). Real home is never
// touched: projectDir, home, and agentDir are injected tmp dirs.
//
// Pi-style fixtures use the vanilla layout (<home>/.pi/agent as agentDir) so
// the assertions also pin that layout; the dedicated agentDir test pins the
// relocated case (PI_CODING_AGENT_DIR-style setups).

import { test } from "vitest";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { scanSkills, skillLocations } from "../src/skills.js";

function tmp(): string {
	return fs.mkdtempSync(path.join(os.tmpdir(), "agy-skills-"));
}

/** A tmp home whose agentDir sits at the vanilla <home>/.pi/agent. */
function homeWithAgentDir(): { home: string; agentDir: string } {
	const home = tmp();
	return { home, agentDir: path.join(home, ".pi", "agent") };
}

const SKILL_MD = (name: string, description: string) =>
	`---\nname: ${name}\ndescription: ${description}\n---\n\n# ${name}\n`;

function writeDirSkill(root: string, rel: string, name = path.basename(rel), description = `${name} does things`): void {
	const dir = path.join(root, rel);
	fs.mkdirSync(dir, { recursive: true });
	fs.writeFileSync(path.join(dir, "SKILL.md"), SKILL_MD(name, description));
}

function writeMdSkill(root: string, file: string, name: string, description = `${name} does things`): void {
	fs.mkdirSync(path.dirname(path.join(root, file)), { recursive: true });
	fs.writeFileSync(path.join(root, file), SKILL_MD(name, description));
}

test("skills: global ~/.agents/skills grouping folders are discovered recursively", () => {
	const { home, agentDir } = homeWithAgentDir();
	writeDirSkill(path.join(home, ".agents", "skills"), "work/deployskill");
	const names = scanSkills({ home, agentDir }).map((s) => s.name);
	assert.ok(names.includes("deployskill"));
});

test("skills: agents-style ignores root .md, discovers grouping-folder .md with frontmatter", () => {
	const { home, agentDir } = homeWithAgentDir();
	const root = path.join(home, ".agents", "skills");
	writeMdSkill(root, "loose.md", "loose-skill"); // root .md: ignored
	writeMdSkill(root, "work/notes.md", "notes"); // nested .md: discovered
	fs.mkdirSync(path.join(root, "work"), { recursive: true });
	fs.writeFileSync(path.join(root, "work", "nofrontmatter.md"), "# just prose\n"); // no frontmatter: ignored
	const names = scanSkills({ home, agentDir }).map((s) => s.name);
	assert.ok(!names.includes("loose-skill"));
	assert.ok(names.includes("notes"));
	assert.ok(!names.includes("nofrontmatter"));
});

test("skills: pi-style root .md files are individual skills", () => {
	const { home, agentDir } = homeWithAgentDir();
	writeMdSkill(path.join(agentDir, "skills"), "quick-note.md", "quick-note");
	assert.ok(scanSkills({ home, agentDir }).some((s) => s.name === "quick-note"));
});

test("skills: a relocated agent dir is the user skills root (issue #17)", () => {
	const home = tmp();
	const agentDir = path.join(home, ".gentle-shell", "agent"); // not under .pi
	writeMdSkill(path.join(agentDir, "skills"), "relocated.md", "relocated");
	assert.ok(scanSkills({ home, agentDir }).some((s) => s.name === "relocated"));
});

test("skills: entries without a description are not loaded", () => {
	const { home, agentDir } = homeWithAgentDir();
	const root = path.join(home, ".agents", "skills");
	fs.mkdirSync(path.join(root, "undescribed"), { recursive: true });
	fs.writeFileSync(path.join(root, "undescribed", "SKILL.md"), "---\nname: undescribed\n---\nbody\n");
	writeMdSkill(root, "group/blank.md", "blank", "");
	const names = scanSkills({ home, agentDir }).map((s) => s.name);
	assert.ok(!names.includes("undescribed"));
	assert.ok(!names.includes("blank"));
});

test("skills: a skill dir is self-contained, no descent past SKILL.md", () => {
	const { home, agentDir } = homeWithAgentDir();
	const root = path.join(home, ".agents", "skills");
	writeDirSkill(root, "outer");
	writeDirSkill(path.join(root, "outer"), "inner");
	assert.ok(!scanSkills({ home, agentDir }).some((s) => s.name === "inner"));
});

test("skills: project skills dirs, project .agents/skills, and the git-root ancestor walk", () => {
	const container = tmp();
	const repo = path.join(container, "repo");
	const project = path.join(repo, "services", "app");
	fs.mkdirSync(path.join(repo, ".git"), { recursive: true });
	fs.mkdirSync(project, { recursive: true });
	writeMdSkill(path.join(container, ".agents", "skills"), "above-repo.md", "above-repo"); // outside the walk
	writeDirSkill(path.join(repo, ".agents", "skills"), "repo-skill");
	writeDirSkill(path.join(project, ".agents", "skills"), "local-skill");
	writeMdSkill(path.join(project, ".pi", "skills"), "inline.md", "inline");

	const found = scanSkills({ projectDir: project, home: container, agentDir: path.join(container, ".pi", "agent") });
	const names = found.map((s) => s.name);
	assert.ok(names.includes("repo-skill"), "git-root ancestor discovered");
	assert.ok(names.includes("local-skill"), "project .agents/skills discovered");
	assert.ok(names.includes("inline"), "project .pi/skills root .md discovered");
	assert.ok(!names.includes("above-repo"), "walk stops at the git root");
});

test("skills: name collisions keep the first location (pi dir before agents dir)", () => {
	const { home, agentDir } = homeWithAgentDir();
	writeDirSkill(path.join(agentDir, "skills"), "dup", "dup", "from pi dir");
	writeDirSkill(path.join(home, ".agents", "skills"), "dup", "dup", "from agents dir");
	const dup = scanSkills({ home, agentDir }).find((s) => s.name === "dup");
	assert.equal(dup?.description, "from pi dir");
});

test("skills: a UTF-8 BOM does not break frontmatter detection", () => {
	const { home, agentDir } = homeWithAgentDir();
	const root = path.join(home, ".agents", "skills");
	fs.mkdirSync(path.join(root, "bommed"), { recursive: true });
	fs.writeFileSync(path.join(root, "bommed", "SKILL.md"), `\uFEFF${SKILL_MD("bommed", "survives the BOM")}`);
	assert.ok(scanSkills({ home, agentDir }).some((s) => s.name === "bommed"));
});

test("skills: hidden entries are skipped", () => {
	const { home, agentDir } = homeWithAgentDir();
	writeDirSkill(path.join(home, ".agents", "skills"), ".system/skill-creator");
	assert.ok(!scanSkills({ home, agentDir }).some((s) => s.name === "skill-creator"));
});

test("skills: location order is pi global, agents global, then project dirs", () => {
	const { home, agentDir } = homeWithAgentDir();
	const repo = path.join(tmp(), "repo");
	const project = path.join(repo, "proj");
	fs.mkdirSync(path.join(repo, ".git"), { recursive: true });
	fs.mkdirSync(project, { recursive: true });
	const locs = skillLocations({ projectDir: project, home, agentDir }).map((l) => l.dir);
	assert.deepEqual(locs, [
		path.join(agentDir, "skills"),
		path.join(home, ".agents", "skills"),
		path.join(project, ".pi", "skills"),
		path.join(project, ".agents", "skills"),
		path.join(repo, ".agents", "skills"),
	]);
});
