import { redirect } from "next/navigation";
import Link from "next/link";
import { fetchAdminRoute } from "@/lib/server-api";

const ORG_ID = process.env["ORG_ID"];

// Every page under here depends on the incoming request's session cookie
// and a live call to apps/api — there is nothing here that can be
// statically prerendered at build time, and ORG_ID/API_ORIGIN are runtime
// configuration, not build-time constants.
export const dynamic = "force-dynamic";

/**
 * There is no `/auth/me` endpoint (deliberately out of scope for the
 * backend — see the report), so "am I logged in" is answered the only way
 * available: make a real, cheap request to a protected data route and read
 * the status. `limit=1` keeps it cheap regardless of which page renders
 * next, since every dashboard page re-fetches its own full list anyway.
 * A 401 means no/invalid session -> bounce to /login. A 403 would mean the
 * session belongs to a different org than `ORG_ID`, which for this
 * single-tenant deployment is a misconfiguration, not a normal user path —
 * it still routes to /login rather than crashing the layout.
 */
export default async function DashboardLayout({ children }: { children: React.ReactNode }) {
  if (!ORG_ID) {
    throw new Error(
      "ORG_ID is not set for apps/web — see .env.example. It must match the " +
        "org apps/api and apps/worker are configured for.",
    );
  }

  const probe = await fetchAdminRoute(`/orgs/${ORG_ID}/risk-findings?limit=1`);
  if (probe.status === "unauthorized" || probe.status === "forbidden") {
    redirect("/login");
  }

  return (
    <div className="flex flex-1 flex-col">
      <header className="border-b">
        <nav className="mx-auto flex max-w-5xl items-center gap-6 px-6 py-4">
          <span className="font-semibold">Mentorship Admin</span>
          <Link href="/dashboard/risk-findings" className="text-sm hover:underline">
            Risk findings
          </Link>
          <Link href="/dashboard/nudges" className="text-sm hover:underline">
            Nudges
          </Link>
          <Link href="/dashboard/stuck-sagas" className="text-sm hover:underline">
            Stuck sagas
          </Link>
          <Link href="/dashboard/dead-letters" className="text-sm hover:underline">
            Dead letters
          </Link>
          <Link href="/dashboard/matching-rounds" className="text-sm hover:underline">
            Matching rounds
          </Link>
          <Link href="/dashboard/invites" className="text-sm hover:underline">
            Invites
          </Link>
          <Link
            href="/dashboard/settings/document"
            className="text-sm hover:underline"
          >
            Shared document
          </Link>
          <Link
            href="/dashboard/settings/sheet"
            className="text-sm hover:underline"
          >
            Report spreadsheet
          </Link>
        </nav>
      </header>
      <main className="mx-auto w-full max-w-5xl flex-1 px-6 py-8">{children}</main>
    </div>
  );
}
