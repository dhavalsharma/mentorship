"use client";

import { useState, type FormEvent } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { isPlausibleEmail } from "@/lib/validation";

type Status = "idle" | "submitting" | "submitted";

export default function LoginPage() {
  const [email, setEmail] = useState("");
  const [status, setStatus] = useState<Status>("idle");
  const [formError, setFormError] = useState<string | null>(null);

  async function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setFormError(null);

    if (!isPlausibleEmail(email)) {
      setFormError("Enter a valid email address.");
      return;
    }

    setStatus("submitting");
    try {
      await fetch("/api/auth/request-link", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ email: email.trim() }),
      });
    } finally {
      // Deliberately unconditional: the backend's own response is
      // enumeration-safe (always `{requested: true}` regardless of whether
      // the email matches an account), and this page must not undo that by
      // branching on the response body, the status code, or a network
      // failure — every outcome renders the identical message below.
      setStatus("submitted");
    }
  }

  return (
    <div className="flex flex-1 items-center justify-center p-6">
      <Card className="w-full max-w-sm">
        <CardHeader>
          <CardTitle>Sign in</CardTitle>
          <CardDescription>
            Enter your email and we&apos;ll send you a sign-in link.
          </CardDescription>
        </CardHeader>
        <CardContent>
          {status === "submitted" ? (
            <div className="space-y-4">
              <p className="text-sm">
                If that email has an account, check for a sign-in link.
              </p>
              <DevModeNote />
            </div>
          ) : (
            <form onSubmit={handleSubmit} className="space-y-4">
              <div className="space-y-2">
                <Label htmlFor="email">Email</Label>
                <Input
                  id="email"
                  type="email"
                  autoComplete="email"
                  value={email}
                  onChange={(event) => setEmail(event.target.value)}
                  placeholder="you@example.com"
                  required
                />
                {formError ? (
                  <p className="text-sm text-destructive">{formError}</p>
                ) : null}
              </div>
              <Button type="submit" className="w-full" disabled={status === "submitting"}>
                {status === "submitting" ? "Sending…" : "Send sign-in link"}
              </Button>
              <DevModeNote />
            </form>
          )}
        </CardContent>
      </Card>
    </div>
  );
}

function DevModeNote() {
  return (
    <p className="rounded-md border border-dashed p-3 text-xs text-muted-foreground">
      <strong>Dev mode:</strong> this environment has no email sending
      configured. The sign-in link is printed to the <code>apps/api</code>{" "}
      server console instead, as{" "}
      <code>[auth] magic link for &lt;email&gt;: &lt;token&gt;</code>. Copy
      the token into <code>/verify?token=&lt;token&gt;</code> to continue. A
      real deployment would wire up actual email delivery here.
    </p>
  );
}
