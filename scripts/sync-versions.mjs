#!/usr/bin/env node
// Root package.json version is the fleet version. Writes it into every workspace package.
import { readdirSync, readFileSync, writeFileSync } from "node:fs";

const root = JSON.parse(readFileSync("package.json", "utf8"));
const version = root.version;
let touched = 0;

for (const entry of readdirSync("packages", { withFileTypes: true })) {
  if (!entry.isDirectory()) continue;
  const path = `packages/${entry.name}/package.json`;
  const pkg = JSON.parse(readFileSync(path, "utf8"));
  if (pkg.version === version) continue;
  pkg.version = version;
  writeFileSync(path, `${JSON.stringify(pkg, null, 2)}\n`);
  touched += 1;
  console.log(`${pkg.name}: ${version}`);
}

console.log(touched ? `${touched} package(s) synced to ${version}` : `all packages already at ${version}`);
