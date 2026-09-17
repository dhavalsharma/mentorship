import { z } from "zod";
import type { AdapterCapabilities, DocumentAdapter } from "@mentorship/core";
import { AdapterCapabilitiesSchema } from "@mentorship/core";
// The markers are imported from `fakes.ts` rather than redeclared here: two
// copies of a delimiter is how a real adapter and the reference implementation
// quietly stop agreeing, and a doc written by one would then be unreadable by
// the other. They belong to the projection contract, not to the fake.
import { MANAGED_END, MANAGED_START } from "../fakes.js";

/**
 * Google Drive + Docs adapter for the `document` slot — the running shared doc
 * per pair (ADR-0005: the database is the source of truth, this file is a
 * projection of it).
 *
 * STATUS: the API shapes are real; this has **not** been run against a live
 * Drive or Docs account. Supply an access token minted for
 * `https://www.googleapis.com/auth/documents` and
 * `https://www.googleapis.com/auth/drive.file` — strictly more than the
 * Calendar adapter needs, so an existing calendar token will not work here
 * (see docs/live-tenant-testing.md).
 */

/**
 * Vendor config for this adapter, stored per org on
 * `integration_bindings.config`. It lives here rather than in
 * `packages/core` because core must never learn what a Drive folder is
 * (invariant 1) — the slot port is the only vendor-agnostic contract.
 */
export const GoogleDriveDocumentConfigSchema = z.object({
  folderId: z.string().min(1),
  /** A template doc copied for each new pair. Omitted means start blank. */
  guidelineDocId: z.string().min(1).optional(),
});
export type GoogleDriveDocumentConfig = z.infer<
  typeof GoogleDriveDocumentConfigSchema
>;

export type GoogleDocsApi = "drive" | "docs";

export type GoogleDocsTransport = (
  api: GoogleDocsApi,
  path: string,
  init: { method: string; body?: unknown; query?: Record<string, string> },
) => Promise<Record<string, unknown>>;

const API_BASE: Record<GoogleDocsApi, string> = {
  drive: "https://www.googleapis.com/drive/v3",
  docs: "https://docs.googleapis.com/v1",
};

/**
 * Two APIs behind one transport rather than two transports: every call here
 * carries the same bearer token, and a caller that had to hold two functions
 * could bind them to different credentials without noticing.
 */
export function httpGoogleDocsTransport(accessToken: string): GoogleDocsTransport {
  return async (api, path, init) => {
    const url = new URL(`${API_BASE[api]}${path}`);
    for (const [k, v] of Object.entries(init.query ?? {})) {
      url.searchParams.set(k, v);
    }
    const res = await fetch(url, {
      method: init.method,
      headers: {
        authorization: `Bearer ${accessToken}`,
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

export class GoogleDriveDocumentAdapter implements DocumentAdapter {
  readonly slot = "document" as const;
  readonly id = "google-drive";

  constructor(
    private readonly call: GoogleDocsTransport,
    private readonly config: GoogleDriveDocumentConfig,
  ) {}

  async probe(): Promise<AdapterCapabilities> {
    // The folder is the one thing a misconfiguration is most likely to get
    // wrong and the one thing every later call depends on, so the probe reads
    // it rather than something cheaper like `about.get`.
    await this.call("drive", `/files/${this.config.folderId}`, {
      method: "GET",
      query: { fields: "id,mimeType", supportsAllDrives: "true" },
    });
    return AdapterCapabilitiesSchema.parse({ anchoredDocEdits: true });
  }

  async renderManagedRegion(input: {
    docRef: string | null;
    title: string;
    markdown: string;
    idempotencyKey: string;
  }): Promise<{ docRef: string; url: string; revisionId: string }> {
    const documentId = input.docRef ?? (await this.createDoc(input.title));
    const revisionId = await this.writeManagedRegion(documentId, input.markdown);
    return { docRef: documentId, url: documentUrl(documentId), revisionId };
  }

  // -------------------------------------------------------------------------

  private async createDoc(title: string): Promise<string> {
    // Neither Drive nor Docs accepts an idempotency key, so a retry between
    // "file created" and "effect ledger written" would leave the pair with two
    // running docs — the document-slot equivalent of the duplicate invite
    // invariant 6 exists to prevent. Name-within-folder is the closest thing
    // to a natural key available, so an existing match is adopted instead of a
    // second file being created.
    const existing = await this.findByName(title);
    if (existing !== null) return existing;

    if (this.config.guidelineDocId !== undefined) {
      const copied = await this.call(
        "drive",
        `/files/${this.config.guidelineDocId}/copy`,
        {
          method: "POST",
          query: { supportsAllDrives: "true", fields: "id" },
          body: { name: title, parents: [this.config.folderId] },
        },
      );
      return String(copied["id"]);
    }

    // `documents.create` cannot place a file: a new Doc always lands in the
    // creator's My Drive root, so it is moved in a second call.
    const created = await this.call("docs", "/documents", {
      method: "POST",
      body: { title },
    });
    const documentId = String(created["documentId"]);

    const meta = await this.call("drive", `/files/${documentId}`, {
      method: "GET",
      query: { fields: "parents", supportsAllDrives: "true" },
    });
    const parents = (meta["parents"] as string[] | undefined) ?? [];

    await this.call("drive", `/files/${documentId}`, {
      method: "PATCH",
      query: {
        addParents: this.config.folderId,
        ...(parents.length > 0 ? { removeParents: parents.join(",") } : {}),
        supportsAllDrives: "true",
        fields: "id",
      },
    });
    return documentId;
  }

  private async findByName(title: string): Promise<string | null> {
    const escaped = title.replace(/\\/g, "\\\\").replace(/'/g, "\\'");
    const res = await this.call("drive", "/files", {
      method: "GET",
      query: {
        q: `'${this.config.folderId}' in parents and name = '${escaped}' and trashed = false`,
        fields: "files(id)",
        pageSize: "1",
        supportsAllDrives: "true",
        includeItemsFromAllDrives: "true",
      },
    });
    const files = (res["files"] as { id?: string }[] | undefined) ?? [];
    return files[0]?.id ?? null;
  }

  private async writeManagedRegion(
    documentId: string,
    markdown: string,
  ): Promise<string> {
    const doc = await this.call("docs", `/documents/${documentId}`, {
      method: "GET",
    });
    const runs = collectTextRuns(doc);
    const region = findManagedRegion(runs);

    const requests =
      region === null
        ? [
            {
              insertText: {
                location: { index: endOfBody(runs) },
                text: `\n${MANAGED_START}\n${markdown}\n${MANAGED_END}\n`,
              },
            },
          ]
        : [
            // Delete before insert, and only between the markers. Everything
            // the pair wrote outside them — including the guideline doc's own
            // content — is never in this range (ADR-0005).
            ...(region.end > region.start
              ? [
                  {
                    deleteContentRange: {
                      range: { startIndex: region.start, endIndex: region.end },
                    },
                  },
                ]
              : []),
            {
              insertText: {
                location: { index: region.start },
                text: `\n${markdown}\n`,
              },
            },
          ];

    const res = await this.call(
      "docs",
      `/documents/${documentId}:batchUpdate`,
      { method: "POST", body: { requests } },
    );
    const writeControl = res["writeControl"] as
      | { requiredRevisionId?: string }
      | undefined;
    return writeControl?.requiredRevisionId ?? String(doc["revisionId"] ?? "");
  }
}

export function documentUrl(documentId: string): string {
  return `https://docs.google.com/document/d/${documentId}/edit`;
}

/**
 * Admins copy a URL out of the browser bar; asking them to hand-extract the
 * id is an invitation to paste a truncated one. Both accept a bare id
 * unchanged, so the same function serves the env-var path too.
 */
export function extractDriveFolderId(input: string): string | null {
  const trimmed = input.trim();
  if (trimmed.length === 0) return null;
  const match = /\/folders\/([A-Za-z0-9_-]+)/.exec(trimmed);
  if (match) return match[1]!;
  return /^[A-Za-z0-9_-]+$/.test(trimmed) ? trimmed : null;
}

export function extractGoogleDocId(input: string): string | null {
  const trimmed = input.trim();
  if (trimmed.length === 0) return null;
  const match = /\/document\/d\/([A-Za-z0-9_-]+)/.exec(trimmed);
  if (match) return match[1]!;
  return /^[A-Za-z0-9_-]+$/.test(trimmed) ? trimmed : null;
}

/**
 * Docs indices count structural elements, not characters, so a marker's
 * position in the flattened text cannot be used as a document index directly.
 * Each run records where it starts in both coordinate systems, which is what
 * makes the mapping back exact.
 */
interface TextRun {
  text: string;
  /** Offset in the flattened document text. */
  flatStart: number;
  /** Index in the document's own coordinate system. */
  docStart: number;
  docEnd: number;
}

export function collectTextRuns(doc: Record<string, unknown>): TextRun[] {
  const body = doc["body"] as { content?: unknown[] } | undefined;
  const runs: TextRun[] = [];
  let flat = 0;

  const visit = (elements: unknown[] | undefined): void => {
    for (const element of elements ?? []) {
      const el = element as Record<string, unknown>;
      const paragraph = el["paragraph"] as { elements?: unknown[] } | undefined;
      if (paragraph) {
        for (const pe of paragraph.elements ?? []) {
          const child = pe as Record<string, unknown>;
          const textRun = child["textRun"] as { content?: string } | undefined;
          if (!textRun?.content) continue;
          const docStart = Number(child["startIndex"] ?? 0);
          runs.push({
            text: textRun.content,
            flatStart: flat,
            docStart,
            docEnd: Number(child["endIndex"] ?? docStart + textRun.content.length),
          });
          flat += textRun.content.length;
        }
      }
      const table = el["table"] as { tableRows?: unknown[] } | undefined;
      for (const row of table?.tableRows ?? []) {
        const cells = (row as { tableCells?: unknown[] }).tableCells ?? [];
        for (const cell of cells) {
          visit((cell as { content?: unknown[] }).content);
        }
      }
    }
  };

  visit(body?.content);
  return runs;
}

function flatten(runs: TextRun[]): string {
  return runs.map((r) => r.text).join("");
}

function toDocIndex(runs: TextRun[], flatOffset: number): number {
  for (const run of runs) {
    if (flatOffset < run.flatStart + run.text.length) {
      return run.docStart + (flatOffset - run.flatStart);
    }
  }
  const last = runs[runs.length - 1];
  return last ? last.docEnd : 1;
}

/**
 * The managed region is the span *between* the markers; the markers
 * themselves are left in place so a later render can find them again.
 */
export function findManagedRegion(
  runs: TextRun[],
): { start: number; end: number } | null {
  const text = flatten(runs);
  const startMarker = text.indexOf(MANAGED_START);
  if (startMarker === -1) return null;
  const endMarker = text.indexOf(MANAGED_END, startMarker + MANAGED_START.length);
  if (endMarker === -1) return null;

  return {
    start: toDocIndex(runs, startMarker + MANAGED_START.length),
    end: toDocIndex(runs, endMarker),
  };
}

/**
 * A Docs body always ends with a newline that cannot be written past, so the
 * last insertable index is one before the final element's end.
 */
function endOfBody(runs: TextRun[]): number {
  const last = runs[runs.length - 1];
  return last ? Math.max(last.docEnd - 1, 1) : 1;
}
