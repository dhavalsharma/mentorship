import { describe, expect, it } from "vitest";
import { FakeSheet, Recorder } from "@mentorship/integrations";

/**
 * The in-memory stand-in for `GoogleSheetsAdapter` — what `apps/worker`'s
 * report-sync tests and `pnpm demo`-adjacent tooling run against. Same
 * create-once-then-reuse property the real adapter's own test suite proves
 * against a stubbed transport, proven here against the fake instead: a
 * second sync with the id the first one returned must never create a
 * second spreadsheet.
 */

describe("FakeSheet", () => {
  it("creates a spreadsheet when none is configured", async () => {
    const sheet = new FakeSheet(new Recorder());
    const result = await sheet.ensureSpreadsheet({
      spreadsheetId: null,
      title: "Reports",
      idempotencyKey: "k1",
    });
    expect(result.spreadsheetId).toBe("sheet_1");
    expect(result.url).toContain("sheet_1");
  });

  it("create-once-then-reuse: a second ensureSpreadsheet with the returned id never creates a second one", async () => {
    const recorder = new Recorder();
    const sheet = new FakeSheet(recorder);

    const first = await sheet.ensureSpreadsheet({
      spreadsheetId: null,
      title: "Reports",
      idempotencyKey: "k1",
    });
    const second = await sheet.ensureSpreadsheet({
      spreadsheetId: first.spreadsheetId,
      title: "Reports",
      idempotencyKey: "k2",
    });

    expect(second.spreadsheetId).toBe(first.spreadsheetId);
    expect(recorder.of("sheet.created")).toHaveLength(1);
  });

  it("writes a tab's columns and rows, retrievable via the test hook", async () => {
    const sheet = new FakeSheet(new Recorder());
    const { spreadsheetId } = await sheet.ensureSpreadsheet({
      spreadsheetId: null,
      title: "Reports",
      idempotencyKey: "k1",
    });

    await sheet.writeTab({
      spreadsheetId,
      tabTitle: "Risk findings",
      columns: ["id", "severity"],
      rows: [["rf1", "amber"]],
      idempotencyKey: "k1",
    });

    expect(sheet.tab(spreadsheetId, "Risk findings")).toEqual({
      columns: ["id", "severity"],
      rows: [["rf1", "amber"]],
    });
    expect(sheet.tabTitles(spreadsheetId)).toEqual(["Risk findings"]);
  });

  it("second write overwrites the tab entirely rather than appending", async () => {
    const sheet = new FakeSheet(new Recorder());
    const { spreadsheetId } = await sheet.ensureSpreadsheet({
      spreadsheetId: null,
      title: "Reports",
      idempotencyKey: "k1",
    });

    await sheet.writeTab({
      spreadsheetId,
      tabTitle: "Nudges",
      columns: ["id"],
      rows: [["a"], ["b"]],
      idempotencyKey: "k1",
    });
    await sheet.writeTab({
      spreadsheetId,
      tabTitle: "Nudges",
      columns: ["id"],
      rows: [["z"]],
      idempotencyKey: "k2",
    });

    expect(sheet.tab(spreadsheetId, "Nudges")?.rows).toEqual([["z"]]);
  });

  it("adds a second tab alongside the first without disturbing it", async () => {
    const sheet = new FakeSheet(new Recorder());
    const { spreadsheetId } = await sheet.ensureSpreadsheet({
      spreadsheetId: null,
      title: "Reports",
      idempotencyKey: "k1",
    });

    await sheet.writeTab({
      spreadsheetId,
      tabTitle: "Risk findings",
      columns: ["id"],
      rows: [["rf1"]],
      idempotencyKey: "k1",
    });
    await sheet.writeTab({
      spreadsheetId,
      tabTitle: "Nudges",
      columns: ["id"],
      rows: [["n1"]],
      idempotencyKey: "k2",
    });

    expect(sheet.tabTitles(spreadsheetId).sort()).toEqual(["Nudges", "Risk findings"]);
    expect(sheet.tab(spreadsheetId, "Risk findings")?.rows).toEqual([["rf1"]]);
  });

  it("reports no tab written for an unknown spreadsheet", () => {
    expect(new FakeSheet(new Recorder()).tab("nope", "Nudges")).toBeUndefined();
  });
});
