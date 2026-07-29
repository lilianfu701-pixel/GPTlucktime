import { fileURLToPath } from "node:url";
import { loadEnv } from "vite";
import { defineConfig } from "vitest/config";

const rootDir = fileURLToPath(new URL(".", import.meta.url));

/**
 * Integration tests need real connection strings. They come from `.env.test`,
 * which is git-ignored, so nobody's local credentials reach the repository and
 * a test run can never inherit development or production configuration.
 */
const testEnv = loadEnv("test", rootDir, "");

export default defineConfig({
  resolve: {
    alias: { "@": rootDir },
  },
  test: {
    environment: "node",
    setupFiles: ["./tests/setup.ts"],
    env: testEnv,
    // Each project declares its own `include`. A root-level `include` would be
    // merged into every project rather than overridden, so the integration
    // project would collect the unit files too.
    // End-to-end specs use `.spec.ts` and belong to Playwright, not Vitest.
    projects: [
      {
        extends: true,
        test: {
          name: "unit",
          include: ["tests/unit/**/*.test.ts"],
        },
      },
      {
        extends: true,
        test: {
          name: "integration",
          include: ["tests/integration/**/*.test.ts"],
          // Integration files share one PostgreSQL database and one Redis
          // instance. Running them in parallel would let one file's cleanup
          // delete rows another file is still asserting on.
          fileParallelism: false,
        },
      },
    ],
  },
});
