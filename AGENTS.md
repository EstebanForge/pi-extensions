# pi-extensions AGENTS.md

Monorepo for the 17 `@estebanforge/pi-*` Pi Coding Agent extensions. npm workspaces, no build step: packages publish raw TypeScript and Pi loads it directly.

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
| Publish | `npm run pub <name>` (the only publish path; runs the release gates first) |

## Rules

- Versions are per-package: a package's version moves only when that package releases. `npm run rel <name> patch` bumps, commits, and tags one package standalone. `npm run pub <name> [patch|minor|major]` is the single end-of-release gate: it releases first when the package changed since its release tag, syncs with origin, refuses a version npm already has, then publishes. The fleet stamp (`npm run release:patch`) adds one level to every package for mass changes. Never hand-edit a version.
- Publishing to npm is human-triggered. Agents end the release handoff at commit + push and remind the human of the single gate command (`npm run pub <name>`); never run `npm run pub <name>` or `npm publish`.
- Changelogs are hand-maintained and the scripts never touch them: while developing, entries accumulate under `## [Unreleased]`; before running `npm run pub <name>`, stamp that heading to the exact version pub will create (the default patch bump of package.json, e.g. `## [1.0.4] - 2026-10-07`), then commit and push. The release gates enforce the stamp: `pub` and `rel` refuse to run when the target version has no dated section, when that section is empty, or when `[Unreleased]` still carries entries (before the gates existed, pi-ask-claude 1.0.3 shipped with no section at all and bridge 1.8.1 shipped all its entries under a stale `[Unreleased]`).
- Release runbook, per package, human runs pub: start from a clean tree (untracked files trip the `git status --porcelain` gate), changelog stamped, then publish in order pi-ask-shared first (consumers depend on it), then pi-ask-claude, pi-ask-codex, pi-ask-antigravity; pi-antigravity-bridge is independent and publishable anytime. After pi-ask-shared publishes, run `npm install` so the lockfile picks up the new floor before publishing the consumers (pi-peer-review included — its dependency floor tracks the published shared version). Consumer dependency floors must always match a version npm actually has: the published 0.1.1 predates the shared config/run/peers/consult modules, so consumers currently require `^0.1.2` and shared's next pub is 0.1.2. Never pass `minor` for shared, and never let a consumer floor point at an unpublished version without scheduling the shared publish first.
- A dependency floor must cover every workspace API the shipped code imports. When a package starts importing a new export from a workspace library, raise that dependency's floor to the first published version carrying the export, in the same change. A floor that merely permits newer versions is not enough: bridge 1.8.1 shipped `dialogChoice` imports over a `^0.1.1` floor while the export landed in pi-tui-dialogs 0.1.2, so consumers with an existing lockfile loaded the new code against the old library and the engine picker crashed at runtime with `dialogChoice is not a function` (fixed by the 1.8.2 floor bump). The release gates enforce this at `pub`/`rel` time: the floor must exist on npm (never point at an unpublished version) and a compile of the package's shipped imports and used namespace members against the floor tarball must succeed (value property access; type-only namespaces, element access, and `require()` are not collected, and chained floors resolve through the current workspace snapshot). Floors are single ranges (`^x.y.z`, `~x.y.z`, or exact); nothing else is verifiable.
- Package names are a public contract with existing installs. Never rename or re-scope.
- `files` must stay minimal: runtime only. Never ship `tests/`, configs, or docs in a tarball.
- `pi.extensions` entrypoints are the install contract; do not move them.
- Library packages (shared code with no Pi entrypoint) carry no `pi.extensions` field; `main`/`exports` point at source, and the npm scope is the only ownership prefix (inner name describes the concern, never the owner).
- Every library package states in its README that it is a plain library with no Pi entrypoint, so readers do not mistake it for an installable extension.
- New shared helpers across two or more packages go in a `packages/shared`-style library, not copy-paste.
- This repo is the single source of truth. The pre-migration per-extension repos are deleted; all history lives here.
- Conventional Commits; body explains why, not what.
