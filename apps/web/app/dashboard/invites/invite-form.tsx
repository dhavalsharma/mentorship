"use client";

import { useState, type FormEvent } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Card, CardContent } from "@/components/ui/card";

type Status = "idle" | "sending" | "sent" | "error";

interface InviteResponse {
  participantId: string;
  alreadyInvited: boolean;
  state: string;
  signInLinkIssued: boolean;
}

interface InviteError {
  error?: string;
  issues?: { field: string; message: string }[];
}

/**
 * Validation lives in `apps/api` (`InviteRequestSchema`, then `planInvite`),
 * so this form sends what was typed and renders the per-field issues that
 * come back rather than re-implementing either check client-side.
 */
export function InviteForm({ orgId }: { orgId: string }) {
  const [email, setEmail] = useState("");
  const [cohortId, setCohortId] = useState("");
  const [role, setRole] = useState("mentee");
  const [displayName, setDisplayName] = useState("");
  const [status, setStatus] = useState<Status>("idle");
  const [message, setMessage] = useState<string | null>(null);
  const [fieldErrors, setFieldErrors] = useState<Record<string, string>>({});

  async function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setStatus("sending");
    setMessage(null);
    setFieldErrors({});

    try {
      const response = await fetch(`/api/orgs/${orgId}/invites`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          email,
          cohortId: cohortId.trim(),
          role,
          ...(displayName.trim() ? { displayName: displayName.trim() } : {}),
        }),
      });
      if (!response.ok) {
        const body = (await response.json().catch(() => ({}))) as InviteError;
        const errors: Record<string, string> = {};
        for (const issue of body.issues ?? []) errors[issue.field] = issue.message;
        setFieldErrors(errors);
        setStatus("error");
        setMessage(body.error ?? `The server returned status ${response.status}.`);
        return;
      }
      const result = (await response.json()) as InviteResponse;
      setStatus("sent");
      setMessage(describe(result));
    } catch {
      setStatus("error");
      setMessage("Couldn't reach the API server.");
    }
  }

  return (
    <Card>
      <CardContent className="pt-6">
        <form onSubmit={handleSubmit} className="space-y-6">
          <Field id="email" label="Email" error={fieldErrors["email"]}>
            <Input
              id="email"
              type="email"
              value={email}
              onChange={(event) => setEmail(event.target.value)}
              required
            />
          </Field>
          <Field
            id="cohortId"
            label="Cohort id"
            error={fieldErrors["cohortId"]}
            hint="The cohort's id (a UUID)."
          >
            <Input
              id="cohortId"
              value={cohortId}
              onChange={(event) => setCohortId(event.target.value)}
              required
            />
          </Field>
          <Field
            id="role"
            label="Role"
            error={fieldErrors["role"]}
            hint="One of the roles this cohort's program defines."
          >
            <Input
              id="role"
              value={role}
              onChange={(event) => setRole(event.target.value)}
              required
            />
          </Field>
          <Field
            id="displayName"
            label="Name (optional)"
            error={fieldErrors["displayName"]}
            hint="Used only if this person has no account yet."
          >
            <Input
              id="displayName"
              value={displayName}
              onChange={(event) => setDisplayName(event.target.value)}
            />
          </Field>

          <div className="flex items-center gap-4">
            <Button type="submit" disabled={status === "sending"}>
              {status === "sending" ? "Inviting…" : "Invite"}
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

function describe(result: InviteResponse): string {
  if (result.state !== "invited") {
    return "This person is already enrolled in that cohort and role — nothing was sent.";
  }
  const link = result.signInLinkIssued ? " A sign-in link has been issued." : "";
  return result.alreadyInvited
    ? `Already invited and still waiting on them.${link}`
    : `Invited.${link}`;
}

function Field({
  id,
  label,
  error,
  hint,
  children,
}: {
  id: string;
  label: string;
  error?: string | undefined;
  hint?: string;
  children: React.ReactNode;
}) {
  return (
    <div className="space-y-2">
      <Label htmlFor={id}>{label}</Label>
      {children}
      {error ? (
        <p className="text-xs text-destructive">{error}</p>
      ) : hint ? (
        <p className="text-xs text-muted-foreground">{hint}</p>
      ) : null}
    </div>
  );
}
