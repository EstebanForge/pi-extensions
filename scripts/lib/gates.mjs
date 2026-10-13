// Shared release gates, the deterministic end of two recurring failures:
// (1) a changelog that ships stale or missing sections, (2) a dependency
// floor that lags the APIs the shipped code imports. Called by both
// release-pkg.mjs (before it bumps) and publish-pkg.mjs (before it pushes),
// so every path into npm passes the same checks.
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { checkChangelog, resolveChangelog } from "./changelog-gate.mjs";
import { checkFloors, fetchFloorFromNpm, hasVersionOnNpm } from "./floor-gate.mjs";

// Runs every gate for one package at one target version. Prints a note per
// skipped gate, one `refusing to release` line per problem, and exits 1 on
// any failure. Offline gates run first: a stamp problem must not hide
// behind a network probe.
export async function assertReleaseGates(rootDir, name, version) {
  const pkgDir = join(rootDir, "packages", name);
  const pkg = JSON.parse(readFileSync(join(pkgDir, "package.json"), "utf8"));
  const problems = [];

  const changelog = resolveChangelog(pkgDir, pkg);
  if ("skip" in changelog) console.log(`changelog: ${changelog.skip}`);
  else if ("problem" in changelog) problems.push(changelog.problem);
  else problems.push(...checkChangelog(changelog.text, version));

  problems.push(
    ...(await checkFloors({ rootDir, pkgDir, fetchFloor: fetchFloorFromNpm, hasVersion: hasVersionOnNpm })),
  );

  if (problems.length > 0) {
    for (const problem of problems) {
      console.error(`refusing to release ${pkg.name} ${version}: ${problem}`);
    }
    process.exit(1);
  }
}
