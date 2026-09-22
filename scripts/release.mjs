#!/usr/bin/env node
// Fleet release: bump every package one level from its own current
// version. For dependency bumps and mass changes. One-off fixes
// release a single package instead: npm run rel <name> <level>
// Publishing stays separate: npm run publish
import { execFileSync, execSync } from "node:child_process";
import { readdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const bump = process.argv[2];
if (!bump || !/^(patch|minor|major)$/.test(bump)) {
  console.error("usage: node scripts/release.mjs <patch|minor|major>");
  process.exit(1);
}

const rootDir = join(dirname(fileURLToPath(import.meta.url)), "..");
const run = (cmd) => execSync(cmd, { stdio: "inherit" });

// same gates as single-package releases: nothing ships from a dirty
// tree or a red check
if (execSync("git status --porcelain", { encoding: "utf8" }).trim()) {
  console.error("refusing to release: working tree is dirty");
  process.exit(1);
}
run("npm run check");

const bumpVersion = (v) => {
  let [major, minor, patch] = v.split(".").map(Number);
  if (bump === "patch") patch += 1;
  else if (bump === "minor") { minor += 1; patch = 0; }
  else { major += 1; minor = 0; patch = 0; }
  return `${major}.${minor}.${patch}`;
};

const changes = [];

const rootPkgPath = join(rootDir, "package.json");
const rootPkg = JSON.parse(readFileSync(rootPkgPath, "utf8"));
rootPkg.version = bumpVersion(rootPkg.version);
writeFileSync(rootPkgPath, `${JSON.stringify(rootPkg, null, 2)}\n`);

for (const entry of readdirSync(join(rootDir, "packages"), { withFileTypes: true })) {
  if (!entry.isDirectory()) continue;
  const path = join(rootDir, "packages", entry.name, "package.json");
  const pkg = JSON.parse(readFileSync(path, "utf8"));
  const before = pkg.version;
  pkg.version = bumpVersion(before);
  writeFileSync(path, `${JSON.stringify(pkg, null, 2)}\n`);
  changes.push({ name: entry.name, from: before, to: pkg.version });
}

// workspace versions live in the lockfile too
run("npm install --package-lock-only");

run("git add package-lock.json package.json packages/*/package.json");
// execFileSync keeps the multi-line body intact (no shell mangling)
execFileSync("git", ["commit", "-m", `chore(release): fleet ${bump}`, "-m", changes.map((c) => `${c.name} ${c.from} -> ${c.to}`).join("\n")], { stdio: "inherit" });
// tags always mark a released version, never a fleet pseudo-version:
// one tag per package, same scheme as single-package releases
// annotated: git push --follow-tags only carries annotated tags
for (const c of changes) execFileSync("git", ["tag", "-a", `${c.name}-v${c.to}`, "-m", `${c.name} ${c.to}`], { stdio: "inherit" });
console.log(`\nfleet ${bump} stamped. publish everything with: npm run publish, or one package with: npm run pub <name>`);
