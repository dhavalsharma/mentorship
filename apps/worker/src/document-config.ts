import { and, eq } from "drizzle-orm";
import { integrationBindings, withTenant, type Db } from "@mentorship/db";
import {
  extractDriveFolderId,
  extractGoogleDocId,
  GoogleDriveDocumentConfigSchema,
  type GoogleDriveDocumentConfig,
} from "@mentorship/integrations";

/**
 * Where the running doc lives, resolved once at boot.
 *
 * Two sources, deliberately ordered: a per-org `integration_bindings` row
 * (what the admin settings page writes) beats the environment. Env is the
 * quick live-testing path this repo already uses everywhere else — it is not
 * a fallback layered *under* the database row so much as a way to run before
 * any row exists, which is why an existing row silently wins rather than
 * being merged with the env. A half-and-half config (folder from one source,
 * guideline from the other) is the kind of thing that is impossible to debug
 * from a log line.
 */

export interface DocumentEnv {
  GOOGLE_DRIVE_FOLDER_ID?: string | undefined;
  GOOGLE_DRIVE_GUIDELINE_DOC_ID?: string | undefined;
}

export type DocumentConfigSource = "binding" | "env" | "none";

export interface ResolvedDocumentConfig {
  config: GoogleDriveDocumentConfig | null;
  source: DocumentConfigSource;
}

/** Accepts a full Drive/Docs URL or a bare id, for both variables. */
export function documentConfigFromEnv(
  env: DocumentEnv,
): GoogleDriveDocumentConfig | null {
  const folderId = env.GOOGLE_DRIVE_FOLDER_ID
    ? extractDriveFolderId(env.GOOGLE_DRIVE_FOLDER_ID)
    : null;
  if (!folderId) return null;

  const guidelineDocId = env.GOOGLE_DRIVE_GUIDELINE_DOC_ID
    ? extractGoogleDocId(env.GOOGLE_DRIVE_GUIDELINE_DOC_ID)
    : null;

  return GoogleDriveDocumentConfigSchema.parse({
    folderId,
    ...(guidelineDocId ? { guidelineDocId } : {}),
  });
}

/**
 * The precedence rule on its own, with no database in the way. `resolveDocumentConfig`
 * is a query plus this function; keeping them separable is what lets the rule
 * be tested without Postgres, the same split `proposeSlots` uses against the
 * calendar.
 */
export function chooseDocumentConfig(
  storedConfig: unknown,
  env: DocumentEnv,
): ResolvedDocumentConfig {
  const stored = GoogleDriveDocumentConfigSchema.safeParse(storedConfig ?? {});
  if (stored.success) return { config: stored.data, source: "binding" };

  const fromEnv = documentConfigFromEnv(env);
  return fromEnv === null
    ? { config: null, source: "none" }
    : { config: fromEnv, source: "env" };
}

export async function resolveDocumentConfig(
  db: Db,
  orgId: string,
  env: DocumentEnv,
  role?: string,
): Promise<ResolvedDocumentConfig> {
  const rows = await withTenant(
    db,
    orgId,
    async (tx) =>
      tx
        .select({ config: integrationBindings.config })
        .from(integrationBindings)
        .where(
          and(
            eq(integrationBindings.orgId, orgId),
            eq(integrationBindings.slot, "document"),
          ),
        )
        .limit(1),
    role === undefined ? {} : { role },
  );

  return chooseDocumentConfig(rows[0]?.config, env);
}
