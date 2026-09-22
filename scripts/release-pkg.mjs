#!/usr/bin/env node
// Single-package release: bump one package version, commit, tag.
// Publishing stays separate: npm run pub <name>
import { execSync } from "node:child_process";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const [name, bump] = process.argv.slice(2);
if (!name || !bump || !/^(patch|minor|major|\d+\.\d+\.\d+)$/.test(bump)) {
  console.error("usage: node scripts/release-pkg.mjs <package-name> <patch|minor|major|x.y.z>");
  console.error("example: node scripts/release-pkg.mjs pi-hostname patch");
  process.exit(1);
}

const rootDir = join(dirname(fileURLToPath(import.meta.url)), "..");
const pkgJsonPath = join(rootDir, "packages", name, "package.json");
if (!existsSync(pkgJsonPath)) {
  console.error(`no such package: packages/${name}`);
  process.exit(1);
}

const run = (cmd) => execSync(cmd, { stdio: "inherit" });

// same gates as the fleet release: nothing ships from a dirty tree
// or a red check
if (execSync("git status --porcelain", { encoding: "utf8" }).trim()) {
  console.error("refusing to release: working tree is dirty");
  process.exit(1);
}
run("npm run check");

const pkg = JSON.parse(readFileSync(pkgJsonPath, "utf8"));
let [major, minor, patch] = pkg.version.split(".").map(Number);
if (bump === "patch") patch += 1;
else if (bump === "minor") { minor += 1; patch = 0; }
else if (bump === "major") { major += 1; minor = 0; patch = 0; }
else [major, minor, patch] = bump.split(".").map(Number);
const version = `${major}.${minor}.${patch}`;

pkg.version = version;
writeFileSync(pkgJsonPath, `${JSON.stringify(pkg, null, 2)}\n`);
// workspace versions live in the lockfile too
run("npm install --package-lock-only");

run(`git add package-lock.json packages/${name}/package.json`);
run(`git commit -m "chore(release): ${pkg.name} ${version}"`);
// annotated: git push --follow-tags only carries annotated tags
execFileSync("git", ["tag", "-a", `${name}-v${version}`, "-m", `${pkg.name} ${version}`], { stdio: "inherit" });
console.log(`\nreleased ${pkg.name} ${version}. publish with: npm run pub ${name}`);
