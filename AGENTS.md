# pi-extensions AGENTS.md

Monorepo for the 16 `@estebanforge/pi-*` Pi Coding Agent extensions. npm workspaces, no build step: packages publish raw TypeScript and Pi loads it directly.

## Layout

```
packages/<name>/
  extensions/          # pi entrypoint (published, loaded by Pi)
  lib/                 # package-internal helpers (published, only where present)
  tests/               # all tests, one location per package
  package.json         # uniform manifest: name, version, files, pi, peerDependencies
  README.md            # + CHANGELOG.md / LICENSE only where they already exist
```

Root owns the toolchain: one `tsconfig.json`, one `vitest.config.ts`, one devDependencies block. Packages carry no scripts, no devDependencies, no tsconfig, no vitest config.

## Commands

| Action | Command |
|---|---|
| Install | `npm install` (root only) |
| Typecheck | `npm run typecheck` |
| Test | `npm run test` |
| Both | `npm run check` |
| Release | `npm run release:patch` / `minor` / `major` |
| Publish | `npm run publish` (runs full check first) |

## Rules

- Versions are per-package: a package's version moves only when that package releases. `npm run rel <name> patch` bumps, commits, and tags one package standalone. `npm run pub <name> [patch|minor|major]` is the single end-of-release gate: it releases first when the package changed since its release tag, syncs with origin, refuses a version npm already has, then publishes. The fleet stamp (`npm run release:patch`) adds one level to every package for mass changes. Never hand-edit a version.
- Publishing to npm is human-triggered. Agents end the release handoff at commit + push and remind the human of the single gate command (`npm run pub <name>`); never run `npm run pub <name>`, `npm publish`, or `npm run publish`.
- Changelogs are hand-maintained and the scripts never touch them: while developing, entries accumulate under `## [Unreleased]`; before running `npm run pub <name>`, stamp that heading to the exact version pub will create (the default patch bump of package.json, e.g. `## [1.0.4] - 2026-10-07`), then commit and push. A skipped stamp ships a stale `[Unreleased]` to npm (pi-ask-claude 1.0.3 shipped with no section at all).
- Release runbook, per package, human runs pub: start from a clean tree (untracked files trip the `git status --porcelain` gate), changelog stamped, then publish in order pi-ask-shared first (consumers depend on it), then pi-ask-claude, pi-ask-codex, pi-ask-antigravity; pi-antigravity-bridge is independent and publishable anytime. pi-ask-shared's first pub has no tag, so it releases 0.1.1; never pass `minor` for it, because 0.2.0 escapes the `^0.1.0` range the consumers carry and `rel` never rewrites dependent ranges.
- Package names are a public contract with existing installs. Never rename or re-scope.
- `files` must stay minimal: runtime only. Never ship `tests/`, configs, or docs in a tarball.
- `pi.extensions` entrypoints are the install contract; do not move them.
- New shared helpers across two or more packages go in a `packages/shared`-style library, not copy-paste.
- This repo is the single source of truth. The pre-migration per-extension repos are deleted; all history lives here.
- Conventional Commits; body explains why, not what.
