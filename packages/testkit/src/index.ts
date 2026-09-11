/**
 * An in-memory world: everything `packages/db` and `packages/api` would
 * provide, minus the database. It exists so the saga, the integration layer and
 * the roster importer can be driven end to end by tests and by `pnpm demo`,
 * and so a contributor can change the session flow and see the consequences in
 * under a second.
 */
export * from "./world.js";
export * from "./bootstrap.js";
