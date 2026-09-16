import { createClient } from "@mentorship/db";
import { commitRosterImport, planRosterImport } from "@mentorship/roster";
import { bootstrap } from "@mentorship/testkit";
import {
  PostgresAgreementResponder,
  PostgresChatIdentityResolver,
} from "./postgres-ports.js";
import { listOpenRiskFindings, listRecentNudges } from "./postgres-reads.js";
import {
  createServer,
  notImplementedReads,
  type ApiServerDeps,
} from "./server.js";

/**
 * Two backends behind the same route.
 *
 * With DATABASE_URL set it runs on Postgres: verified `identity_links` for the
 * clicking user, and a response recorded alongside its `agreement.responded`
 * event in one transaction. The saga advances when the relay drains that event
 * — and the relay is not built yet (ROADMAP phase 1, pg-boss), so on this path
 * the click is durably recorded and nothing moves until it is. That is the
 * honest state, and it is better than a relay that looks like it works.
 *
 * Without one it runs on the in-memory testkit world, seeded with a pair, so
 * the endpoint can be curled with no infrastructure at all.
 *
 * Run with: pnpm serve:api
 */

const PORT = Number(process.env["PORT"] ?? 8787);
const SIGNING_SECRET = process.env["SLACK_SIGNING_SECRET"];
if (!SIGNING_SECRET) {
  console.error("SLACK_SIGNING_SECRET is required");
  process.exit(1);
}

const DATABASE_URL = process.env["DATABASE_URL"];
const ORG_ID = process.env["ORG_ID"];
const TENANT_ROLE = process.env["TENANT_ROLE"];

const onUnhandled = (reason: string, detail: Record<string, unknown>): void => {
  console.warn(`[slack] ${reason}`, detail);
};

const deps: ApiServerDeps = DATABASE_URL
  ? postgresDeps(DATABASE_URL)
  : await memoryDeps();

const server = createServer(deps);
server.listen(PORT, () => {
  console.log(`api listening on :${PORT} (POST /slack/interactions)`);
});

// ---------------------------------------------------------------------------

function postgresDeps(url: string): ApiServerDeps {
  if (!ORG_ID) {
    console.error(
      "ORG_ID is required with DATABASE_URL — a multi-workspace Slack app " +
        "would resolve team_id to an org, and that mapping is not built yet",
    );
    process.exit(1);
  }
  const { db } = createClient(url);
  const options = {
    db,
    orgId: ORG_ID,
    ...(TENANT_ROLE === undefined ? {} : { role: TENANT_ROLE }),
  };

  console.log(`Backed by Postgres, org ${ORG_ID}.`);
  if (!TENANT_ROLE) {
    console.log(
      "TENANT_ROLE is unset: if this connection is a superuser it bypasses RLS.",
    );
  }
  console.log(
    "Responses land in `agreements` and `events`; no relay is running, so no " +
      "saga will advance until one is.\n",
  );

  return {
    slackSigningSecret: SIGNING_SECRET!,
    identity: new PostgresChatIdentityResolver(options),
    responder: new PostgresAgreementResponder(options),
    onUnhandled,
    admin: {
      riskFindings: (orgId, limit) =>
        listOpenRiskFindings(db, orgId, limit, TENANT_ROLE),
      nudges: (orgId, limit) => listRecentNudges(db, orgId, limit, TENANT_ROLE),
    },
  };
}

const ONE_PAIR = [
  "mentor_email,mentor_name,mentee_email,mentee_name,cadence,mentor_slack,mentee_slack,mentor_tz,mentee_tz",
  "arjun.rao@wekancode.com,Arjun Rao,priya.menon@wekancode.com,Priya Menon,fortnightly,U-ARJUN,U-PRIYA,+05:30,+05:30",
].join("\n");

async function memoryDeps(): Promise<ApiServerDeps> {
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

  return {
    slackSigningSecret: SIGNING_SECRET!,
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
    onUnhandled,
    // The in-memory `World` predates `risk_findings`/`nudges` — those are
    // Postgres-only concepts from this session, and there is nothing here to
    // read. A deliberate 501 beats an empty array that reads as "no findings"
    // when the honest answer is "this backend doesn't track that."
    admin: {
      riskFindings: notImplementedReads(),
      nudges: notImplementedReads(),
    },
  };
}
