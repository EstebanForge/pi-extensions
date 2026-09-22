#!/usr/bin/env node
// Fleet release: bump root version, sync workspaces, commit, tag.
// Publishing stays separate: npm run publish
import { execSync } from "node:child_process";
import { readFileSync } from "node:fs";

const bump = process.argv[2];
if (!bump || !/^(patch|minor|major|\d+\.\d+\.\d+)$/.test(bump)) {
  console.error("usage: node scripts/release.mjs <patch|minor|major|x.y.z>");
  process.exit(1);
}

const run = (cmd) => execSync(cmd, { stdio: "inherit" });

// refuse to release from a dirty tree, and gate the tag on a green check
if (execSync("git status --porcelain", { encoding: "utf8" }).trim()) {
  console.error("refusing to release: working tree is dirty");
  process.exit(1);
}
run("npm run check");

run(`npm version ${bump} --no-git-tag-version`);
run("node scripts/sync-versions.mjs");
// root version and synced workspace versions both live in the lockfile
run("npm install --package-lock-only");
const { version } = JSON.parse(readFileSync("package.json", "utf8"));
run("git add package.json package-lock.json packages/*/package.json");
run(`git commit -m "chore(release): ${version}"`);
run(`git tag v${version}`);
console.log(`\nreleased v${version}. publish with: npm run publish`);
