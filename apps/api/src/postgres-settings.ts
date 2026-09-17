import { and, asc, eq } from "drizzle-orm";
import { DocumentPolicySchema, ProgramPolicySchema } from "@mentorship/core";
import {
  integrationBindings,
  programs,
  withTenant,
  type Db,
} from "@mentorship/db";
import { GoogleDriveDocumentConfigSchema } from "@mentorship/integrations";
import type { DocumentSettings, DocumentSettingsStore } from "./server.js";

/**
 * The read/write pair behind `/orgs/:orgId/settings/document`.
 *
 * Both halves of the form move in one transaction: the vendor config onto the
 * `document` integration binding, the naming template into the program's
 * policy document. Splitting them across two transactions would let a saved
 * form leave a folder pointing at one thing and a template describing another
 * — a state the UI has no way to show and no way to recover from.
 */
export class PostgresDocumentSettingsStore implements DocumentSettingsStore {
  constructor(
    private readonly db: Db,
    private readonly options: { role?: string } = {},
  ) {}

  async read(orgId: string): Promise<DocumentSettings> {
    return withTenant(
      this.db,
      orgId,
      async (tx) => {
        const [binding] = await tx
          .select({ config: integrationBindings.config })
          .from(integrationBindings)
          .where(
            and(
              eq(integrationBindings.orgId, orgId),
              eq(integrationBindings.slot, "document"),
            ),
          )
          .limit(1);

        const config = GoogleDriveDocumentConfigSchema.partial().safeParse(
          binding?.config ?? {},
        );

        const [program] = await tx
          .select({ policy: programs.policy })
          .from(programs)
          .where(eq(programs.orgId, orgId))
          .orderBy(asc(programs.createdAt))
          .limit(1);

        const policy = DocumentPolicySchema.safeParse(
          (program?.policy as { document?: unknown } | undefined)?.document ?? {},
        );

        return {
          folderId: config.success ? (config.data.folderId ?? null) : null,
          guidelineDocId: config.success
            ? (config.data.guidelineDocId ?? null)
            : null,
          namingTemplate: policy.success
            ? policy.data.namingTemplate
            : DocumentPolicySchema.parse({}).namingTemplate,
        };
      },
      this.roleOptions(),
    );
  }

  async write(orgId: string, settings: DocumentSettings): Promise<void> {
    await withTenant(
      this.db,
      orgId,
      async (tx) => {
        const config = {
          ...(settings.folderId ? { folderId: settings.folderId } : {}),
          ...(settings.guidelineDocId
            ? { guidelineDocId: settings.guidelineDocId }
            : {}),
        };

        // The binding may not exist yet — this settings page is the first
        // thing that creates one for the document slot, so the adapter id is
        // written here rather than assumed to have been seeded elsewhere.
        await tx
          .insert(integrationBindings)
          .values({
            orgId,
            slot: "document",
            adapterId: "google-drive",
            config,
          })
          .onConflictDoUpdate({
            target: [integrationBindings.orgId, integrationBindings.slot],
            set: { config, updatedAt: new Date() },
          });

        const [program] = await tx
          .select({ id: programs.id, policy: programs.policy })
          .from(programs)
          .where(eq(programs.orgId, orgId))
          .orderBy(asc(programs.createdAt))
          .limit(1);

        // No program means no policy document to patch. Silently creating one
        // here would invent a program nobody configured, so the vendor config
        // is still saved and the template simply has nowhere to live yet.
        if (!program) return;

        const merged = ProgramPolicySchema.parse({
          ...(program.policy as Record<string, unknown>),
          document: { namingTemplate: settings.namingTemplate },
        });

        await tx
          .update(programs)
          .set({ policy: merged, updatedAt: new Date() })
          .where(and(eq(programs.orgId, orgId), eq(programs.id, program.id)));
      },
      this.roleOptions(),
    );
  }

  private roleOptions(): { role?: string } {
    return this.options.role === undefined ? {} : { role: this.options.role };
  }
}
