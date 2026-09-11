import { createHmac } from "node:crypto";
import type { AddressInfo } from "node:net";
import { afterEach, describe, expect, it } from "vitest";
import { commitRosterImport, planRosterImport } from "@mentorship/roster";
import { bootstrap, type Harness } from "@mentorship/testkit";
import { createServer } from "../server.js";

/**
 * Unlike `packages/testkit/src/__tests__/slack-webhook.test.ts` (which calls
 * `handleSlackInteraction` directly with an in-process request object), this
 * exercises the actual `node:http` wiring: a real socket, real header
 * folding, a real chunked request body read off the wire. That is the part
 * the pure-function tests cannot cover.
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

async function seed() {
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
  return { harness, agreement: harness.world.latestAgreementFor(pairingId)! };
}

describe("the interaction route over a real socket", () => {
  let close: (() => void) | undefined;

  afterEach(() => {
    close?.();
    close = undefined;
  });

  async function listen(harness: Harness): Promise<string> {
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
      // The harness runs on a fake clock, so signature verification has to
      // check requests against that same clock rather than the wall clock.
      now: () => harness.clock.now(),
    });
    await new Promise<void>((resolve) => server.listen(0, resolve));
    close = () => server.close();
    const { port } = server.address() as AddressInfo;
    return `http://127.0.0.1:${port}`;
  }

  it("answers GET /healthz", async () => {
    const { harness } = await seed();
    const base = await listen(harness);
    const res = await fetch(`${base}/healthz`);
    expect(res.status).toBe(200);
  });

  it("404s an unknown route", async () => {
    const { harness } = await seed();
    const base = await listen(harness);
    const res = await fetch(`${base}/nope`);
    expect(res.status).toBe(404);
  });

  it("takes a real signed click over the wire and advances the saga", async () => {
    const { harness, agreement } = await seed();
    const base = await listen(harness);
    const chosen = agreement.options[1]!;

    const body = slackClickBody("U-ARJUN", agreement.id, chosen.optionId);
    const timestamp = String(Math.floor(harness.clock.now().getTime() / 1000));
    const res = await fetch(`${base}/slack/interactions`, {
      method: "POST",
      headers: {
        "x-slack-request-timestamp": timestamp,
        "x-slack-signature": sign(body, timestamp),
        "content-type": "application/x-www-form-urlencoded",
      },
      body,
    });
    expect(res.status).toBe(200);

    const arjunId = harness.world.resolveParticipantIdByChatRef("U-ARJUN");
    const priyaId = agreement.participantIds.find((p) => p !== arjunId)!;
    await harness.world.respond(agreement.id, priyaId, "accept", chosen.optionId);
    await harness.dispatcher.settle();

    const [instance] = await harness.engine.instances();
    expect((instance!.state as { name: string }).name).toBe("armed");
  });

  it("401s a request signed with the wrong secret, over the wire", async () => {
    const { harness, agreement } = await seed();
    const base = await listen(harness);
    const body = slackClickBody(
      "U-ARJUN",
      agreement.id,
      agreement.options[0]!.optionId,
    );
    const timestamp = String(Math.floor(harness.clock.now().getTime() / 1000));
    const res = await fetch(`${base}/slack/interactions`, {
      method: "POST",
      headers: {
        "x-slack-request-timestamp": timestamp,
        "x-slack-signature": sign(body, timestamp, "wrong-secret"),
      },
      body,
    });
    expect(res.status).toBe(401);

    const stillPending = harness.world.latestAgreementFor(
      // re-fetch via the pairing implied by the agreement's own participants
      // is unnecessary — `agreements` is keyed by id directly.
      agreement.pairingId,
    )!;
    expect(stillPending.responses).toHaveLength(0);
  });
});
