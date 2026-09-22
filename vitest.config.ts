import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    environment: "node",
    // contract the auth-heavy suites rely on: no module/state leakage across files
    isolate: true,
    include: ["packages/*/tests/**/*.test.ts"],
  },
});
