import type { AddressInfo } from "node:net";
import { afterEach, describe, expect, it } from "vitest";
import {
  createServer,
  notImplementedReads,
  type AdminListQuery,
} from "../server.js";

/**
 * Same style as `server.test.ts`: a real socket, real HTTP requests. The
 * Slack deps (`identity`/`responder`) are never exercised by these routes,
 * so they get harmless stand-ins rather than a full seeded harness.
 */

const VALID_ORG_ID = "11111111-1111-1111-1111-111111111111";

function noopIdentity() {
  return { resolveParticipantId: async () => null };
}

function noopResponder() {
  return { respond: async () => {} };
}

describe("admin read routes over a real socket", () => {
  let close: (() => void) | undefined;

  afterEach(() => {
    close?.();
    close = undefined;
  });

  async function listen(admin?: {
    riskFindings: AdminListQuery;
    nudges: AdminListQuery;
  }): Promise<string> {
    const server = createServer({
      slackSigningSecret: "test-signing-secret",
      identity: noopIdentity(),
      responder: noopResponder(),
      admin,
    });
    await new Promise<void>((resolve) => server.listen(0, resolve));
    close = () => server.close();
    const { port } = server.address() as AddressInfo;
    return `http://127.0.0.1:${port}`;
  }

  it("lists risk findings from the injected query as JSON with a 200", async () => {
    const fake = [{ id: "f1", code: "silence", severity: "amber" }];
    const riskFindings: AdminListQuery = async (orgId, limit) => {
      expect(orgId).toBe(VALID_ORG_ID);
      expect(limit).toBe(50);
      return fake;
    };
    const base = await listen({ riskFindings, nudges: notImplementedReads() });

    const res = await fetch(`${base}/orgs/${VALID_ORG_ID}/risk-findings`);
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("application/json");
    await expect(res.json()).resolves.toEqual(fake);
  });

  it("lists nudges from the injected query as JSON with a 200", async () => {
    const fake = [{ id: "n1", channel: "slack", state: "sent" }];
    const nudges: AdminListQuery = async (orgId, limit) => {
      expect(orgId).toBe(VALID_ORG_ID);
      expect(limit).toBe(50);
      return fake;
    };
    const base = await listen({ riskFindings: notImplementedReads(), nudges });

    const res = await fetch(`${base}/orgs/${VALID_ORG_ID}/nudges`);
    expect(res.status).toBe(200);
    await expect(res.json()).resolves.toEqual(fake);
  });

  it("400s a non-UUID orgId before ever calling the query", async () => {
    let called = false;
    const riskFindings: AdminListQuery = async () => {
      called = true;
      return [];
    };
    const base = await listen({ riskFindings, nudges: notImplementedReads() });

    const res = await fetch(`${base}/orgs/not-a-uuid/risk-findings`);
    expect(res.status).toBe(400);
    expect(called).toBe(false);
  });

  it("clamps an out-of-range limit rather than passing it through", async () => {
    let seenLimit: number | undefined;
    const riskFindings: AdminListQuery = async (_orgId, limit) => {
      seenLimit = limit;
      return [];
    };
    const base = await listen({ riskFindings, nudges: notImplementedReads() });

    const res = await fetch(
      `${base}/orgs/${VALID_ORG_ID}/risk-findings?limit=999999`,
    );
    expect(res.status).toBe(200);
    expect(seenLimit).toBe(200);
  });

  it("falls back to the default limit on a garbage limit param", async () => {
    let seenLimit: number | undefined;
    const riskFindings: AdminListQuery = async (_orgId, limit) => {
      seenLimit = limit;
      return [];
    };
    const base = await listen({ riskFindings, nudges: notImplementedReads() });

    const res = await fetch(
      `${base}/orgs/${VALID_ORG_ID}/risk-findings?limit=not-a-number`,
    );
    expect(res.status).toBe(200);
    expect(seenLimit).toBe(50);
  });

  it("501s with a JSON body when the backend does not track the resource", async () => {
    const base = await listen({
      riskFindings: notImplementedReads(),
      nudges: notImplementedReads(),
    });

    const res = await fetch(`${base}/orgs/${VALID_ORG_ID}/risk-findings`);
    expect(res.status).toBe(501);
    expect(res.headers.get("content-type")).toContain("application/json");
    const body = (await res.json()) as { error: string };
    expect(body.error).toMatch(/risk-findings/);
  });

  it("501s when the server has no admin deps configured at all", async () => {
    const base = await listen(undefined);

    const res = await fetch(`${base}/orgs/${VALID_ORG_ID}/nudges`);
    expect(res.status).toBe(501);
    const body = (await res.json()) as { error: string };
    expect(body.error).toBeTruthy();
  });

  it("still 404s an unrelated unknown route", async () => {
    const base = await listen(undefined);
    const res = await fetch(`${base}/orgs/${VALID_ORG_ID}/something-else`);
    expect(res.status).toBe(404);
  });
});
