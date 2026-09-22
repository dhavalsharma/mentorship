import { z } from "zod";
import type { AdapterCapabilities, SheetAdapter } from "@mentorship/core";
import { AdapterCapabilitiesSchema } from "@mentorship/core";
import { staticAccessToken, type GoogleAccessTokenSource } from "./auth.js";

/**
 * Google Sheets + Drive adapter for the `sheet` slot — the periodic
 * program-progress report (risk findings, nudges, ...), one spreadsheet per
 * org, one tab per report type.
 *
 * STATUS: the API shapes are real; this has **not** been run against a live
 * Sheets account. Supply an access token minted for
 * `https://www.googleapis.com/auth/spreadsheets` and
 * `https://www.googleapis.com/auth/drive.file` (the latter only because
 * creating a spreadsheet and moving it into a folder is a Drive operation —
 * see `ensureSpreadsheet` below).
 */

/**
 * Vendor config for this adapter, stored per org on
 * `integration_bindings.config` — same home as `GoogleDriveDocumentConfig`,
 * and for the same reason (invariant 1: core must never learn what a Drive
 * folder or a spreadsheet id is). `spreadsheetId` starts unset; the first
 * successful sync fills it in and persists it back (see
 * `apps/worker/src/reports.ts`), so every sync after that reuses the same
 * spreadsheet instead of creating a new one.
 */
export const GoogleSheetConfigSchema = z.object({
  folderId: z.string().min(1),
  spreadsheetId: z.string().min(1).optional(),
});
export type GoogleSheetConfig = z.infer<typeof GoogleSheetConfigSchema>;

export type GoogleSheetsApi = "drive" | "sheets";

export type GoogleSheetsTransport = (
  api: GoogleSheetsApi,
  path: string,
  init: { method: string; body?: unknown; query?: Record<string, string> },
) => Promise<Record<string, unknown>>;

const API_BASE: Record<GoogleSheetsApi, string> = {
  drive: "https://www.googleapis.com/drive/v3",
  sheets: "https://sheets.googleapis.com/v4",
};

/**
 * Deliberately its own transport rather than a third arm bolted onto
 * `GoogleDocsTransport` (`./document.ts`) — the two adapters share nothing
 * but the bearer token and the fetch-and-check-`ok` shape, and coupling
 * them through one shared union would mean a change to the Docs API's base
 * URLs risks a typo affecting Sheets calls neither reviewer was looking at.
 * Every other line below is a deliberate copy of that file's `call()`, kept
 * in lockstep on purpose.
 */
export function httpGoogleSheetsTransport(
  accessToken: string | GoogleAccessTokenSource,
): GoogleSheetsTransport {
  const getToken = typeof accessToken === "string" ? staticAccessToken(accessToken) : accessToken;
  return async (api, path, init) => {
    const url = new URL(`${API_BASE[api]}${path}`);
    for (const [k, v] of Object.entries(init.query ?? {})) {
      url.searchParams.set(k, v);
    }
    const res = await fetch(url, {
      method: init.method,
      headers: {
        authorization: `Bearer ${await getToken()}`,
        "content-type": "application/json",
      },
      body: init.body === undefined ? undefined : JSON.stringify(init.body),
    });
    const json = (await res.json()) as Record<string, unknown>;
    if (!res.ok) {
      throw new Error(`google ${api} ${path} failed: ${JSON.stringify(json)}`);
    }
    return json;
  };
}

/**
 * Rows and header quoted as an A1 range against a tab name that may contain
 * spaces or apostrophes — Sheets requires single-quoting any title that is
 * not a bare identifier, and an embedded `'` inside a quoted title is
 * escaped by doubling it, exactly like SQL's identifier quoting.
 */
function quotedTab(tabTitle: string): string {
  return `'${tabTitle.replace(/'/g, "''")}'`;
}

export class GoogleSheetsAdapter implements SheetAdapter {
  readonly slot = "sheet" as const;
  readonly id = "google-sheets";

  constructor(
    private readonly call: GoogleSheetsTransport,
    private readonly config: GoogleSheetConfig,
    private readonly onWarn?: (
      message: string,
      detail?: Record<string, unknown>,
    ) => void,
  ) {}

  async probe(): Promise<AdapterCapabilities> {
    await this.call("drive", `/files/${this.config.folderId}`, {
      method: "GET",
      query: { fields: "id,mimeType", supportsAllDrives: "true" },
    });
    return AdapterCapabilitiesSchema.parse({});
  }

  async ensureSpreadsheet(input: {
    spreadsheetId: string | null;
    title: string;
    idempotencyKey: string;
  }): Promise<{ spreadsheetId: string; url: string }> {
    const configured = input.spreadsheetId ?? this.config.spreadsheetId ?? null;
    if (configured !== null) {
      return { spreadsheetId: configured, url: spreadsheetUrl(configured) };
    }

    // Same retry-safety dance as `GoogleDriveDocumentAdapter.createDoc`:
    // neither Sheets nor Drive takes an idempotency key, so a retry between
    // "spreadsheet created" and "id persisted back" would otherwise create a
    // second spreadsheet on every retry. An existing file of the same name
    // in the folder is adopted instead.
    const existing = await this.findByName(input.title);
    if (existing !== null) {
      return { spreadsheetId: existing, url: spreadsheetUrl(existing) };
    }

    // `spreadsheets.create` cannot place a file in a folder — a new
    // spreadsheet always lands in the creator's My Drive root — so it is
    // moved with a second call, the same two-step dance
    // `GoogleDriveDocumentAdapter.createDoc` uses for a blank Doc.
    const created = await this.call("sheets", "/spreadsheets", {
      method: "POST",
      body: { properties: { title: input.title } },
    });
    const spreadsheetId = String(created["spreadsheetId"]);

    const meta = await this.call("drive", `/files/${spreadsheetId}`, {
      method: "GET",
      query: { fields: "parents", supportsAllDrives: "true" },
    });
    const parents = (meta["parents"] as string[] | undefined) ?? [];

    await this.call("drive", `/files/${spreadsheetId}`, {
      method: "PATCH",
      query: {
        addParents: this.config.folderId,
        ...(parents.length > 0 ? { removeParents: parents.join(",") } : {}),
        supportsAllDrives: "true",
        fields: "id",
      },
    });

    return { spreadsheetId, url: spreadsheetUrl(spreadsheetId) };
  }

  private async findByName(title: string): Promise<string | null> {
    const escaped = title.replace(/\\/g, "\\\\").replace(/'/g, "\\'");
    const res = await this.call("drive", "/files", {
      method: "GET",
      query: {
        q:
          `'${this.config.folderId}' in parents and name = '${escaped}' and ` +
          "trashed = false and mimeType = 'application/vnd.google-apps.spreadsheet'",
        fields: "files(id)",
        pageSize: "1",
        supportsAllDrives: "true",
        includeItemsFromAllDrives: "true",
      },
    });
    const files = (res["files"] as { id?: string }[] | undefined) ?? [];
    return files[0]?.id ?? null;
  }

  async writeTab(input: {
    spreadsheetId: string;
    tabTitle: string;
    columns: string[];
    rows: unknown[][];
    idempotencyKey: string;
  }): Promise<void> {
    const meta = await this.call("sheets", `/spreadsheets/${input.spreadsheetId}`, {
      method: "GET",
      query: { fields: "sheets.properties(sheetId,title)" },
    });
    const sheets =
      (meta["sheets"] as { properties?: { sheetId?: number; title?: string } }[] | undefined) ??
      [];
    const exists = sheets.some((s) => s.properties?.title === input.tabTitle);

    if (!exists) {
      await this.call("sheets", `/spreadsheets/${input.spreadsheetId}:batchUpdate`, {
        method: "POST",
        body: { requests: [{ addSheet: { properties: { title: input.tabTitle } } }] },
      });
    }

    const range = quotedTab(input.tabTitle);

    // Clear before write, over the whole tab: this is a full overwrite, not
    // an append or a merge (see `SheetAdapter.writeTab`'s own comment on
    // core) — a stale row left over from a report type whose row count
    // shrank between syncs must not survive the clear.
    await this.call("sheets", `/spreadsheets/${input.spreadsheetId}/values/${range}:clear`, {
      method: "POST",
      body: {},
    });

    await this.call("sheets", `/spreadsheets/${input.spreadsheetId}/values/${range}`, {
      method: "PUT",
      query: { valueInputOption: "RAW" },
      body: { values: [input.columns, ...input.rows] },
    });
  }
}

export function spreadsheetUrl(spreadsheetId: string): string {
  return `https://docs.google.com/spreadsheets/d/${spreadsheetId}/edit`;
}

/**
 * Same shape as `extractDriveFolderId`/`extractGoogleDocId` in
 * `./document.ts` — an admin pastes a URL out of the browser bar, and a
 * hand-extracted id is a truncation waiting to happen. Both accept a bare
 * id unchanged.
 */
export function extractSpreadsheetId(input: string): string | null {
  const trimmed = input.trim();
  if (trimmed.length === 0) return null;
  const match = /\/spreadsheets\/d\/([A-Za-z0-9_-]+)/.exec(trimmed);
  if (match) return match[1]!;
  return /^[A-Za-z0-9_-]+$/.test(trimmed) ? trimmed : null;
}
