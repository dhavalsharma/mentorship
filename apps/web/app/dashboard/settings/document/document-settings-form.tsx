"use client";

import { useState, type FormEvent } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Card, CardContent } from "@/components/ui/card";
import type { DocumentSettings } from "@/lib/types";

type Status = "idle" | "saving" | "saved" | "error";

/**
 * Both id fields accept a pasted browser URL or a bare id — `apps/api` does
 * the extraction, so this form deliberately does not try to parse either one
 * client-side. A second parser here would be a second place to get the
 * accepted shapes wrong.
 */
export function DocumentSettingsForm({
  orgId,
  initial,
}: {
  orgId: string;
  initial: DocumentSettings;
}) {
  const [folder, setFolder] = useState(initial.folderId ?? "");
  const [guideline, setGuideline] = useState(initial.guidelineDocId ?? "");
  const [namingTemplate, setNamingTemplate] = useState(initial.namingTemplate);
  const [status, setStatus] = useState<Status>("idle");
  const [message, setMessage] = useState<string | null>(null);

  async function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setStatus("saving");
    setMessage(null);

    try {
      const response = await fetch(`/api/orgs/${orgId}/settings/document`, {
        method: "PUT",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ folder, guideline, namingTemplate }),
      });
      if (!response.ok) {
        const body = (await response.json().catch(() => ({}))) as {
          error?: string;
        };
        setStatus("error");
        setMessage(body.error ?? `The server returned status ${response.status}.`);
        return;
      }
      const saved = (await response.json()) as DocumentSettings;
      setFolder(saved.folderId ?? "");
      setGuideline(saved.guidelineDocId ?? "");
      setNamingTemplate(saved.namingTemplate);
      setStatus("saved");
      setMessage("Saved. New documents use these settings from the next session.");
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
              Paste the folder URL or its id. Every pair&apos;s document is
              created here.
            </p>
          </div>

          <div className="space-y-2">
            <Label htmlFor="guideline">Guideline document (optional)</Label>
            <Input
              id="guideline"
              value={guideline}
              onChange={(event) => setGuideline(event.target.value)}
              placeholder="https://docs.google.com/document/d/…/edit"
            />
            <p className="text-xs text-muted-foreground">
              A template copied for each new pair. Leave blank to start from an
              empty document.
            </p>
          </div>

          <div className="space-y-2">
            <Label htmlFor="namingTemplate">Naming template</Label>
            <Input
              id="namingTemplate"
              value={namingTemplate}
              onChange={(event) => setNamingTemplate(event.target.value)}
              required
            />
            <p className="text-xs text-muted-foreground">
              Placeholders: <code>{"{{pairTitle}}"}</code>,{" "}
              <code>{"{{mentorName}}"}</code>, <code>{"{{menteeName}}"}</code>.
            </p>
          </div>

          <div className="flex items-center gap-4">
            <Button type="submit" disabled={status === "saving"}>
              {status === "saving" ? "Saving…" : "Save"}
            </Button>
            {message ? (
              <p
                className={
                  status === "error"
                    ? "text-sm text-destructive"
                    : "text-sm text-muted-foreground"
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
