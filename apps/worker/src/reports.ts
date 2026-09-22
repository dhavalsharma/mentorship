import { and, desc, eq } from "drizzle-orm";
import type { SheetAdapter } from "@mentorship/core";
import { integrationBindings, nudges, riskFindings, withTenant, type Db } from "@mentorship/db";
import {
  extractDriveFolderId,
  extractSpreadsheetId,
  GoogleSheetConfigSchema,
  type GoogleSheetConfig,
} from "@mentorship/integrations";
import type { IntegrationRegistry } from "@mentorship/integrations";

/**
 * Program-progress reporting: sync `risk_findings` and `nudges` (and any
 * future report type) into a Google Spreadsheet, one tab per report type,
 * full overwrite on every sync.
 *
 * Same shape as `sweeps.ts`/`digest.ts`: real Postgres reads assembled
 * against a real (or fake) adapter, called on an interval by
 * `Scheduler`/`worker.ts`. Kept in `apps/worker` rather than a primitive
 * package because there is no primitive here — this is a projection of
 * existing read models, not a new inference step, and DB is reachable only
 * from `apps/api`, `apps/worker`, and each package's own `postgres.ts` seam
 * (invariant 2, `.dependency-cruiser.cjs`).
 */

// ---------------------------------------------------------------------------
// Report type registry
// ---------------------------------------------------------------------------

/**
 * A report type: a named data source that fetches rows from Postgres and
 * shapes them into a sheet tab (a header row plus data rows, primitive
 * values only — a spreadsheet cell has no notion of a Date or a JS object).
 */
export interface ReportSource {
  id: string;
  /** Also the sheet tab's title — see `syncReports`. */
  title: string;
  columns: string[];
  rows(
    db: Db,
    orgId: string,
    options?: { role?: string; limit?: number },
  ): Promise<unknown[][]>;
}

/**
 * How many of the most recent rows each report type syncs. A spreadsheet
 * tab is for a human to skim, not an unbounded export — the same reasoning
 * `DEFAULT_LIMIT`/`MAX_LIMIT` in `apps/api/src/server.ts` apply to the admin
 * list routes, reused here because these are the same two tables.
 */
const DEFAULT_REPORT_ROW_LIMIT = 500;

/**
 * The exact shape Drizzle returns for a `risk_findings` row — enough of it
 * for `shapeRiskFindingRow` to be tested with a plain object, no Postgres
 * required. `rows()` below is the only thing that needs a database; the
 * shaping itself is a pure function, split out the same way `digest.ts`
 * splits `summarizeDigest` (pure) from `runDigestSweep` (the query).
 */
export interface RiskFindingRow {
  id: string;
  pairingId: string;
  code: string;
  severity: string;
  detectedAt: Date;
  summary: string;
  requiresHuman: boolean;
  acknowledgedAt: Date | null;
}

export function shapeRiskFindingRow(row: RiskFindingRow): unknown[] {
  return [
    row.id,
    row.pairingId,
    row.code,
    row.severity,
    row.detectedAt.toISOString(),
    row.summary,
    row.requiresHuman,
    row.acknowledgedAt ? row.acknowledgedAt.toISOString() : "",
  ];
}

const riskFindingsReport: ReportSource = {
  id: "risk-findings",
  title: "Risk findings",
  columns: [
    "id",
    "pairingId",
    "code",
    "severity",
    "detectedAt",
    "summary",
    "requiresHuman",
    "acknowledgedAt",
  ],
  async rows(db, orgId, options) {
    return withTenant(
      db,
      orgId,
      async (tx) => {
        const found = await tx
          .select()
          .from(riskFindings)
          .where(eq(riskFindings.orgId, orgId))
          .orderBy(desc(riskFindings.detectedAt))
          .limit(options?.limit ?? DEFAULT_REPORT_ROW_LIMIT);
        return found.map(shapeRiskFindingRow);
      },
      options?.role === undefined ? {} : { role: options.role },
    );
  },
};

/** Same idea as `RiskFindingRow`, mirroring what Drizzle returns for `nudges`. */
export interface NudgeRow {
  id: string;
  pairingId: string | null;
  recipientParticipantId: string;
  channel: string;
  state: string;
  escalationLevel: number;
  dedupeKey: string;
  droppedReason: string | null;
  sentAt: Date | null;
  createdAt: Date;
}

export function shapeNudgeRow(row: NudgeRow): unknown[] {
  return [
    row.id,
    row.pairingId ?? "",
    row.recipientParticipantId,
    row.channel,
    row.state,
    row.escalationLevel,
    row.dedupeKey,
    row.droppedReason ?? "",
    row.sentAt ? row.sentAt.toISOString() : "",
    row.createdAt.toISOString(),
  ];
}

const nudgesReport: ReportSource = {
  id: "nudges",
  title: "Nudges",
  columns: [
    "id",
    "pairingId",
    "recipientParticipantId",
    "channel",
    "state",
    "escalationLevel",
    "dedupeKey",
    "droppedReason",
    "sentAt",
    "createdAt",
  ],
  async rows(db, orgId, options) {
    return withTenant(
      db,
      orgId,
      async (tx) => {
        const found = await tx
          .select()
          .from(nudges)
          .where(eq(nudges.orgId, orgId))
          .orderBy(desc(nudges.createdAt))
          .limit(options?.limit ?? DEFAULT_REPORT_ROW_LIMIT);
        return found.map(shapeNudgeRow);
      },
      options?.role === undefined ? {} : { role: options.role },
    );
  },
};

/**
 * The report-type registry — the one seam a new report type needs.
 *
 * To add a report type: write a `ReportSource` (mirroring `riskFindingsReport`
 * / `nudgesReport` above — a query inside `withTenant`, shaped into
 * primitive-valued rows) and add one entry below, keyed by its `id`. Nothing
 * else in the sync path changes: `syncReports` iterates this registry, and
 * the scheduler wiring in `worker.ts` calls `createReportSyncRunner`, which
 * already syncs every registered report type unless `reportIds` narrows it.
 *
 * A `progress` report type (per-pairing health scores) was considered and
 * deliberately left out: `computeHealth` (`packages/primitives/progress/src
 * /health.ts`) is a pure function over `signals`, not a persisted, queryable
 * row — nothing writes a health score to a table today (ADR-0007's own
 * point: the model explains a score, it does not own a stored number for
 * later reporting). Inventing a table to make this report type possible
 * would be the "invent a fake email adapter" mistake `digest.ts`'s own
 * comment already warns against. `PostgresProgressReader`'s own queries
 * (sessions/action-items/goals/goal-checkins) are the honestly-queryable
 * alternative, but sit behind per-pairing fan-out with no single
 * org-scoped listing query yet — a real follow-up, not a five-minute add.
 */
export const REPORT_SOURCES: Record<string, ReportSource> = {
  "risk-findings": riskFindingsReport,
  nudges: nudgesReport,
};

// ---------------------------------------------------------------------------
// Sync
// ---------------------------------------------------------------------------

export interface SyncReportsOptions {
  db: Db;
  orgId: string;
  sheet: SheetAdapter;
  spreadsheetTitle: string;
  /** The currently-configured spreadsheet id, or `null` to create one. */
  spreadsheetId: string | null;
  /** Defaults to every registered report type. */
  reportIds?: string[];
  role?: string;
}

export interface SyncReportsResult {
  spreadsheetId: string;
  url: string;
  tabs: string[];
}

/**
 * Ensures the destination spreadsheet exists, then writes every requested
 * report type into its own tab.
 *
 * Full overwrite, not append/dedupe: each report type's tab is cleared and
 * rewritten from scratch on every sync, rather than appending new rows or
 * diffing against what is already there. A report tab is meant to answer
 * "what does this look like right now" — append/dedupe would need a stable
 * row key (fine for risk findings and nudges, which have one — an `id` —
 * but not a rule every future report type can promise) and an
 * ever-growing sheet nothing here prunes. Full overwrite is simpler, is
 * always correct regardless of what changed between syncs (a nudge that
 * transitions from `planned` to `sent` is trivially "updated" rather than
 * needing a diff), and costs one clear + one write per tab either way.
 */
export async function syncReports(options: SyncReportsOptions): Promise<SyncReportsResult> {
  const reportIds = options.reportIds ?? Object.keys(REPORT_SOURCES);
  const idempotencyBase = `sheet-sync:${options.orgId}`;

  const { spreadsheetId, url } = await options.sheet.ensureSpreadsheet({
    spreadsheetId: options.spreadsheetId,
    title: options.spreadsheetTitle,
    idempotencyKey: `${idempotencyBase}:create`,
  });

  const tabs: string[] = [];
  for (const reportId of reportIds) {
    const source = REPORT_SOURCES[reportId];
    if (!source) continue; // an unknown id is skipped, not fatal — see `reportIds`'s callers.
    const rows = await source.rows(
      options.db,
      options.orgId,
      options.role === undefined ? {} : { role: options.role },
    );
    await options.sheet.writeTab({
      spreadsheetId,
      tabTitle: source.title,
      columns: source.columns,
      rows,
      idempotencyKey: `${idempotencyBase}:${reportId}`,
    });
    tabs.push(source.title);
  }

  return { spreadsheetId, url, tabs };
}

// ---------------------------------------------------------------------------
// Destination config — the `sheet` slot's counterpart to
// `apps/worker/src/document-config.ts`
// ---------------------------------------------------------------------------

export interface SheetEnv {
  GOOGLE_SHEETS_FOLDER_ID?: string | undefined;
  GOOGLE_SHEETS_SPREADSHEET_ID?: string | undefined;
}

export type SheetConfigSource = "binding" | "env" | "none";

export interface ResolvedSheetConfig {
  config: GoogleSheetConfig | null;
  source: SheetConfigSource;
}

/** Accepts a full Drive/Sheets URL or a bare id, for both variables. */
export function sheetConfigFromEnv(env: SheetEnv): GoogleSheetConfig | null {
  const folderId = env.GOOGLE_SHEETS_FOLDER_ID
    ? extractDriveFolderId(env.GOOGLE_SHEETS_FOLDER_ID)
    : null;
  if (!folderId) return null;
  const spreadsheetId = env.GOOGLE_SHEETS_SPREADSHEET_ID
    ? extractSpreadsheetId(env.GOOGLE_SHEETS_SPREADSHEET_ID)
    : null;
  return GoogleSheetConfigSchema.parse({
    folderId,
    ...(spreadsheetId ? { spreadsheetId } : {}),
  });
}

/**
 * Same precedence rule as `chooseDocumentConfig`: a stored
 * `integration_bindings` row beats the environment, never merged with it —
 * a folder from one source and a spreadsheet id from the other is exactly
 * the kind of half-and-half config that is impossible to debug from a log
 * line.
 */
export function chooseSheetConfig(storedConfig: unknown, env: SheetEnv): ResolvedSheetConfig {
  const stored = GoogleSheetConfigSchema.safeParse(storedConfig ?? {});
  if (stored.success) return { config: stored.data, source: "binding" };

  const fromEnv = sheetConfigFromEnv(env);
  return fromEnv === null ? { config: null, source: "none" } : { config: fromEnv, source: "env" };
}

export async function resolveSheetConfig(
  db: Db,
  orgId: string,
  env: SheetEnv,
  role?: string,
): Promise<ResolvedSheetConfig> {
  const rows = await withTenant(
    db,
    orgId,
    async (tx) =>
      tx
        .select({ config: integrationBindings.config })
        .from(integrationBindings)
        .where(and(eq(integrationBindings.orgId, orgId), eq(integrationBindings.slot, "sheet")))
        .limit(1),
    role === undefined ? {} : { role },
  );

  return chooseSheetConfig(rows[0]?.config, env);
}

/**
 * Writes the spreadsheet id back onto the `sheet` binding's config, once a
 * sync creates one. Mirrors `PostgresDocumentSettingsStore.write`'s
 * upsert — same `onConflictDoUpdate` on `(orgId, slot)` — except this is
 * called from the sync job itself rather than an admin form, so `folderId`
 * is threaded through unchanged rather than re-read: the row this call
 * writes must never lose the folder an admin configured.
 */
export async function persistSheetSpreadsheetId(
  db: Db,
  orgId: string,
  folderId: string,
  spreadsheetId: string,
  role?: string,
): Promise<void> {
  await withTenant(
    db,
    orgId,
    async (tx) => {
      const config = { folderId, spreadsheetId };
      await tx
        .insert(integrationBindings)
        .values({ orgId, slot: "sheet", adapterId: "google-sheets", config })
        .onConflictDoUpdate({
          target: [integrationBindings.orgId, integrationBindings.slot],
          set: { config, updatedAt: new Date() },
        });
    },
    role === undefined ? {} : { role },
  );
}

// ---------------------------------------------------------------------------
// Scheduler wiring
// ---------------------------------------------------------------------------

export interface ReportSyncDeps {
  db: Db;
  orgId: string;
  registry: IntegrationRegistry;
  role?: string;
  env?: SheetEnv;
  spreadsheetTitle?: string;
  onWarn?: (message: string, detail?: Record<string, unknown>) => void;
}

const DEFAULT_SPREADSHEET_TITLE = "Mentorship program reports";

/**
 * The unit `Scheduler` calls on an interval (see `worker.ts`'s
 * `schedules.reportSync`). Resolves the `sheet` binding, skips (rather than
 * throws) when nothing is configured — the same "off unless configured"
 * default every other sweep in this codebase has — and, on a sync that
 * created a brand new spreadsheet, persists its id so the next sync reuses
 * it instead of creating a second one.
 */
export function createReportSyncRunner(
  deps: ReportSyncDeps,
): () => Promise<SyncReportsResult | null> {
  return async () => {
    const sheet = deps.registry.get<SheetAdapter>("sheet");
    if (!sheet) return null; // No sheet slot bound for this tenant.

    const resolved = await resolveSheetConfig(deps.db, deps.orgId, deps.env ?? {}, deps.role);
    if (!resolved.config) {
      deps.onWarn?.("report sync skipped: no sheet destination configured", {
        orgId: deps.orgId,
      });
      return null;
    }

    const result = await syncReports({
      db: deps.db,
      orgId: deps.orgId,
      sheet,
      spreadsheetTitle: deps.spreadsheetTitle ?? DEFAULT_SPREADSHEET_TITLE,
      spreadsheetId: resolved.config.spreadsheetId ?? null,
      ...(deps.role === undefined ? {} : { role: deps.role }),
    });

    if (result.spreadsheetId !== resolved.config.spreadsheetId) {
      await persistSheetSpreadsheetId(
        deps.db,
        deps.orgId,
        resolved.config.folderId,
        result.spreadsheetId,
        deps.role,
      );
    }

    return result;
  };
}
