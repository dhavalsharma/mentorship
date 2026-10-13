import { createClient } from "@mentorship/db";
import type { MagicLinkStore, StaffDirectory } from "@mentorship/auth";
import { commitRosterImport, planRosterImport } from "@mentorship/roster";
import { bootstrap } from "@mentorship/testkit";
import {
  httpSlackTransport,
  SlackWebApiModalOpener,
} from "@mentorship/integrations";
import { createMagicLinkDelivery, redactAddress } from "./auth-mail.js";
import { appBaseUrlFromEnv, buildGmailSender } from "./email-config.js";
import { cooldownSecondsFromEnv } from "./mail-cooldown.js";
import { buildPostgresApiDeps } from "./postgres-deps.js";
import {
  createServer,
  notImplementedMatchingReads,
  notImplementedPairPreferenceReads,
  notImplementedReads,
  type ApiServerDeps,
} from "./server.js";

/**
 * Two backends behind the same route.
 *
 * With DATABASE_URL set it runs on Postgres: verified `identity_links` for the
 * clicking user, and a response recorded alongside its `agreement.responded`
 * event in one transaction. The saga advances when the outbox relay drains
 * that event. The relay is built (`relayOnce`, run by `createWorker`), but this
 * process does not run one: a click only moves a saga while `pnpm serve:worker`
 * is running against the same database. Without it the click is durably
 * recorded and waits. `tests/e2e/` runs exactly this pair of processes — this
 * wiring (`buildPostgresApiDeps`) plus a worker — against one Postgres.
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
/**
 * Only needed for `views.open` — the one Slack call this process makes itself,
 * because its trigger_id expires long before the worker's relay would run an
 * effect. Everything else this app sends goes out through the worker.
 */
const SLACK_BOT_TOKEN = process.env["SLACK_BOT_TOKEN"];
const ORG_ID = process.env["ORG_ID"];
const TENANT_ROLE = process.env["TENANT_ROLE"];

const onUnhandled = (reason: string, detail: Record<string, unknown>): void => {
  console.warn(`[slack] ${reason}`, detail);
};

/**
 * Sign-in and invite links: mailed through Gmail when `GMAIL_SENDER_ADDRESS`
 * is set (docs/email-setup.md), printed to stdout otherwise. A half-configured
 * sender exits here instead of falling back to printing tokens.
 */
const magicLinkDelivery = (() => {
  try {
    const built = buildGmailSender(process.env, {
      onRefused: ({ refused }) =>
        // Domains only: the local part is somebody's mailbox, and this line
        // lands in operator logs.
        console.warn(
          `[auth] email refused by SANDBOX_ALLOWLIST: ${refused.map(redactAddress).join(", ")}`,
        ),
    });
    const appBaseUrl = appBaseUrlFromEnv(process.env);
    if (built && !appBaseUrl) {
      throw new Error("GMAIL_SENDER_ADDRESS is set but APP_BASE_URL is not — the link needs an origin");
    }
    if (built?.allowlistSize != null) {
      console.warn(
        `[auth] EMAIL ALLOWLIST ACTIVE (SANDBOX_ALLOWLIST, ${built.allowlistSize} entries): mail to any other address is refused. Unset it in production.`,
      );
    }
    const cooldownSeconds = cooldownSecondsFromEnv(process.env);
    console.log(
      built
        ? `Sign-in and invite links are emailed (${built.sender.id}), to ${appBaseUrl}/verify (at most one per address per ${cooldownSeconds}s).`
        : "No GMAIL_SENDER_ADDRESS: sign-in and invite links are printed to this log.",
    );
    return createMagicLinkDelivery({
      sender: built?.sender ?? null,
      appBaseUrl,
      cooldownSeconds,
      onUnhandled: (reason, detail) => console.warn(`[auth] ${reason}`, detail),
    });
  } catch (error) {
    console.error(error instanceof Error ? error.message : error);
    process.exit(1);
  }
})();

const ONE_PAIR = [
  "mentor_email,mentor_name,mentee_email,mentee_name,cadence,mentor_slack,mentee_slack,mentor_tz,mentee_tz",
  "arjun.rao@wekancode.com,Arjun Rao,priya.menon@wekancode.com,Priya Menon,fortnightly,U-ARJUN,U-PRIYA,+05:30,+05:30",
].join("\n");

/**
 * The in-memory world has no notion of org id at all, so this is just a
 * fixed placeholder to scope the fake `MagicLinkStore` and satisfy
 * `AuthDeps.orgId` — it never touches RLS or a real tenant.
 */
const MEMORY_ORG_ID = "00000000-0000-0000-0000-000000000000";

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

  console.log(`Backed by Postgres, org ${ORG_ID}.`);
  if (!TENANT_ROLE) {
    console.log(
      "TENANT_ROLE is unset: if this connection is a superuser it bypasses RLS.",
    );
  }
  console.log(
    "Responses land in `agreements` and `events`. This process runs no relay: " +
      "a saga advances only while `pnpm serve:worker` drains the same database.\n",
  );

  return buildPostgresApiDeps({
    db,
    orgId: ORG_ID,
    slackSigningSecret: SIGNING_SECRET!,
    ...(TENANT_ROLE === undefined ? {} : { role: TENANT_ROLE }),
    ...(SLACK_BOT_TOKEN ? { slackTransport: httpSlackTransport(SLACK_BOT_TOKEN) } : {}),
    onUnhandled,
    onMagicLinkIssued: magicLinkDelivery,
  });
}

/**
 * The in-memory testkit `World` predates auth entirely, so there is no
 * counterpart to borrow the way `admin` borrows nothing from it either.
 * This is a minimal Map-based `MagicLinkStore` — no persistence, no RLS,
 * good enough to exercise `/auth/request-link` and `/auth/verify` against
 * `pnpm serve:api` without a database.
 */
function inMemoryMagicLinkStore(users: { userId: string; email: string }[]): MagicLinkStore {
  const links = new Map<
    string,
    { userId: string; expiresAt: string; consumedAt: string | null }
  >();
  const sessions = new Map<
    string,
    { userId: string; expiresAt: string; revokedAt: string | null }
  >();
  let nextId = 1;

  return {
    async findUserByEmail(_orgId, email) {
      const user = users.find((u) => u.email === email);
      return user ? { userId: user.userId } : null;
    },
    async createLink({ userId, tokenHash, expiresAt }) {
      links.set(tokenHash, { userId, expiresAt, consumedAt: null });
    },
    async findUnconsumedLinkByTokenHash(_orgId, tokenHash) {
      const link = links.get(tokenHash);
      return link ? { ...link } : null;
    },
    async consumeLink(_orgId, tokenHash) {
      const link = links.get(tokenHash);
      if (!link || link.consumedAt !== null) return false;
      link.consumedAt = new Date().toISOString();
      return true;
    },
    async createSession({ userId, expiresAt }) {
      const sessionId = `sess-${nextId++}`;
      sessions.set(sessionId, { userId, expiresAt, revokedAt: null });
      return { sessionId };
    },
    async findActiveSession(_orgId, sessionId) {
      const session = sessions.get(sessionId);
      return session ? { ...session } : null;
    },
  };
}

/**
 * The in-memory counterpart to `users.staff_role`. Arjun is the seeded
 * admin; Priya is the mentee of the same pair and deliberately *not* staff,
 * so `pnpm serve:api` with no database still shows the 403 a signed-in
 * participant gets from every admin route (ADR-0010).
 */
function inMemoryStaffDirectory(admins: ReadonlySet<string>): StaffDirectory {
  return {
    async staffRoleOf(_orgId, userId) {
      return admins.has(userId) ? "admin" : null;
    },
  };
}

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
          input.counter,
        ),
    },
    extractions: {
      respond: (input) => harness.world.respondToExtraction(input),
    },
    ...(SLACK_BOT_TOKEN
      ? {
          preferences: {
            modals: new SlackWebApiModalOpener(
              httpSlackTransport(SLACK_BOT_TOKEN),
            ),
            store: {
              context: async (input) =>
                harness.world.pairPreferencesContext(input),
              update: async (input) => {
                const saved = await harness.world.updatePairPreferences(input);
                // No outbox here — the dispatcher is the relay.
                await harness.dispatcher.settle();
                return saved;
              },
            },
          },
        }
      : {}),
    slackEvents: {
      locator: {
        resolveByChannel: async (channelId) =>
          harness.world.resolvePairingByChannel(channelId),
      },
      notes: {
        submit: async (input) => {
          await harness.world.submitNotes(
            input.pairingId,
            input.body,
            input.noteId,
          );
          // Unlike Postgres, nothing drains an outbox here — the dispatcher is
          // the relay, so the saga moves as soon as it settles.
          await harness.dispatcher.settle();
        },
      },
    },
    onUnhandled,
    // The in-memory `World` predates `risk_findings`/`nudges`/`saga_instances`
    // monitoring/dead letters — those are Postgres-only concepts, and there is
    // nothing here to read. A deliberate 501 beats an empty array that reads
    // as "nothing stuck" when the honest answer is "this backend doesn't
    // track that."
    admin: {
      riskFindings: notImplementedReads(),
      nudges: notImplementedReads(),
      pairPreferenceChanges: notImplementedPairPreferenceReads(),
      stuckSagas: notImplementedReads(),
      deadLetters: notImplementedReads(),
      matchingRoundCandidates: notImplementedMatchingReads(),
    },
    auth: {
      store: inMemoryMagicLinkStore([
        { userId: "user-arjun", email: "arjun.rao@wekancode.com" },
        { userId: "user-priya", email: "priya.menon@wekancode.com" },
      ]),
      staff: inMemoryStaffDirectory(new Set(["user-arjun"])),
      orgId: MEMORY_ORG_ID,
      onMagicLinkIssued: magicLinkDelivery,
    },
  };
}
