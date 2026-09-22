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

- Versions are lockstep. Never edit a package version by hand; change the root version and run `npm run sync-versions`.
- Package names are a public contract with existing installs. Never rename or re-scope.
- `files` must stay minimal: runtime only. Never ship `tests/`, configs, or docs in a tarball.
- `pi.extensions` entrypoints are the install contract; do not move them.
- New shared helpers across two or more packages go in a `packages/shared`-style library, not copy-paste.
- This repo is the single source of truth. The pre-migration per-extension repos are deleted; all history lives here.
- Conventional Commits; body explains why, not what.
