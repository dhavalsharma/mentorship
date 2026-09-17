/**
 * Enforces CLAUDE.md's invariant 1 and invariant 2 (the one-way dependency
 * direction) in CI. Rules here are a direct translation of that section —
 * see the repo root CLAUDE.md before changing any of them.
 *
 * `packages apps` are the roots dependency-cruiser is asked to crawl
 * (see the `deps:check` script); this config only needs to describe what
 * is forbidden, resolution (tsConfig paths) and what to skip.
 */
module.exports = {
  forbidden: [
    {
      name: "core-has-no-infra-deps",
      severity: "error",
      comment:
        "Invariant 1: packages/core has zero infrastructure dependencies. " +
        "No db, no HTTP, no model client, and no dependency on any other " +
        "workspace package or app — core imports nothing but zod and node " +
        "builtins. If a type is needed in two packages, it belongs in core, " +
        "not the other way around.",
      from: { path: "^packages/core" },
      to: {
        path: "^(packages/(?!core/)|apps/)",
      },
    },
    {
      name: "workflows-no-direct-db",
      severity: "error",
      comment:
        "Invariant 2: a saga must never import db; it reads through " +
        "SagaResolvers. The one deliberate exception is workflows' own " +
        "postgres.ts (and the postgres-*.ts files it re-exports, plus " +
        "their colocated tests) which is kept out of the package's default " +
        "index.ts export specifically so the no-database test suite and " +
        "`pnpm demo` never load the pg driver. Every other file under " +
        "packages/workflows must reach Postgres through that one seam.",
      from: {
        path: "^packages/workflows/src",
        pathNot:
          "^packages/workflows/src/(postgres|postgres-store|postgres-resolvers|postgres-sink|postgres-projector|relay)\\.ts$|^packages/workflows/src/__tests__/(postgres-store|postgres-resolvers|postgres-projector|relay)\\.test\\.ts$",
      },
      to: { path: "^packages/db" },
    },
    {
      name: "primitives-no-direct-db",
      severity: "error",
      comment:
        "Invariant 2, extended to primitives: packages/primitives/* depend " +
        "only on core and ai. Where a primitive needs Postgres for a sweep " +
        "or a persisted read model (e.g. progress), it goes through that " +
        "primitive's own postgres.ts escape hatch, kept out of its index.ts " +
        "the same way workflows/postgres.ts is — never a direct import from " +
        "the primitive's main code.",
      from: {
        path: "^packages/primitives/([^/]+)/src",
        pathNot: "^packages/primitives/([^/]+)/src/postgres\\.ts$",
      },
      to: { path: "^packages/db" },
    },
    {
      name: "ai-no-direct-db",
      severity: "error",
      comment:
        "Same pattern as workflows and the primitives: packages/ai depends " +
        "on db only via its own ./postgres subpath export (packages/ai/src" +
        "/postgres.ts), so the main @mentorship/ai entry point stays " +
        "driver-free for callers that never touch Postgres.",
      from: {
        path: "^packages/ai/src",
        pathNot: "^packages/ai/src/postgres\\.ts$",
      },
      to: { path: "^packages/db" },
    },
    {
      name: "auth-no-direct-db",
      severity: "error",
      comment:
        "Same pattern as workflows, the primitives, and ai: packages/auth " +
        "depends on db only via its own ./postgres subpath export " +
        "(packages/auth/src/postgres.ts), so the main @mentorship/auth " +
        "entry point stays driver-free for callers (like packages/enrollment " +
        "or a future in-memory test double) that never touch Postgres.",
      from: {
        path: "^packages/auth/src",
        pathNot: "^packages/auth/src/postgres\\.ts$",
      },
      to: { path: "^packages/db" },
    },
    {
      name: "integrations-no-reverse-deps",
      severity: "error",
      comment:
        "Dependency direction is one-way: integrations -> core, never the " +
        "reverse. Adapters are a leaf layer — they must not import " +
        "workflows (which depends on integrations), db (a saga-only " +
        "concern reached via resolvers), or any app.",
      from: { path: "^packages/integrations" },
      to: { path: "^(packages/workflows|packages/db|apps/)" },
    },
    {
      name: "db-only-from-api-jobs-workflows",
      severity: "error",
      comment:
        "Invariant 2: packages/db is reached only from apps/api, " +
        "apps/worker (the 'jobs' runner) and packages/workflows (via its " +
        "postgres.ts seam, covered by the workflows-no-direct-db rule). " +
        "No other package — core, events, integrations, roster, enrollment, " +
        "ai's main entry, auth's main entry, or any primitive's main entry " +
        "— may import it directly.",
      from: {
        path: "^packages/(core|events|integrations|roster|enrollment)",
      },
      to: { path: "^packages/db" },
    },
  ],
  options: {
    tsConfig: {
      fileName: "tsconfig.json",
    },
    doNotFollow: {
      path: "node_modules",
    },
    exclude: {
      path: "node_modules",
    },
    enhancedResolveOptions: {
      exportsFields: ["exports"],
      conditionNames: ["import", "require", "node", "default"],
    },
  },
};
