import { describe, expect, it } from "vitest";
import { extractSpreadsheetId, GoogleSheetsAdapter } from "@mentorship/integrations";

import { openReplay, warnOnStaleFixtures } from "./vendor-replay.js";

/**
 * No network — the transport replays `tests/fixtures/vendor/google-{drive,sheets}`
 * (tier 4, docs/e2e-testing-strategy.md), with handlers layering an in-memory
 * spreadsheet on top of the recorded responses. The replay refuses any query
 * or body field no fixture has recorded, and any response field a fixture
 * does not have, so the state below can only ever describe the API the
 * fixtures describe. What matters: the create-then-move-into-folder dance
 * when no spreadsheet is configured, reusing a configured id rather than
 * creating a second spreadsheet, adding a tab that does not exist yet, and a
 * full clear+overwrite of a tab that does.
 */

warnOnStaleFixtures("google-sheet.test.ts");

function stubTransport(
  initial: {
    /** spreadsheetId -> tab title -> { columns, rows } (already-written state) */
    tabs?: Record<string, Record<string, { columns: string[]; rows: unknown[][] }>>;
    filesByName?: Record<string, string>;
  } = {},
) {
  const replay = openReplay();
  const tabs = new Map(
    Object.entries(initial.tabs ?? {}).map(([id, t]) => [id, new Map(Object.entries(t))]),
  );
  const filesByName = new Map(Object.entries(initial.filesByName ?? {}));
  let nextSpreadsheetId = 1;
  const idOf = (path: string) => path.split("/")[2]!.replace(/:.*$/, "");

  replay
    .on("files.list", ({ request, response }) => {
      const query = request.query?.["q"] ?? "";
      for (const [name, id] of filesByName) {
        if (query.includes(`name = '${name}'`)) return { ...response, files: [{ id }] };
      }
      return response;
    })
    .on("spreadsheets.create", ({ response }) => {
      const id = `sheet_${nextSpreadsheetId++}`;
      tabs.set(id, new Map());
      return { ...response, spreadsheetId: id };
    })
    .on("spreadsheets.get", ({ request, response }) => ({
      ...response,
      sheets: [...(tabs.get(idOf(request.path))?.keys() ?? [])].map((title, sheetId) => ({
        properties: { sheetId, title },
      })),
    }))
    .on("spreadsheets.batchUpdate", ({ request, response }) => {
      const id = idOf(request.path);
      const body = request.body as {
        requests: { addSheet: { properties: { title: string } } }[];
      };
      const sheetTabs = tabs.get(id) ?? new Map();
      for (const r of body.requests) {
        sheetTabs.set(r.addSheet.properties.title, { columns: [], rows: [] });
      }
      tabs.set(id, sheetTabs);
      return response;
    })
    .on("spreadsheets.values.update", ({ request, response }) => {
      const [, , spreadsheetId, , rangeRaw] = request.path.split("/");
      const tabTitle = rangeRaw!.replace(/^'/, "").replace(/'$/, "").replace(/''/g, "'");
      const body = request.body as { values: unknown[][] };
      const sheetTabs = tabs.get(spreadsheetId!) ?? new Map();
      const [columns, ...rows] = body.values;
      sheetTabs.set(tabTitle, { columns: columns as string[], rows });
      tabs.set(spreadsheetId!, sheetTabs);
      return response;
    });

  return {
    replay,
    call: replay.googleSheets(),
    calls: replay.calls,
    tabsOf: (spreadsheetId: string) => [...(tabs.get(spreadsheetId)?.keys() ?? [])],
  };
}

const CONFIG = { folderId: "folder_1" };

describe("GoogleSheetsAdapter", () => {
  it("probes the configured folder", async () => {
    const { call, calls } = stubTransport();
    const caps = await new GoogleSheetsAdapter(call, CONFIG).probe();
    expect(caps).toBeDefined();
    expect(calls[0]).toMatchObject({ api: "drive", path: "/files/folder_1" });
  });

  describe("ensureSpreadsheet", () => {
    it("reuses the configured spreadsheet id without any calls", async () => {
      const { call, calls } = stubTransport();
      const result = await new GoogleSheetsAdapter(call, CONFIG).ensureSpreadsheet({
        spreadsheetId: "existing_1",
        title: "Reports",
        idempotencyKey: "k1",
      });
      expect(result.spreadsheetId).toBe("existing_1");
      expect(result.url).toContain("existing_1");
      expect(calls).toHaveLength(0);
    });

    it("adopts an existing spreadsheet of the same name in the folder rather than creating one", async () => {
      const { call, calls } = stubTransport({ filesByName: { Reports: "already_there" } });
      const result = await new GoogleSheetsAdapter(call, CONFIG).ensureSpreadsheet({
        spreadsheetId: null,
        title: "Reports",
        idempotencyKey: "k1",
      });
      expect(result.spreadsheetId).toBe("already_there");
      expect(calls.some((c) => c.api === "sheets" && c.path === "/spreadsheets")).toBe(false);
    });

    it("creates a new spreadsheet and moves it into the folder when none exists", async () => {
      const { call, calls, replay } = stubTransport();
      const result = await new GoogleSheetsAdapter(call, CONFIG).ensureSpreadsheet({
        spreadsheetId: null,
        title: "Reports",
        idempotencyKey: "k1",
      });
      expect(result.spreadsheetId).toBe("sheet_1");
      const create = calls.find((c) => c.api === "sheets" && c.path === "/spreadsheets");
      expect(create?.body).toEqual({ properties: { title: "Reports" } });
      // Whatever parent Drive reported for the new file is what gets removed —
      // taken from the fixture, not a value this test made up.
      const recordedParents = replay.fixture("files.get", "parents").response!["parents"] as string[];
      const move = calls.find((c) => c.method === "PATCH");
      expect(move?.query).toMatchObject({
        addParents: "folder_1",
        removeParents: recordedParents.join(","),
      });
    });
  });

  describe("writeTab", () => {
    it("adds a tab that does not exist yet, then writes the header and rows", async () => {
      const { call, calls, tabsOf } = stubTransport({ tabs: { sheet_1: {} } });
      const adapter = new GoogleSheetsAdapter(call, CONFIG);

      await adapter.writeTab({
        spreadsheetId: "sheet_1",
        tabTitle: "Risk findings",
        columns: ["id", "severity"],
        rows: [["rf1", "amber"]],
        idempotencyKey: "k1",
      });

      expect(tabsOf("sheet_1")).toEqual(["Risk findings"]);
      const addSheet = calls.find((c) => c.path.endsWith(":batchUpdate"));
      expect(addSheet?.body).toEqual({
        requests: [{ addSheet: { properties: { title: "Risk findings" } } }],
      });
      const write = calls.find((c) => c.method === "PUT");
      expect(write?.body).toEqual({ values: [["id", "severity"], ["rf1", "amber"]] });
    });

    it("does not re-add a tab that already exists", async () => {
      const { call, calls } = stubTransport({
        tabs: { sheet_1: { "Risk findings": { columns: [], rows: [] } } },
      });
      await new GoogleSheetsAdapter(call, CONFIG).writeTab({
        spreadsheetId: "sheet_1",
        tabTitle: "Risk findings",
        columns: ["id"],
        rows: [["rf1"]],
        idempotencyKey: "k1",
      });
      expect(calls.some((c) => c.path.endsWith(":batchUpdate"))).toBe(false);
    });

    it("clears before writing — a full overwrite, not an append", async () => {
      const { call, calls } = stubTransport({
        tabs: { sheet_1: { "Risk findings": { columns: ["id"], rows: [["old"]] } } },
      });
      await new GoogleSheetsAdapter(call, CONFIG).writeTab({
        spreadsheetId: "sheet_1",
        tabTitle: "Risk findings",
        columns: ["id"],
        rows: [["new1"], ["new2"]],
        idempotencyKey: "k2",
      });

      const clearIndex = calls.findIndex((c) => c.path.endsWith(":clear"));
      const writeIndex = calls.findIndex((c) => c.method === "PUT");
      expect(clearIndex).toBeGreaterThanOrEqual(0);
      expect(writeIndex).toBeGreaterThan(clearIndex);
      const write = calls[writeIndex]!;
      expect(write.body).toEqual({ values: [["id"], ["new1"], ["new2"]] });
    });

    it("second write overwrites the first tab's contents entirely", async () => {
      const { call, tabsOf } = stubTransport({ tabs: { sheet_1: {} } });
      const adapter = new GoogleSheetsAdapter(call, CONFIG);

      await adapter.writeTab({
        spreadsheetId: "sheet_1",
        tabTitle: "Nudges",
        columns: ["id"],
        rows: [["a"], ["b"], ["c"]],
        idempotencyKey: "k1",
      });
      await adapter.writeTab({
        spreadsheetId: "sheet_1",
        tabTitle: "Nudges",
        columns: ["id"],
        rows: [["z"]],
        idempotencyKey: "k2",
      });

      expect(tabsOf("sheet_1")).toEqual(["Nudges"]);
    });
  });
});

/**
 * No handlers: every response is the fixture exactly as recorded. This is the
 * part a stub could never check — that the adapter reads the vendor's real
 * response shape, including the parts the stub did not bother to model (a new
 * spreadsheet arrives with a default `Sheet1` tab).
 */
describe("against the fixtures as recorded", () => {
  it("creates, moves and writes a tab using only recorded responses", async () => {
    const replay = openReplay();
    const adapter = new GoogleSheetsAdapter(replay.googleSheets(), CONFIG);

    const created = await adapter.ensureSpreadsheet({
      spreadsheetId: null,
      title: "Reports",
      idempotencyKey: "k1",
    });
    const recordedId = replay.fixture("spreadsheets.create").response!["spreadsheetId"];
    expect(created.spreadsheetId).toBe(recordedId);

    await adapter.writeTab({
      spreadsheetId: created.spreadsheetId,
      tabTitle: "Risk findings",
      columns: ["id"],
      rows: [["rf1"]],
      idempotencyKey: "k2",
    });

    // The recorded `spreadsheets.get` only has `Sheet1`, so the tab is added.
    expect(replay.calls.map((c) => c.call)).toEqual([
      "files.list",
      "spreadsheets.create",
      "files.get",
      "files.update",
      "spreadsheets.get",
      "spreadsheets.batchUpdate",
      "spreadsheets.values.clear",
      "spreadsheets.values.update",
    ]);
  });
});

describe("id extraction", () => {
  it("accepts a spreadsheet URL or a bare id", () => {
    expect(
      extractSpreadsheetId("https://docs.google.com/spreadsheets/d/1AbC_-dEf/edit#gid=0"),
    ).toBe("1AbC_-dEf");
    expect(extractSpreadsheetId("1AbC_-dEf")).toBe("1AbC_-dEf");
    expect(extractSpreadsheetId("")).toBeNull();
    expect(extractSpreadsheetId("https://example.com/nope")).toBeNull();
  });
});
