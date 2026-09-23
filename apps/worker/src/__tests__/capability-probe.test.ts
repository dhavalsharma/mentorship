import { randomUUID } from "node:crypto";
import { and, eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { AdapterCapabilities, DocumentAdapter } from "@mentorship/core";
import { integrationBindings, organizations } from "@mentorship/db";
import { connectTestDb, DATABASE_URL, type TestDb } from "@mentorship/db/testing";
import {
  FakeCalendar,
  FakeConversation,
  FakeDocument,
  FakeTranscript,
  IntegrationRegistry,
  Recorder,
} from "@mentorship/integrations";
import { PostgresSagaResolvers } from "@mentorship/workflows/postgres";
import { createWorker } from "../worker.js";

/**
 * Bug #10 in docs/e2e-testing-strategy.md: nothing wrote
 * `integration_bindings.capabilities`, and the Postgres resolvers read only
 * that cache, so every slot of every real tenant read as null. This proves
 * the boot probe is now the writer, and that the resolver reads what it
 * wrote — as `mentorship_app`, so RLS is live and org isolation is the
 * policy's doing rather than a WHERE clause's.
 *
 * Skipped without DATABASE_URL — see packages/db/src/testing.ts.
 */

const ROLE = "mentorship_app";

/** A document slot whose vendor is down at boot. */
class ThrowingProbeDocument extends FakeDocument {
  override async probe(): Promise<AdapterCapabilities> {
    throw new Error("drive 503 during probe");
  }
}

describe.skipIf(!DATABASE_URL)("boot capability probe, on Postgres", () => {
  let handle: TestDb;
  const orgA = randomUUID();
  const orgB = randomUUID();
  const at = new Date("2026-09-14T06:00:00.000Z");

  const bindings = (orgId: string) =>
    handle.db.select().from(integrationBindings).where(eq(integrationBindings.orgId, orgId));

  beforeAll(async () => {
    handle = await connectTestDb();
    for (const id of [orgA, orgB]) {
      await handle.db
        .insert(organizations)
        .values({ id, name: "Probe", slug: `probe-${id.slice(0, 8)}` });
    }
    // Org B already has a binding with a cached answer; nothing about org A's
    // boot may touch it.
    await handle.db.insert(integrationBindings).values({
      orgId: orgB,
      slot: "transcript",
      adapterId: "fake-transcript",
      capabilities: { autoTranscription: "byo" },
      probedAt: new Date("2026-01-01T00:00:00.000Z"),
    });
  });

  afterAll(async () => {
    if (!handle) return;
    for (const id of [orgA, orgB]) {
      await handle.db.delete(integrationBindings).where(eq(integrationBindings.orgId, id));
      await handle.db.delete(organizations).where(eq(organizations.id, id));
    }
    await handle.close();
  });

  it("writes probed capabilities that the resolver then reads, and records a throwing probe without failing", async () => {
    const recorder = new Recorder();
    const registry = new IntegrationRegistry();
    registry.bind(new FakeConversation(recorder));
    registry.bind(new FakeCalendar(recorder, {}));
    registry.bind(new FakeTranscript(recorder, { autoTranscription: "native" }));
    registry.bind(new ThrowingProbeDocument(recorder) as DocumentAdapter);
    const warnings: { message: string; detail?: Record<string, unknown> }[] = [];
    const onWarn = (message: string, detail?: Record<string, unknown>) =>
      warnings.push({ message, ...(detail ? { detail } : {}) });

    const worker = createWorker({ db: handle.db, orgId: orgA, registry, role: ROLE, now: () => at, onWarn });
    const result = await worker.probeCapabilities();

    expect(result.probed.map((r) => [r.slot, r.ok])).toEqual([
      ["conversation", true],
      ["calendar", true],
      ["transcript", true],
      ["document", false],
    ]);

    const rows = new Map((await bindings(orgA)).map((r) => [r.slot, r]));
    expect(rows.get("transcript")?.capabilities).toMatchObject({ autoTranscription: "native" });
    expect(rows.get("conversation")?.capabilities).toMatchObject({ interactiveApproval: true });
    expect(rows.get("transcript")?.probedAt?.toISOString()).toBe(at.toISOString());
    expect(rows.get("transcript")?.lastError).toBeNull();
    // Unknown, not "can do nothing": null capabilities, and the reason kept.
    expect(rows.get("document")?.capabilities).toBeNull();
    expect(rows.get("document")?.lastError).toContain("drive 503");
    expect(warnings.some((w) => w.message.startsWith("capability probe failed") && w.detail?.["slot"] === "document")).toBe(true);

    const resolverWarnings: string[] = [];
    const resolvers = new PostgresSagaResolvers({
      db: handle.db,
      orgId: orgA,
      registry,
      role: ROLE,
      onWarn: (message, detail) => resolverWarnings.push(`${message} ${JSON.stringify(detail)}`),
    });
    expect((await resolvers.capabilities("transcript"))?.autoTranscription).toBe("native");
    expect((await resolvers.capabilities("conversation"))?.interactiveApproval).toBe(true);
    // The failed slot degrades — and says so, once.
    expect(await resolvers.capabilities("document")).toBeNull();
    expect(await resolvers.capabilities("document")).toBeNull();
    expect(resolverWarnings).toHaveLength(1);
    expect(resolverWarnings[0]).toContain("drive 503");
    // An unbound slot with no row is simply absent, not a warning.
    expect(await resolvers.capabilities("sheet")).toBeNull();
    expect(resolverWarnings).toHaveLength(1);
  });

  it("never writes another org's rows", async () => {
    const [row] = await bindings(orgB);
    expect(row?.capabilities).toEqual({ autoTranscription: "byo" });
    expect(row?.probedAt?.toISOString()).toBe("2026-01-01T00:00:00.000Z");
    expect(await bindings(orgB)).toHaveLength(1);
  });

  it("re-probing rebinds: a slot no longer bound is cleared, and the resolver stops trusting it", async () => {
    // The same org restarted without a transcript adapter (e.g. an admin
    // turned recording off at the vendor and the operator unbound it).
    const recorder = new Recorder();
    const registry = new IntegrationRegistry();
    registry.bind(new FakeConversation(recorder));
    const worker = createWorker({ db: handle.db, orgId: orgA, registry, role: ROLE, now: () => at });
    const result = await worker.probeCapabilities();

    expect(result.cleared.sort()).toEqual(["calendar", "document", "transcript"]);
    const [transcript] = await handle.db
      .select()
      .from(integrationBindings)
      .where(and(eq(integrationBindings.orgId, orgA), eq(integrationBindings.slot, "transcript")));
    expect(transcript?.capabilities).toBeNull();

    const resolvers = new PostgresSagaResolvers({ db: handle.db, orgId: orgA, registry, role: ROLE });
    // Without the clear, a stale "native" would send the saga polling for a
    // transcript no bound adapter can fetch.
    expect(await resolvers.capabilities("transcript")).toBeNull();
    // And org B is still untouched.
    const [b] = await bindings(orgB);
    expect(b?.capabilities).toEqual({ autoTranscription: "byo" });
  });
});
