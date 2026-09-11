import { defineConfig } from "vitest/config";
import { fileURLToPath } from "node:url";

const p = (rel: string) => fileURLToPath(new URL(rel, import.meta.url));

export default defineConfig({
  resolve: {
    alias: {
      "@mentorship/core": p("./packages/core/src/index.ts"),
      "@mentorship/db": p("./packages/db/src/index.ts"),
      "@mentorship/events": p("./packages/events/src/index.ts"),
      "@mentorship/workflows": p("./packages/workflows/src/index.ts"),
      "@mentorship/integrations": p("./packages/integrations/src/index.ts"),
      "@mentorship/roster": p("./packages/roster/src/index.ts"),
      "@mentorship/testkit": p("./packages/testkit/src/index.ts"),
    },
  },
  test: {
    include: ["packages/**/*.test.ts", "apps/**/*.test.ts"],
    environment: "node",
  },
});
