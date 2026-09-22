import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import { EventLog } from "@mentorship/events";
import { organizations, riskFindings, withTenant } from "@mentorship/db";
import { connectTestDb, DATABASE_URL, type TestDb } from "@mentorship/db/testing";
import { runDigestSweep, summarizeDigest } from "../digest.js";

describe("summarizeDigest", () => {
  it("counts risk findings by severity and dropped/sent/planned nudges", () => {
    const summary = summarizeDigest({
      windowStart: "2026-09-01T00:00:00.000Z",
      windowEnd: "2026-09-02T00:00:00.000Z",
      riskFindingRows: [
        { createdAt: new Date(), severity: "high", requiresHuman: true },
        { createdAt: new Date(), severity: "high", requiresHuman: false },
        { createdAt: new Date(), severity: "low", requiresHuman: false },
      ],
      nudgeRows: [
        { createdAt: new Date(), state: "sent" },
        { createdAt: new Date(), state: "sent" },
        { createdAt: new Date(), state: "dropped" },
        { createdAt: new Date(), state: "planned" },
      ],
    });

    expect(summary.riskFindings.total).toBe(3);
    expect(summary.riskFindings.requiresHuman).toBe(1);
    expect(summary.riskFindings.bySeverity).toEqual({ high: 2, low: 1 });
    expect(summary.nudges).toEqual({ total: 4, sent: 2, dropped: 1, planned: 1 });
  });

  it("is honest about an empty window rather than omitting the fields", () => {
    const summary = summarizeDigest({
      windowStart: "2026-09-01T00:00:00.000Z",
      windowEnd: "2026-09-02T00:00:00.000Z",
      riskFindingRows: [],
      nudgeRows: [],
    });

    expect(summary.riskFindings).toEqual({ total: 0, requiresHuman: 0, bySeverity: {} });
    expect(summary.nudges).toEqual({ total: 0, sent: 0, dropped: 0, planned: 0 });
  });
});

/**
 * The Postgres half: real `risk_findings` / `nudges` rows, two orgs, proving
 * the digest counts only its own tenant's rows and that the computed summary
 * lands as a durable `digest.computed` event rather than being silently
 * dropped. Skipped without DATABASE_URL, same as every other Postgres suite
 * in this repo.
 */
describe.skipIf(!DATABASE_URL)("runDigestSweep, on Postgres", () => {
  it("is org-scoped and writes one digest.computed event with the computed counts", async () => {
    let handle: TestDb | undefined;
    try {
      handle = await connectTestDb();
      const { db } = handle;

      const orgA = randomUUID();
      const orgB = randomUUID();
      for (const orgId of [orgA, orgB]) {
        await db.insert(organizations).values({ id: orgId, name: "Org", slug: `org-${orgId.slice(0, 8)}` });
      }

      const pairingId = randomUUID();
      await withTenant(db, orgA, async (tx) => {
        await tx.insert(riskFindings).values({
          orgId: orgA,
          pairingId,
          code: "cadence_declining",
          severity: "high",
          detectedAt: new Date(),
          summary: "test",
          requiresHuman: true,
          evidence: [],
        });
      });
      await withTenant(db, orgB, async (tx) => {
        await tx.insert(riskFindings).values({
          orgId: orgB,
          pairingId: randomUUID(),
          code: "cadence_declining",
          severity: "high",
          detectedAt: new Date(),
          summary: "should not be counted for org A",
          requiresHuman: true,
          evidence: [],
        });
      });

      const log = new EventLog();
      const summary = await runDigestSweep({ db, orgId: orgA, sink: log });

      expect(summary.riskFindings.total).toBe(1);
      expect(summary.riskFindings.bySeverity).toEqual({ high: 1 });

      const events = log.all().filter((e) => e.name === "digest.computed");
      expect(events).toHaveLength(1);
      expect(events[0]?.orgId).toBe(orgA);
      expect(events[0]?.payload).toMatchObject({ riskFindings: { total: 1 } });
    } finally {
      await handle?.close();
    }
  });
});
