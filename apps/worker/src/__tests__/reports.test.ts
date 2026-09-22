import { describe, expect, it } from "vitest";
import {
  chooseSheetConfig,
  REPORT_SOURCES,
  sheetConfigFromEnv,
  shapeNudgeRow,
  shapeRiskFindingRow,
} from "../reports.js";

/**
 * Pure, DB-free unit tests: the row-shaping functions each report type uses
 * (mirroring `digest.test.ts`'s split of `summarizeDigest` from the Postgres
 * query it feeds), and the `sheet` slot's config-resolution rule (mirroring
 * `document-config.test.ts`'s `chooseDocumentConfig`/`documentConfigFromEnv`
 * tests). The report-sync job's own Postgres wiring — `createReportSyncRunner`
 * actually reading `risk_findings`/`nudges` and running on schedule — is
 * covered by `report-sync.test.ts`, gated on `DATABASE_URL` the same way
 * `worker-schedules.test.ts` gates the progress sweep.
 */

describe("shapeRiskFindingRow", () => {
  it("shapes a full row into primitive-valued cells", () => {
    expect(
      shapeRiskFindingRow({
        id: "rf1",
        pairingId: "p1",
        code: "no_session_in_window",
        severity: "amber",
        detectedAt: new Date("2026-09-01T00:00:00.000Z"),
        summary: "No session booked in 21 days.",
        requiresHuman: true,
        acknowledgedAt: null,
      }),
    ).toEqual([
      "rf1",
      "p1",
      "no_session_in_window",
      "amber",
      "2026-09-01T00:00:00.000Z",
      "No session booked in 21 days.",
      true,
      "",
    ]);
  });

  it("renders an acknowledged timestamp rather than leaving it blank", () => {
    const [, , , , , , , acknowledgedAt] = shapeRiskFindingRow({
      id: "rf1",
      pairingId: "p1",
      code: "c",
      severity: "red",
      detectedAt: new Date("2026-09-01T00:00:00.000Z"),
      summary: "s",
      requiresHuman: false,
      acknowledgedAt: new Date("2026-09-02T00:00:00.000Z"),
    });
    expect(acknowledgedAt).toBe("2026-09-02T00:00:00.000Z");
  });
});

describe("shapeNudgeRow", () => {
  it("shapes a full row, defaulting nullable fields to empty strings", () => {
    expect(
      shapeNudgeRow({
        id: "n1",
        pairingId: null,
        recipientParticipantId: "part1",
        channel: "slack",
        state: "dropped",
        escalationLevel: 1,
        dedupeKey: "dk1",
        droppedReason: "muted",
        sentAt: null,
        createdAt: new Date("2026-09-01T00:00:00.000Z"),
      }),
    ).toEqual([
      "n1",
      "",
      "part1",
      "slack",
      "dropped",
      1,
      "dk1",
      "muted",
      "",
      "2026-09-01T00:00:00.000Z",
    ]);
  });

  it("renders sentAt and pairingId when present", () => {
    const row = shapeNudgeRow({
      id: "n1",
      pairingId: "p1",
      recipientParticipantId: "part1",
      channel: "slack",
      state: "sent",
      escalationLevel: 0,
      dedupeKey: "dk1",
      droppedReason: null,
      sentAt: new Date("2026-09-03T00:00:00.000Z"),
      createdAt: new Date("2026-09-01T00:00:00.000Z"),
    });
    expect(row[1]).toBe("p1");
    expect(row[8]).toBe("2026-09-03T00:00:00.000Z");
  });
});

describe("REPORT_SOURCES registry", () => {
  it("registers risk-findings and nudges, each with matching columns/id", () => {
    expect(Object.keys(REPORT_SOURCES).sort()).toEqual(["nudges", "risk-findings"]);
    expect(REPORT_SOURCES["risk-findings"]!.id).toBe("risk-findings");
    expect(REPORT_SOURCES["risk-findings"]!.columns).toContain("severity");
    expect(REPORT_SOURCES["nudges"]!.id).toBe("nudges");
    expect(REPORT_SOURCES["nudges"]!.columns).toContain("dedupeKey");
  });
});

describe("sheetConfigFromEnv", () => {
  it("is null without a folder", () => {
    expect(sheetConfigFromEnv({})).toBeNull();
    expect(sheetConfigFromEnv({ GOOGLE_SHEETS_SPREADSHEET_ID: "S1" })).toBeNull();
  });

  it("leaves the spreadsheet id off when only a folder is configured", () => {
    expect(sheetConfigFromEnv({ GOOGLE_SHEETS_FOLDER_ID: "F1" })).toEqual({ folderId: "F1" });
  });

  it("carries both when both are set", () => {
    expect(
      sheetConfigFromEnv({
        GOOGLE_SHEETS_FOLDER_ID: "F1",
        GOOGLE_SHEETS_SPREADSHEET_ID: "S1",
      }),
    ).toEqual({ folderId: "F1", spreadsheetId: "S1" });
  });

  it("accepts URLs as well as bare ids, same as documentConfigFromEnv", () => {
    expect(
      sheetConfigFromEnv({
        GOOGLE_SHEETS_FOLDER_ID: "https://drive.google.com/drive/folders/F1",
        GOOGLE_SHEETS_SPREADSHEET_ID: "https://docs.google.com/spreadsheets/d/S1/edit",
      }),
    ).toEqual({ folderId: "F1", spreadsheetId: "S1" });
  });
});

describe("chooseSheetConfig", () => {
  it("prefers a stored binding row over the environment", () => {
    expect(
      chooseSheetConfig(
        { folderId: "FROM_DB", spreadsheetId: "S_DB" },
        { GOOGLE_SHEETS_FOLDER_ID: "FROM_ENV" },
      ),
    ).toEqual({ config: { folderId: "FROM_DB", spreadsheetId: "S_DB" }, source: "binding" });
  });

  it("does not merge the two sources", () => {
    const resolved = chooseSheetConfig(
      { folderId: "FROM_DB" },
      { GOOGLE_SHEETS_SPREADSHEET_ID: "S_ENV" },
    );
    expect(resolved.config).toEqual({ folderId: "FROM_DB" });
  });

  it("falls back to the environment when the row is absent or empty", () => {
    for (const stored of [undefined, null, {}]) {
      expect(chooseSheetConfig(stored, { GOOGLE_SHEETS_FOLDER_ID: "FROM_ENV" })).toEqual({
        config: { folderId: "FROM_ENV" },
        source: "env",
      });
    }
  });

  it("resolves to nothing when neither source is configured", () => {
    expect(chooseSheetConfig(undefined, {})).toEqual({ config: null, source: "none" });
  });
});
