import Link from "next/link";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";

/**
 * Where a signed-in session that is not staff lands (ADR-0010) — typically
 * an invited participant who followed their magic link, since `/verify`
 * sends everyone to `/dashboard`. Deliberately outside `/dashboard`, so the
 * dashboard layout's probe cannot redirect it anywhere, and deliberately not
 * `/login`: this person is already signed in, and another link would only
 * bring them back here.
 *
 * It says nothing about *why* — whether the org is wrong or the role is
 * missing — for the same reason the API's two 403s share one body.
 */
export default function NoAccessPage() {
  return (
    <div className="flex flex-1 items-center justify-center p-6">
      <Card className="w-full max-w-sm">
        <CardHeader>
          <CardTitle>No admin access</CardTitle>
          <CardDescription>
            You&apos;re signed in, but you don&apos;t have admin access to this organisation.
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-2 text-sm text-muted-foreground">
          <p>
            If you run this program, ask an existing admin to grant you access. If you&apos;re
            taking part in it, there&apos;s nothing you need to do here.
          </p>
          <p>
            <Link href="/login" className="underline">
              Sign in with a different email
            </Link>
          </p>
        </CardContent>
      </Card>
    </div>
  );
}
