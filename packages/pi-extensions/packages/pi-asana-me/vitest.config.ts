import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["tests/**/*.test.ts"],
    environment: "node",
    // Each test gets a fresh module cache so the auth cache does not leak
    // across files; pairs with the explicit env-var management in
    // tests/auth.test.ts.
    isolate: true,
  },
});
