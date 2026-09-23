import { defineConfig } from "vitest/config";
import base from "./vitest.config";

/**
 * The live vendor contract suite (`pnpm test:contracts:live`) — and only that.
 * Same aliases as the default config, a disjoint include: the default config
 * collects `packages/**` and `apps/**` only, so `tests/contracts/live` can
 * never run as part of `pnpm test`. Sequential, because the calls share one
 * sandbox and one fixture directory, and slow-tolerant, because it is a
 * network.
 */
export default defineConfig({
  resolve: base.resolve,
  test: {
    include: ["tests/contracts/live/**/*.contract.ts"],
    environment: "node",
    fileParallelism: false,
    testTimeout: 60_000,
    hookTimeout: 60_000,
  },
});
