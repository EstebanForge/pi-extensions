import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["tests/**/*.test.ts"],
    environment: "node",
    // Each test gets a fresh module cache so the auth/state caches do not
    // leak across files; pairs with explicit env-var management in tests.
    isolate: true,
  },
});
