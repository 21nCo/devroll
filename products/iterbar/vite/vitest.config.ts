import { defineConfig } from "vitest/config";

export default defineConfig({
  // Each test starts real Vite servers and daemons on temporary projects.
  test: { environment: "node", include: ["src/**/*.test.ts"], testTimeout: 30_000, hookTimeout: 30_000 },
});
