/**
 * The nudge primitive: a temporal sweep that turns absence into events, and a
 * planner that decides — once, deliberately, behind a deterministic gate chain
 * — whether anyone should be told about it.
 *
 * Read `deficits.ts` first. The sweep is the load-bearing idea; the planner is
 * an ordinary subscriber to what it produces.
 */
export * from "./bandit.js";
export * from "./context.js";
export * from "./deficits.js";
export * from "./gates.js";
export * from "./outcomes.js";
export * from "./planner.js";
export * from "./prompts.js";
export * from "./sweep.js";
export * from "./templates.js";
