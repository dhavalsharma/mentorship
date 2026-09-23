import { checkLiveContractEnv } from "./env.js";

/**
 * `pnpm test:contracts:live` runs this first and stops if it fails, so a
 * missing secret is one clear message before vitest starts, not a wall of
 * failed network calls after. The suite files re-check on import regardless —
 * this is the friendly door, not the only lock.
 */

const checked = checkLiveContractEnv(process.env);
if (!checked.ok) {
  console.error(
    [
      "live vendor contracts: refusing to run.",
      "",
      "This suite calls the real Slack and Google APIs and writes fixtures to",
      "tests/fixtures/vendor. It never runs in `pnpm test`. It needs:",
      ...checked.missing.map((m) => `  - ${m}`),
      "",
      "Nothing was sent. See docs/vendor-contracts.md and docs/live-tenant-testing.md.",
    ].join("\n"),
  );
  process.exit(1);
}

console.log(
  `live vendor contracts: env present — ${checked.env.slackMembers.length} Slack member(s) and ` +
    `${checked.env.emails.length} email(s) allowlisted; capture on, every person-addressing call guarded.`,
);
