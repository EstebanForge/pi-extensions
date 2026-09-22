#!/usr/bin/env node
// Publish one package: full check first, then npm publish for that
// workspace only. Scoped access comes from publishConfig in the
// package manifest.
import { execSync } from "node:child_process";
import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const [name] = process.argv.slice(2);
if (!name) {
  console.error("usage: node scripts/publish-pkg.mjs <package-name>");
  process.exit(1);
}

const rootDir = join(dirname(fileURLToPath(import.meta.url)), "..");
if (!existsSync(join(rootDir, "packages", name, "package.json"))) {
  console.error(`no such package: packages/${name}`);
  process.exit(1);
}

const run = (cmd) => execSync(cmd, { stdio: "inherit" });
run("npm run check");
run(`npm publish --workspace packages/${name}`);
