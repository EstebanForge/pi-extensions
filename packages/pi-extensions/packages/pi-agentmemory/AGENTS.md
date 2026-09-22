# PROJECT KNOWLEDGE BASE

**Generated:** 2026-06-10

## OVERVIEW
Project: **pi-agentmemory** (`@estebanforge/pi-agentmemory`)
Stack: TypeScript 5.8+, Node.js 22+, ES2022 modules, Pi Extension API, TypeBox schemas

Pi-native extension providing cross-session memory via the agentmemory REST API. No MCP dependency — direct HTTP to a local agentmemory server with automatic recall injection into system prompts.

## STRUCTURE
```
extensions/agentmemory/
  index.ts        # Extension entrypoint — tools, hooks, command registration
  server.ts       # Auto-start: health-check, detect CLI, detached spawn, poll
  security.ts     # Plaintext bearer auth guard (warns/errors on HTTP + secret)
```
- `extensions/`: All Pi extension source code (the `"files"` whitelist in package.json)
- `.pi/tasks/`: Pi task state (auto-generated, not source)

## COMMANDS
| Action | Command |
|--------|---------|
| Install | `npm install` (or `pi install npm:@estebanforge/pi-agentmemory` as consumer) |
| Type-check | `npx tsc --noEmit` |
| Build | No build step (`noEmit: true` — consumed as raw TS by Pi) |

## CODING STANDARDS
- **Language**: TypeScript strict mode (`strict: true`), ESNext modules, ES2022 target
- **Style**: Functional with local helpers; no classes. Named exports only. `async/await` over `.then()`
- **Types**: Inline type aliases at module level (e.g. `type TextBlock`, `type HealthResponse`). TypeBox (`Type.Object`) for tool parameter schemas
- **Imports**: `import type` for type-only imports. Node builtins use `node:` prefix (`node:path`, `node:crypto`)
- **Error handling**: Return `null` on failure (never throw). Guard functions return early
- **Naming**: camelCase for functions/variables, PascalCase for type aliases

## ARCHITECTURE
- **Extension pattern**: Single default export function receiving `ExtensionAPI`. Registers tools, hooks, and commands declaratively
- **Hooks lifecycle**: `session_start` (derive session ID, health check) → `before_agent_start` (fire-and-forget smart-search, append guidance to system prompt) → `context` (inject awaited search results as user message before LLM call) → `agent_end` (observe conversation turn back to agentmemory)
- **REST client**: `callAgentMemory<T>()` generic helper — single function for all API calls, handles URL normalization, auth headers, error suppression
- **Auto-start**: `server.ts` `ensureServer()` health-checks first (so a server left running by a previous Pi, or started by another instance, is never restarted), then spawns `agentmemory` detached (or `npx` fallback) and polls. An in-flight dedup promise keeps one Pi from spawning repeatedly. Gated by flags `agentmemory-autostart` and `agentmemory-npx-fallback`
- **Security**: Plaintext bearer auth guard in `security.ts`. Warns once on HTTP+secret; throws if `AGENTMEMORY_REQUIRE_HTTPS=1`

## WHERE TO LOOK
- **Source**: `extensions/agentmemory/index.ts` (tools, hooks, command, flags)
- **Auto-start**: `extensions/agentmemory/server.ts`
- **Security**: `extensions/agentmemory/security.ts`
- **Config**: `package.json` (pi.extensions array, peerDependencies), `tsconfig.json`

## ENVIRONMENT VARIABLES
| Variable | Default | Purpose |
|----------|---------|---------|
| `AGENTMEMORY_URL` | `http://localhost:3111` | agentmemory server base URL |
| `AGENTMEMORY_SECRET` | (none) | Bearer token for auth |
| `AGENTMEMORY_REQUIRE_HTTPS` | (none) | Set `1` to reject HTTP+secret on non-loopback |

## NOTES
- No test suite yet. Type-checking (`tsc --noEmit`) is the only verification step
- No linter/formatter configured (no eslint, prettier, biome, etc.)
- Extension is consumed as raw TypeScript by the Pi runtime — no compilation or bundling needed
- The `context` hook injects search results as a user message *before* the real conversation messages, making recalls visible but non-intrusive to the LLM
