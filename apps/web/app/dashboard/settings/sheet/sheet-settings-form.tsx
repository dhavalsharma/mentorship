"use client";

import { useState, type FormEvent } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Card, CardContent } from "@/components/ui/card";
import type { SheetSettings } from "@/lib/types";

type Status = "idle" | "saving" | "saved" | "error";

/**
 * Mirrors `DocumentSettingsForm` closely — both fields accept a pasted
 * browser URL or a bare id, and `apps/api` does the extraction, so this form
 * deliberately does not try to parse either one client-side.
 */
export function SheetSettingsForm({
  orgId,
  initial,
}: {
  orgId: string;
  initial: SheetSettings;
}) {
  const [folder, setFolder] = useState(initial.folderId ?? "");
  const [spreadsheet, setSpreadsheet] = useState(initial.spreadsheetId ?? "");
  const [status, setStatus] = useState<Status>("idle");
  const [message, setMessage] = useState<string | null>(null);

  async function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setStatus("saving");
    setMessage(null);

    try {
      const response = await fetch(`/api/orgs/${orgId}/settings/sheet`, {
        method: "PUT",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ folder, spreadsheet }),
      });
      if (!response.ok) {
        const body = (await response.json().catch(() => ({}))) as { error?: string };
        setStatus("error");
        setMessage(body.error ?? `The server returned status ${response.status}.`);
        return;
      }
      const saved = (await response.json()) as SheetSettings;
      setFolder(saved.folderId ?? "");
      setSpreadsheet(saved.spreadsheetId ?? "");
      setStatus("saved");
      setMessage("Saved. The next scheduled sync uses these settings.");
    } catch {
      setStatus("error");
      setMessage("Couldn't reach the API server.");
    }
  }

  return (
    <Card>
      <CardContent className="pt-6">
        <form onSubmit={handleSubmit} className="space-y-6">
          <div className="space-y-2">
            <Label htmlFor="folder">Drive folder</Label>
            <Input
              id="folder"
              value={folder}
              onChange={(event) => setFolder(event.target.value)}
              placeholder="https://drive.google.com/drive/folders/…"
              required
            />
            <p className="text-xs text-muted-foreground">
              Paste the folder URL or its id. A new spreadsheet is created
              here if none is configured below.
            </p>
          </div>

          <div className="space-y-2">
            <Label htmlFor="spreadsheet">Spreadsheet (optional)</Label>
            <Input
              id="spreadsheet"
              value={spreadsheet}
              onChange={(event) => setSpreadsheet(event.target.value)}
              placeholder="https://docs.google.com/spreadsheets/d/…/edit"
            />
            <p className="text-xs text-muted-foreground">
              Leave blank to let the first sync create one — its id is then
              filled in here automatically.
            </p>
          </div>

          <div className="flex items-center gap-4">
            <Button type="submit" disabled={status === "saving"}>
              {status === "saving" ? "Saving…" : "Save"}
            </Button>
            {message ? (
              <p
                className={
                  status === "error" ? "text-sm text-destructive" : "text-sm text-muted-foreground"
                }
              >
                {message}
              </p>
            ) : null}
          </div>
        </form>
      </CardContent>
    </Card>
  );
}
