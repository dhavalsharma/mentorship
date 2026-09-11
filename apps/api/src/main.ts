import { commitRosterImport, planRosterImport } from "@mentorship/roster";
import { bootstrap } from "@mentorship/testkit";
import { createServer } from "./server.js";

/**
 * Runs the Slack interaction route against the in-memory testkit world — the
 * same stand-in `pnpm demo` uses — so the endpoint can actually be pointed at
 * (curl it, or point ngrok and a real Slack app's Interactivity URL at it)
 * before `packages/db`'s Postgres wiring exists. Swapping `harness.world` for
 * real `identity_links` / `agreements` queries is the pending step (see
 * ROADMAP.md phase 1); nothing about the route itself needs to change, since
 * it only ever talks to the `ChatIdentityResolver` / `AgreementResponder`
 * ports.
 *
 * Run with: pnpm serve:api
 */

const PORT = Number(process.env["PORT"] ?? 8787);
const SIGNING_SECRET = process.env["SLACK_SIGNING_SECRET"];
if (!SIGNING_SECRET) {
  console.error("SLACK_SIGNING_SECRET is required");
  process.exit(1);
}

const ONE_PAIR = [
  "mentor_email,mentor_name,mentee_email,mentee_name,cadence,mentor_slack,mentee_slack,mentor_tz,mentee_tz",
  "arjun.rao@wekancode.com,Arjun Rao,priya.menon@wekancode.com,Priya Menon,fortnightly,U-ARJUN,U-PRIYA,+05:30,+05:30",
].join("\n");

const harness = bootstrap();

const plan = planRosterImport(ONE_PAIR, {
  policy: harness.policy,
  defaultTzOffsetMinutes: 330,
});
const committed = await commitRosterImport(plan, harness.world, {
  importedPairsStart: "active",
});
await harness.dispatcher.settle();

const pairingId = committed.created[0]!.pairingId;
const agreement = harness.world.latestAgreementFor(pairingId)!;

console.log(`Seeded pairing ${pairingId} with agreement ${agreement.id}.`);
console.log("Options offered:");
for (const option of agreement.options) {
  console.log(`  ${option.optionId}  ${option.label}`);
}
console.log(
  "\nSlack user ids U-ARJUN and U-PRIYA are mapped to this pair. A real\n" +
    "button click carries its agreementId/optionId in the action value, so\n" +
    "there is nothing else to configure to try this by hand.\n",
);

const server = createServer({
  slackSigningSecret: SIGNING_SECRET,
  identity: {
    resolveParticipantId: async (externalId) =>
      harness.world.resolveParticipantIdByChatRef(externalId),
  },
  responder: {
    respond: (input) =>
      harness.world.respond(
        input.agreementId,
        input.participantId,
        input.kind,
        input.optionId,
      ),
  },
  onUnhandled: (reason, detail) => {
    console.warn(`[slack] ${reason}`, detail);
  },
});

server.listen(PORT, () => {
  console.log(`api listening on :${PORT} (POST /slack/interactions)`);
});
