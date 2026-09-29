"use client";

import { useState, type FormEvent } from "react";
import { useRouter } from "next/navigation";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Card, CardContent } from "@/components/ui/card";

type Status = "idle" | "saving" | "saved" | "error";
type RoleChoice = "admin" | "program_lead" | "none";

interface StaffChangeResponse {
  member: { email: string; role: "admin" | "program_lead" | null };
  changed: boolean;
  createdUser: boolean;
}

interface StaffChangeError {
  error?: string;
  issues?: { field: string; message: string }[];
}

/**
 * One person, one role. Validation — the email rule, the role words, and the
 * last-admin refusal — all live in `apps/api`, so this form sends what was
 * typed and shows what comes back rather than re-deciding any of it here. On
 * success it refreshes the page so the table above is re-read from the API,
 * not patched locally into something the server might disagree with.
 */
export function StaffRoleForm({ orgId }: { orgId: string }) {
  const router = useRouter();
  const [email, setEmail] = useState("");
  const [role, setRole] = useState<RoleChoice>("program_lead");
  const [displayName, setDisplayName] = useState("");
  const [status, setStatus] = useState<Status>("idle");
  const [message, setMessage] = useState<string | null>(null);
  const [fieldErrors, setFieldErrors] = useState<Record<string, string>>({});

  async function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setStatus("saving");
    setMessage(null);
    setFieldErrors({});

    try {
      const response = await fetch(`/api/orgs/${orgId}/staff`, {
        method: "PUT",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          email,
          role,
          ...(displayName.trim() ? { displayName: displayName.trim() } : {}),
        }),
      });
      if (!response.ok) {
        const body = (await response.json().catch(() => ({}))) as StaffChangeError;
        const errors: Record<string, string> = {};
        for (const issue of body.issues ?? []) errors[issue.field] = issue.message;
        setFieldErrors(errors);
        setStatus("error");
        setMessage(body.error ?? `The server returned status ${response.status}.`);
        return;
      }
      const result = (await response.json()) as StaffChangeResponse;
      setStatus("saved");
      setMessage(describe(result));
      router.refresh();
    } catch {
      setStatus("error");
      setMessage("Couldn't reach the API server.");
    }
  }

  return (
    <Card>
      <CardContent className="pt-6">
        <form onSubmit={handleSubmit} className="space-y-6">
          <h2 className="text-sm font-semibold">Grant or remove access</h2>
          <Field id="staff-email" label="Email" error={fieldErrors["email"]}>
            <Input
              id="staff-email"
              type="email"
              value={email}
              onChange={(event) => setEmail(event.target.value)}
              required
            />
          </Field>
          <Field id="staff-role" label="Role" error={fieldErrors["role"]}>
            <select
              id="staff-role"
              value={role}
              onChange={(event) => setRole(event.target.value as RoleChoice)}
              className="h-8 w-full rounded-lg border border-input bg-transparent px-2.5 text-sm outline-none focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/50 dark:bg-input/30"
            >
              <option value="program_lead">Program lead</option>
              <option value="admin">Admin</option>
              <option value="none">Remove access</option>
            </select>
          </Field>
          <Field
            id="staff-name"
            label="Name (optional)"
            error={fieldErrors["displayName"]}
            hint="Used only if this person has no account yet."
          >
            <Input
              id="staff-name"
              value={displayName}
              onChange={(event) => setDisplayName(event.target.value)}
            />
          </Field>

          <div className="flex items-center gap-4">
            <Button type="submit" disabled={status === "saving"}>
              {status === "saving" ? "Saving…" : "Save"}
            </Button>
            {message ? (
              <p
                role={status === "error" ? "alert" : "status"}
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

function describe(result: StaffChangeResponse): string {
  const who = result.member.email;
  const role =
    result.member.role === "admin"
      ? "an admin"
      : result.member.role === "program_lead"
        ? "a program lead"
        : null;
  if (!result.changed) {
    return role ? `${who} is already ${role} — nothing changed.` : `${who} already has no access.`;
  }
  if (role === null) return `Removed ${who}'s access. It stops on their next request.`;
  const created = result.createdUser ? " They can now sign in with this email." : "";
  return `${who} is now ${role}.${created}`;
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
