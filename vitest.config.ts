import { configDefaults, defineConfig } from "vitest/config";
import { fileURLToPath } from "node:url";

const p = (rel: string) => fileURLToPath(new URL(rel, import.meta.url));

/** Shared with `vitest.e2e.config.ts`, so both suites resolve packages identically. */
export const aliases: Record<string, string> = {
  "@mentorship/core": p("./packages/core/src/index.ts"),
  "@mentorship/db/testing": p("./packages/db/src/testing.ts"),
  "@mentorship/db": p("./packages/db/src/index.ts"),
  "@mentorship/events": p("./packages/events/src/index.ts"),
  "@mentorship/workflows/postgres": p("./packages/workflows/src/postgres.ts"),
  "@mentorship/workflows": p("./packages/workflows/src/index.ts"),
  "@mentorship/integrations": p("./packages/integrations/src/index.ts"),
  "@mentorship/roster": p("./packages/roster/src/index.ts"),
  "@mentorship/enrollment": p("./packages/enrollment/src/index.ts"),
  "@mentorship/testkit": p("./packages/testkit/src/index.ts"),
  "@mentorship/primitive-matching": p("./packages/primitives/matching/src/index.ts"),
  "@mentorship/primitive-nudge/postgres": p("./packages/primitives/nudge/src/postgres.ts"),
  "@mentorship/primitive-nudge": p("./packages/primitives/nudge/src/index.ts"),
  "@mentorship/primitive-session-intel": p("./packages/primitives/session-intel/src/index.ts"),
  "@mentorship/primitive-progress/postgres": p("./packages/primitives/progress/src/postgres.ts"),
  "@mentorship/primitive-progress": p("./packages/primitives/progress/src/index.ts"),
  "@mentorship/ai/postgres": p("./packages/ai/src/postgres.ts"),
  "@mentorship/ai": p("./packages/ai/src/index.ts"),
  "@mentorship/auth/postgres": p("./packages/auth/src/postgres.ts"),
  "@mentorship/auth": p("./packages/auth/src/index.ts"),
};

export default defineConfig({
  resolve: { alias: aliases },
  test: {
    include: ["packages/**/*.test.ts", "apps/**/*.test.ts"],
    // The journey suite has its own config and command (`pnpm test:e2e`):
    // it needs Postgres unconditionally, and `pnpm test` must stay runnable
    // on a laptop with none.
    exclude: [...configDefaults.exclude, "tests/e2e/**"],
    environment: "node",
  },
});
