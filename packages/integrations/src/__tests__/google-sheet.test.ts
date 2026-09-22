import { describe, expect, it } from "vitest";
import {
  extractSpreadsheetId,
  GoogleSheetsAdapter,
  type GoogleSheetsTransport,
} from "@mentorship/integrations";

/**
 * No network — a stubbed transport over an in-memory spreadsheet, same shape
 * as `google-document.test.ts`. What matters: the create-then-move-into-folder
 * dance when no spreadsheet is configured, reusing a configured id rather
 * than creating a second spreadsheet, adding a tab that does not exist yet,
 * and a full clear+overwrite of a tab that does.
 */

interface Call {
  api: string;
  path: string;
  method: string;
  body?: unknown;
  query?: Record<string, string>;
}

function stubTransport(
  initial: {
    /** spreadsheetId -> tab title -> { columns, rows } (already-written state) */
    tabs?: Record<string, Record<string, { columns: string[]; rows: unknown[][] }>>;
    filesByName?: Record<string, string>;
  } = {},
): { call: GoogleSheetsTransport; calls: Call[]; tabsOf: (spreadsheetId: string) => string[] } {
  const calls: Call[] = [];
  const tabs = new Map(
    Object.entries(initial.tabs ?? {}).map(([id, t]) => [id, new Map(Object.entries(t))]),
  );
  const filesByName = new Map(Object.entries(initial.filesByName ?? {}));
  let nextSpreadsheetId = 1;

  const call: GoogleSheetsTransport = async (api, path, init) => {
    calls.push({
      api,
      path,
      method: init.method,
      ...(init.body === undefined ? {} : { body: init.body }),
      ...(init.query === undefined ? {} : { query: init.query }),
    });

    if (api === "drive" && path === "/files" && init.method === "GET") {
      const query = init.query?.["q"] ?? "";
      for (const [name, id] of filesByName) {
        if (query.includes(`name = '${name}'`)) return { files: [{ id }] };
      }
      return { files: [] };
    }
    if (api === "sheets" && path === "/spreadsheets" && init.method === "POST") {
      const id = `sheet_${nextSpreadsheetId++}`;
      tabs.set(id, new Map());
      return { spreadsheetId: id };
    }
    if (api === "sheets" && init.method === "GET" && !path.includes(":")) {
      const id = path.split("/")[2]!;
      const sheetTabs = tabs.get(id) ?? new Map();
      return {
        sheets: [...sheetTabs.keys()].map((title) => ({ properties: { title } })),
      };
    }
    if (api === "sheets" && path.endsWith(":batchUpdate")) {
      const id = path.split("/")[2]!.replace(":batchUpdate", "");
      const body = init.body as {
        requests: { addSheet: { properties: { title: string } } }[];
      };
      const sheetTabs = tabs.get(id) ?? new Map();
      for (const r of body.requests) {
        sheetTabs.set(r.addSheet.properties.title, { columns: [], rows: [] });
      }
      tabs.set(id, sheetTabs);
      return {};
    }
    if (api === "sheets" && path.includes("/values/") && path.endsWith(":clear")) {
      return {};
    }
    if (api === "sheets" && path.includes("/values/") && init.method === "PUT") {
      const [, , spreadsheetId, , rangeRaw] = path.split("/");
      const tabTitle = rangeRaw!.replace(/^'/, "").replace(/'$/, "").replace(/''/g, "'");
      const body = init.body as { values: unknown[][] };
      const sheetTabs = tabs.get(spreadsheetId!) ?? new Map();
      const [columns, ...rows] = body.values;
      sheetTabs.set(tabTitle, { columns: columns as string[], rows });
      tabs.set(spreadsheetId!, sheetTabs);
      return {};
    }

    // Drive: generic get-parents (createDoc/ensureSpreadsheet's move step)
    // and the folder probe both land here, in that order.
    if (api === "drive" && init.method === "GET") return { parents: ["root"] };
    if (api === "drive" && init.method === "PATCH") return { id: "moved" };
    return {};
  };

  return {
    call,
    calls,
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
      const { call, calls } = stubTransport();
      const result = await new GoogleSheetsAdapter(call, CONFIG).ensureSpreadsheet({
        spreadsheetId: null,
        title: "Reports",
        idempotencyKey: "k1",
      });
      expect(result.spreadsheetId).toBe("sheet_1");
      const create = calls.find((c) => c.api === "sheets" && c.path === "/spreadsheets");
      expect(create?.body).toEqual({ properties: { title: "Reports" } });
      const move = calls.find((c) => c.method === "PATCH");
      expect(move?.query).toMatchObject({ addParents: "folder_1", removeParents: "root" });
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
