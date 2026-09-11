import { createHmac } from "node:crypto";
import { describe, expect, it } from "vitest";
import { commitRosterImport, planRosterImport } from "@mentorship/roster";
import {
  handleSlackInteraction,
  type AgreementResponder,
  type ChatIdentityResolver,
} from "@mentorship/integrations";
import { bootstrap } from "../bootstrap.js";

/**
 * The roadmap calls the Slack interaction endpoint "the single highest-value
 * next task... what makes the flow real for actual humans". Every other test
 * in the repo drives an agreement through `World.respond()` directly; this
 * one drives it through a genuinely signed HTTP-shaped webhook request, to
 * prove the endpoint composes with the real saga rather than only with mocks.
 */

const SIGNING_SECRET = "test-signing-secret";

const ONE_PAIR = [
  "mentor_email,mentor_name,mentee_email,mentee_name,cadence,mentor_slack,mentee_slack,mentor_tz,mentee_tz",
  "arjun.rao@wekancode.com,Arjun Rao,priya.menon@wekancode.com,Priya Menon,fortnightly,U-ARJUN,U-PRIYA,+05:30,+05:30",
].join("\n");

function sign(rawBody: string, timestamp: string, secret = SIGNING_SECRET): string {
  const base = `v0:${timestamp}:${rawBody}`;
  return "v0=" + createHmac("sha256", secret).update(base).digest("hex");
}

function slackClickBody(
  slackUserId: string,
  agreementId: string,
  optionId: string,
): string {
  const payload = {
    user: { id: slackUserId },
    actions: [
      {
        action_id: `agree:${agreementId}:${optionId}`,
        value: JSON.stringify({ agreementId, optionId, kind: "accept" }),
      },
    ],
  };
  return `payload=${encodeURIComponent(JSON.stringify(payload))}`;
}

async function seedOnePair(harness: ReturnType<typeof bootstrap>) {
  const plan = planRosterImport(ONE_PAIR, {
    policy: harness.policy,
    defaultTzOffsetMinutes: 330,
  });
  const committed = await commitRosterImport(plan, harness.world, {
    importedPairsStart: "active",
  });
  await harness.dispatcher.settle();
  const pairingId = committed.created[0]!.pairingId;
  return { pairingId, agreement: harness.world.latestAgreementFor(pairingId)! };
}

describe("Slack interaction endpoint against the real saga", () => {
  it("a real signed webhook click advances SessionLifecycle the same way World.respond() does", async () => {
    const harness = bootstrap();
    const { agreement } = await seedOnePair(harness);
    const chosen = agreement.options[1]!;

    const identity: ChatIdentityResolver = {
      resolveParticipantId: async (externalId) =>
        harness.world.resolveParticipantIdByChatRef(externalId),
    };
    const responder: AgreementResponder = {
      respond: (input) =>
        harness.world.respond(
          input.agreementId,
          input.participantId,
          input.kind,
          input.optionId,
        ),
    };

    // Arjun clicks the button in Slack — a signed webhook, not a direct call
    // into World.
    const body = slackClickBody("U-ARJUN", agreement.id, chosen.optionId);
    const timestamp = String(Math.floor(harness.clock.now().getTime() / 1000));
    const res = await handleSlackInteraction(
      {
        rawBody: body,
        headers: {
          "x-slack-request-timestamp": timestamp,
          "x-slack-signature": sign(body, timestamp),
        },
      },
      {
        signingSecret: SIGNING_SECRET,
        identity,
        responder,
        now: () => harness.clock.now(),
      },
    );
    expect(res.status).toBe(200);

    // Priya responds the ordinary way — the point of this test is that the
    // two paths converge on the same deterministic resolver.
    const arjunId = harness.world.resolveParticipantIdByChatRef("U-ARJUN");
    const priyaId = agreement.participantIds.find((p) => p !== arjunId)!;
    await harness.world.respond(agreement.id, priyaId, "accept", chosen.optionId);
    await harness.dispatcher.settle();

    const [instance] = await harness.engine.instances();
    expect((instance!.state as { name: string }).name).toBe("armed");
  });

  it("rejects a forged signature before touching identity or the agreement", async () => {
    const harness = bootstrap();
    const { pairingId, agreement } = await seedOnePair(harness);
    const chosen = agreement.options[0]!;
    const body = slackClickBody("U-ARJUN", agreement.id, chosen.optionId);

    const res = await handleSlackInteraction(
      {
        rawBody: body,
        headers: {
          "x-slack-request-timestamp": String(
            Math.floor(harness.clock.now().getTime() / 1000),
          ),
          "x-slack-signature": "v0=not-a-real-signature",
        },
      },
      {
        signingSecret: SIGNING_SECRET,
        identity: {
          resolveParticipantId: async () => {
            throw new Error("must not be reached — signature was invalid");
          },
        },
        responder: {
          respond: async () => {
            throw new Error("must not be reached — signature was invalid");
          },
        },
        now: () => harness.clock.now(),
      },
    );
    expect(res.status).toBe(401);

    const stillPending = harness.world.latestAgreementFor(pairingId)!;
    expect(stillPending.responses).toHaveLength(0);
  });
});
