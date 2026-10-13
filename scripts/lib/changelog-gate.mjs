// Release gate: the changelog must carry a stamped section for the version
// being created, and [Unreleased] must not carry entries. This is the
// deterministic replacement for the manual stamp step that failed twice
// (pi-ask-claude 1.0.3 shipped no section; bridge 1.8.1 shipped a stale
// [Unreleased]). The scripts never WRITE changelogs; they refuse to release
// an unstamped one.
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

const VERSION_HEADING = /^##\s+\[?(\d+\.\d+\.\d+)\]?\s*(?:[-\u2013\u2014]\s*(\d{4}-\d{2}-\d{2})|\((\d{4}-\d{2}-\d{2})\))\s*$/;
// The lookahead keeps prerelease headings (1.0.1-rc.1) from reading as 1.0.1.
const LOOSE_VERSION_HEADING = /^##\s+\[?(\d+\.\d+\.\d+)\]?(?![\w.-])/;
// Loose on purpose: `## [Unreleased] - next` and friends must not fall
// through to "other heading" and hide their entries from the gate.
const UNRELEASED_HEADING = /^##\s+\[?Unreleased\b/i;
const FENCE = /^\s*(```|~~~)/;

// Walk the document fence-aware and fold it into per-version sections plus
// the Unreleased body. Only `## ` headings split sections; `###` subheads
// stay inside them.
function scan(text) {
  const versions = new Map(); // version -> { count, hasBody, undatedCount }
  const unreleased = { hasEntries: false };
  let fenced = false;
  let current = null; // { kind: "version" | "unreleased" }
  for (const raw of text.split(/\r?\n/)) {
    // Fence lines themselves are structure, not content: a section holding
    // only a code block counts as empty.
    if (FENCE.test(raw)) {
      fenced = !fenced;
      continue;
    }
    if (fenced) continue;
    if (/^##\s/.test(raw)) {
      const dated = raw.match(VERSION_HEADING);
      const loose = raw.match(LOOSE_VERSION_HEADING);
      if (dated || loose) {
        const version = dated?.[1] ?? loose[1];
        const entry = versions.get(version) ?? { count: 0, hasBody: false, undatedCount: 0 };
        entry.count += 1;
        if (!dated) entry.undatedCount += 1;
        versions.set(version, entry);
        current = { kind: "version", version };
      } else if (UNRELEASED_HEADING.test(raw)) {
        current = { kind: "unreleased" };
      } else {
        current = null; // any other ## heading closes the section
      }
      continue;
    }
    if (!current) continue;
    // A body line is anything non-blank that is not a subheading: a section
    // holding only `### Fixed` scaffolding counts as empty.
    const isBodyLine = raw.trim() !== "" && !/^#{1,6}\s/.test(raw.trim());
    if (!isBodyLine) continue;
    if (current.kind === "version") {
      const entry = versions.get(current.version);
      if (entry) entry.hasBody = true;
    } else {
      unreleased.hasEntries = true;
    }
  }
  return { versions, unreleased };
}

// Returns one problem string per failure; [] means the changelog is ready
// to ship for `version`.
export function checkChangelog(text, version) {
  const { versions, unreleased } = scan(text);
  const problems = [];
  if (unreleased.hasEntries) {
    problems.push(`CHANGELOG.md [Unreleased] still has entries; move them under "## [${version}] - YYYY-MM-DD"`);
  }
  const entry = versions.get(version);
  if (!entry) {
    problems.push(`CHANGELOG.md has no "## [${version}] - YYYY-MM-DD" section; add one for this release and commit`);
    return problems;
  }
  if (entry.count > 1) problems.push(`CHANGELOG.md has a section for ${version} twice; merge them`);
  if (entry.undatedCount > 0) {
    problems.push(`CHANGELOG.md section ${version} has a heading without a YYYY-MM-DD date; fix the stamp`);
  }
  if (!entry.hasBody) {
    problems.push(`CHANGELOG.md section ${version} is empty; write at least one entry`);
  }
  return problems;
}

// Decide what to check: an existing CHANGELOG.md is always checked; a
// missing one is skipped unless `files` promises it to consumers, in which
// case the miss is itself a problem.
export function resolveChangelog(pkgDir, pkg) {
  const path = join(pkgDir, "CHANGELOG.md");
  if (!existsSync(path)) {
    if ((pkg.files ?? []).includes("CHANGELOG.md")) {
      return { problem: 'no CHANGELOG.md but package.json "files" lists it' };
    }
    return { skip: "no changelog, skipped" };
  }
  return { text: readFileSync(path, "utf8") };
}
