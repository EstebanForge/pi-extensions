default:
    @just --list

# Run TypeScript typecheck across monorepo
typecheck:
    npm run typecheck

# Run vitest test suite with clean environment
test *args:
    env -u RTK_DB_PATH npm test -- {{args}}

# Run typecheck and tests
check: typecheck test

# Local CI verification gate
ci: check
