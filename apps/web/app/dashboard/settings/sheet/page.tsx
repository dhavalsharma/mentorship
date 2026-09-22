import { fetchAdminRoute } from "@/lib/server-api";
import { adminResultMessage } from "@/lib/admin-result-message";
import type { SheetSettings } from "@/lib/types";
import { SheetSettingsForm } from "./sheet-settings-form";

const ORG_ID = process.env["ORG_ID"];

export default async function SheetSettingsPage() {
  if (!ORG_ID) {
    throw new Error("ORG_ID is not set for apps/web — see .env.example.");
  }

  const result = await fetchAdminRoute<SheetSettings>(`/orgs/${ORG_ID}/settings/sheet`);

  return (
    <div className="space-y-4">
      <h1 className="text-xl font-semibold">Report spreadsheet</h1>
      <p className="text-sm text-muted-foreground">
        Risk findings and nudges are synced into one spreadsheet, one tab per
        report, on a schedule the worker controls. Leave the spreadsheet
        field blank and the first sync creates one in the folder below, then
        remembers it here.
      </p>
      {result.status === "ok" ? (
        <SheetSettingsForm orgId={ORG_ID} initial={result.data} />
      ) : (
        <p className="rounded-md border border-dashed p-6 text-sm text-muted-foreground">
          {adminResultMessage(result, "sheet settings") ?? "Something went wrong."}
        </p>
      )}
    </div>
  );
}
