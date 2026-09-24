# Releases

Every release command gates on two things before it touches anything: a clean working tree and a green `npm run check` (typecheck + full test suite). Nothing releases from a dirty tree or failing tests.

Versions are per-package. A package's version moves only when that package releases. Two flows exist: single-package releases for fixes and tweaks, and the fleet stamp for dependency bumps and mass changes.

## Single-package release: the everyday flow

Use when exactly one package changed: a bug fix, a tweak, a new tool.

```bash
npm run pub pi-slack-me          # releases if needed, then npm publish: the one gate command
```

- `pub` is the whole release. If the package changed since its release tag, it first runs the release (check gates, version bump, lockfile sync, `chore(release): <package> <version>` commit, `<name>-v<version>` tag; default bump `patch`, override with a second arg: `npm run pub <name> minor`). It then syncs with origin - refuses when behind, pushes commits and tags when ahead - refuses a version npm already has, and finally runs the full check and `npm publish` for that workspace only. Scoped packages publish public via each manifest's `publishConfig`.
- `rel` (release) stays available standalone: check gates, version bump, lockfile sync, commit, tag. Use it when you want the bump as its own reviewed commit before any publish; a later `pub` sees the fresh tag and publishes without re-releasing.

Levels:

| Command | Version change | Use when |
|---|---|---|
| `npm run rel <name> patch` | 1.2.1 -> 1.2.2 | Bug fix, tweak, doc change |
| `npm run rel <name> minor` | 1.2.1 -> 1.3.0 | New tool or feature, backward compatible |
| `npm run rel <name> major` | 1.2.1 -> 2.0.0 | Breaking change to config keys or behavior |
| `npm run rel <name> 3.1.4` | exact version | Rare: force a specific number |

Examples:

```bash
# fixed a crash in the Slack post tool
npm run pub pi-slack-me          # patches to 1.2.2, commits, tags, pushes, publishes

# same thing, split manually when you want to review the bump first
npm run rel pi-git-me minor
npm run pub pi-git-me            # sees the fresh tag, publishes without re-releasing

# renamed zendesk-me config keys (breaking)
npm run pub pi-zendesk-me major
```

The publish stays the only irreversible step. Everything `pub` does before `npm publish` is a local commit you can reset.

## Fleet stamp: dependency bumps and mass changes

Use when everything moves at once: root dependency bumps, a mass refactor, a license change. The stamp adds one version level to every package from its own current version, so histories stay independent: pi-hostname 1.0.0 -> 1.0.1 while pi-agentmemory 1.0.13 -> 1.0.14, in one commit.

```bash
npm run release:patch            # +1 patch on every package
npm run release:minor            # +1 minor on every package
npm run release:major            # +1 major on every package
```

What one stamp does: check gates, bumps the root manifest (cursor only, never published) and all 16 packages, syncs the lockfile, one commit `chore(release): fleet patch` whose body lists every `name old -> new`, and one `<name>-v<version>` tag per package (16 tags).

Publishing after a stamp: right after a stamp every package sits above its own registry version, so the blanket publish works:

```bash
npm run publish                  # full check, then npm publish for all 16
```

After individual releases (no stamp), the blanket publish fails on unchanged packages. Publish those individually with `npm run pub <name>`.

## Reference

| Command | Does | Publishes |
|---|---|---|
| `npm run rel <name> <level>` | check, bump one package, lockfile, commit, tag | no |
| `npm run pub <name> [level]` | release if the package changed since its tag, sync with origin, check, publish one package | one |
| `npm run release:<level>` | check, +level on every package, one commit, tag | no |
| `npm run publish` | check, publish every package | all |
| `npm run check` | typecheck + tests | - |

Tags always mark a released version: `<name>-v<version>` (pi-slack-me-v1.2.2). A fleet stamp creates the 16 per-package tags for the versions it cut; there is no fleet-wide version to tag. Push commits and tags together: `git push --follow-tags`.

Rules:

- Never hand-edit a package version. Use `rel`, or a fleet stamp.
- npm refuses publishing a version that already exists on the registry; `pub` checks for that before publishing and stops cleanly. As of the migration every package sits exactly at its legacy registry version, so each package's first monorepo publish must come from a `rel` bump or a fleet stamp. Exception: pi-deepwiki was never published, so 1.0.1 publishes as-is.
- The registry can hold different versions per package. That is by design.
- Publish is the only irreversible step. Everything before it is a local commit you can reset.
- Check what the registry has before publishing: `npm view @estebanforge/<name> version`.
