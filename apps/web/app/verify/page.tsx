"use client";

import { Suspense, useEffect, useState } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import Link from "next/link";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import type { VerifyFailureReason } from "@/lib/types";

type Outcome =
  | { kind: "verifying" }
  | { kind: "missing_token" }
  | { kind: "failed"; reason: VerifyFailureReason }
  | { kind: "request_failed" };

const REASON_COPY: Record<VerifyFailureReason, string> = {
  not_found: "That link is invalid. It may have already been used on a different device.",
  expired: "That link has expired. Request a new one.",
  already_used: "That link has already been used.",
};

export default function VerifyPage() {
  return (
    <Suspense fallback={<VerifyCard outcome={{ kind: "verifying" }} />}>
      <VerifyPageInner />
    </Suspense>
  );
}

function VerifyPageInner() {
  const router = useRouter();
  const searchParams = useSearchParams();
  const token = searchParams.get("token");
  const [outcome, setOutcome] = useState<Outcome>(
    token ? { kind: "verifying" } : { kind: "missing_token" },
  );

  useEffect(() => {
    if (!token) return;

    let cancelled = false;
    (async () => {
      try {
        const response = await fetch("/api/auth/verify", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ token }),
        });
        const body = (await response.json()) as
          | { ok: true }
          | { ok: false; reason: VerifyFailureReason };

        if (cancelled) return;
        if (body.ok) {
          router.replace("/dashboard");
          return;
        }
        setOutcome({ kind: "failed", reason: body.reason });
      } catch {
        if (!cancelled) setOutcome({ kind: "request_failed" });
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [token, router]);

  return <VerifyCard outcome={outcome} />;
}

function VerifyCard({ outcome }: { outcome: Outcome }) {
  return (
    <div className="flex flex-1 items-center justify-center p-6">
      <Card className="w-full max-w-sm">
        <CardHeader>
          <CardTitle>Signing in</CardTitle>
          <CardDescription>{describe(outcome)}</CardDescription>
        </CardHeader>
        {outcome.kind !== "verifying" ? (
          <CardContent>
            <Link href="/login" className="text-sm underline underline-offset-4">
              Back to sign in
            </Link>
          </CardContent>
        ) : null}
      </Card>
    </div>
  );
}

function describe(outcome: Outcome): string {
  switch (outcome.kind) {
    case "verifying":
      return "Verifying your link…";
    case "missing_token":
      return "This link is missing its token.";
    case "request_failed":
      return "Couldn't reach the server. Try again.";
    case "failed":
      return REASON_COPY[outcome.reason];
  }
}
