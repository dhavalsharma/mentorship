import { fetchAdminRoute } from "@/lib/server-api";
import { adminResultMessage } from "@/lib/admin-result-message";
import type { DocumentSettings } from "@/lib/types";
import { DocumentSettingsForm } from "./document-settings-form";

const ORG_ID = process.env["ORG_ID"];

export default async function DocumentSettingsPage() {
  if (!ORG_ID) {
    throw new Error("ORG_ID is not set for apps/web — see .env.example.");
  }

  const result = await fetchAdminRoute<DocumentSettings>(
    `/orgs/${ORG_ID}/settings/document`,
  );

  return (
    <div className="space-y-4">
      <h1 className="text-xl font-semibold">Shared document</h1>
      <p className="text-sm text-muted-foreground">
        Each pair gets one running document, created in the folder below and
        updated after every session. Only the region the platform owns is
        rewritten — anything the pair writes around it is never touched.
      </p>
      {result.status === "ok" ? (
        <DocumentSettingsForm orgId={ORG_ID} initial={result.data} />
      ) : (
        <p className="rounded-md border border-dashed p-6 text-sm text-muted-foreground">
          {adminResultMessage(result, "document settings") ??
            "Something went wrong."}
        </p>
      )}
    </div>
  );
}
