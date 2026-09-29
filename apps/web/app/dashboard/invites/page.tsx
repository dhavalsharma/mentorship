import { InviteForm } from "./invite-form";

const ORG_ID = process.env["ORG_ID"];

/**
 * No server-side read here, unlike the settings pages: there is nothing to
 * pre-fill, and no `GET /orgs/:orgId/cohorts` exists yet to offer a cohort
 * picker — so the cohort is typed as its id. The dashboard layout's own probe
 * already sends a signed-out visitor to `/login`.
 */
export default function InvitesPage() {
  if (!ORG_ID) {
    throw new Error("ORG_ID is not set for apps/web — see .env.example.");
  }

  return (
    <div className="space-y-4">
      <h1 className="text-xl font-semibold">Invite someone</h1>
      <p className="text-sm text-muted-foreground">
        Invites one person, by email, into a cohort in a given role. They are
        sent a sign-in link; following it confirms their email and enrols
        them. Inviting the same person again to the same cohort and role
        re-sends the link rather than creating a second invite.
      </p>
      <InviteForm orgId={ORG_ID} />
    </div>
  );
}
