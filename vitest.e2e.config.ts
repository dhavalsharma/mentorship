import { configDefaults, defineConfig } from "vitest/config";
import { aliases } from "./vitest.config.js";

/**
 * Tier 2 — the journey suite (docs/e2e-testing-strategy.md).
 *
 * `pnpm test:e2e` is the PR gate: every journey plus the P1/P3/P4/P5
 * properties. `pnpm test:e2e:nightly` adds P2 (crash-resume), which is
 * O(adapter calls) full runs per journey and too slow for every PR.
 *
 * Unlike `pnpm test`, a missing DATABASE_URL is a failure, not a skip. A
 * journey suite that silently skips is a gate that silently opens.
 */
if (!process.env["DATABASE_URL"]) {
  throw new Error(
    "pnpm test:e2e needs DATABASE_URL (docker compose up -d db && pnpm db:migrate). " +
      "The journey suite does not skip.",
  );
}

const nightly = process.env["E2E_NIGHTLY"] === "1";

export default defineConfig({
  resolve: { alias: aliases },
  test: {
    include: nightly
      ? ["tests/e2e/**/*.e2e.test.ts", "tests/e2e/**/*.nightly.test.ts"]
      : ["tests/e2e/**/*.e2e.test.ts"],
    exclude: [...configDefaults.exclude],
    environment: "node",
    // Journeys run concurrently against one Postgres by design — each owns a
    // fresh org and RLS keeps them apart (strategy doc, point 5). The bound is
    // connections, not correctness.
    testTimeout: nightly ? 900_000 : 60_000,
    hookTimeout: 60_000,
  },
});
