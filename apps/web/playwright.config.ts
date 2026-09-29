import { defineConfig, devices } from "@playwright/test";
import { WEB_ORIGIN } from "./e2e/support";

/**
 * Tier 3 of docs/e2e-testing-strategy.md: eight browser journeys against
 * `next build && next start`, with `apps/api` and a seeded Postgres behind
 * it. `e2e/global-setup.ts` seeds and starts both servers; see it for why
 * that is not Playwright's `webServer`.
 *
 * Specs are `*.spec.ts` so the root Vitest run (`*.test.ts`) never sees them.
 *
 * Needs a migrated Postgres at DATABASE_URL (default: the docker-compose
 * one). Ports default to 18787 (api) and 13000 (web) so this never collides
 * with `pnpm serve:api` / `pnpm dev:web` on 8787 / 3000.
 */
export default defineConfig({
  testDir: "./e2e",
  testMatch: "**/*.spec.ts",
  globalSetup: "./e2e/global-setup.ts",
  // A cold `next build` is most of this.
  globalTimeout: 10 * 60_000,
  timeout: 30_000,
  fullyParallel: false,
  forbidOnly: !!process.env["CI"],
  retries: 0,
  reporter: process.env["CI"] ? [["list"], ["html", { open: "never", outputFolder: "./e2e/.artifacts/report" }]] : "list",
  outputDir: "./e2e/.artifacts/test-results",
  use: {
    baseURL: WEB_ORIGIN,
    trace: "retain-on-failure",
  },
  projects: [{ name: "chromium", use: { ...devices["Desktop Chrome"] } }],
});
