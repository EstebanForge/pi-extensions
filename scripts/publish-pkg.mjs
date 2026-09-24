#!/usr/bin/env node
// Publish one package: release it first if it hasn't been released, then
// npm publish for that workspace only. The single human-gate command at
// the end of a release: `npm run pub <name>`.
// "Unreleased" means the current package.json version has no release tag:
// release-pkg.mjs always tags <name>-v<version>, so the tag is the marker.
// Scoped access comes from publishConfig in the package manifest.
import { execSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const [name, bump = "patch"] = process.argv.slice(2);
if (!name || !/^(patch|minor|major)$/.test(bump)) {
  console.error("usage: node scripts/publish-pkg.mjs <package-name> [patch|minor|major]");
  process.exit(1);
}

const rootDir = join(dirname(fileURLToPath(import.meta.url)), "..");
const pkgJsonPath = join(rootDir, "packages", name, "package.json");
if (!existsSync(pkgJsonPath)) {
  console.error(`no such package: packages/${name}`);
  process.exit(1);
}

const run = (cmd) => execSync(cmd, { stdio: "inherit" });
const sh = (cmd) => execSync(cmd, { encoding: "utf8" }).trim();
const version = () => JSON.parse(readFileSync(pkgJsonPath, "utf8")).version;

// rel if this package changed since its release tag. The tag alone is not
// the marker: a tag can exist for the current version while newer commits
// already touch the package (the pending-work case). release-pkg.mjs gates
// on a clean tree and a green check, then bumps, commits, and tags itself.
const tag = `${name}-v${version()}`;
const tagExists = sh(`git tag --list ${tag}`) !== "";
const changedSinceTag = tagExists && sh(`git log --oneline ${tag}..HEAD -- packages/${name}`) !== "";
if (tagExists && !changedSinceTag) {
  console.log(`${tag} exists and packages/${name} is unchanged since it: publishing ${version()} as-is`);
} else {
  const why = tagExists ? `commits touch the package since ${tag}` : `no ${tag}`;
  console.log(`${why}: releasing ${name} ${bump} first`);
  run(`node scripts/release-pkg.mjs ${name} ${bump}`);
}

// Nothing publishes from an out-of-sync repo: the release commit and tag
// must be public before the registry artifact exists, or the npm version
// has no source to point at.
try {
  run("git fetch origin main");
} catch {
  console.error("refusing to publish: cannot reach origin (network/ssh); fix and re-run");
  process.exit(1);
}
if (sh("git rev-list --count HEAD..origin/main") !== "0") {
  console.error("refusing to publish: origin/main is ahead, pull first");
  process.exit(1);
}
if (sh("git rev-list --count origin/main..HEAD") !== "0") run("git push --follow-tags");

// Registry guard: npm rejects identical versions, and an exact match here
// means there is nothing left to publish. A failed lookup is fine: it is
// the first-publish case (pi-deepwiki) or an offline hiccup the publish
// step itself will catch.
const pkgName = JSON.parse(readFileSync(pkgJsonPath, "utf8")).name;
let registry = null;
try {
  registry = sh(`npm view ${pkgName} version`);
} catch {
  console.log("registry lookup failed (unpublished or offline); continuing");
}
if (registry === version()) {
  console.error(`${pkgName}@${version()} is already on npm; nothing to publish`);
  process.exit(1);
}

run(`npm publish --workspace packages/${name}`);
console.log(`published ${pkgName}@${version()}: pi install ${pkgName}`);
