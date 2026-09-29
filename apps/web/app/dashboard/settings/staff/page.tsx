import { fetchAdminRoute } from "@/lib/server-api";
import { adminResultMessage } from "@/lib/admin-result-message";
import type { StaffMember } from "@/lib/types";
import { EmptyState } from "@/components/empty-state";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { StaffRoleForm } from "./staff-role-form";

const ORG_ID = process.env["ORG_ID"];

const ROLE_LABELS: Record<StaffMember["role"], string> = {
  admin: "Admin",
  program_lead: "Program lead",
};

/**
 * Who runs this organisation's program, and changing that (ADR-0010). The
 * list and the form are both admin-only in `apps/api` (`staff.roles`), so a
 * program lead lands on the shared "Your role doesn't include …" message and
 * never sees the form. The very first admin still comes from
 * `pnpm staff:grant` — nobody can open this page before one exists.
 */
export default async function StaffSettingsPage() {
  if (!ORG_ID) {
    throw new Error("ORG_ID is not set for apps/web — see .env.example.");
  }

  const result = await fetchAdminRoute<StaffMember[]>(`/orgs/${ORG_ID}/staff`);

  return (
    <div className="space-y-4">
      <h1 className="text-xl font-semibold">Staff</h1>
      <p className="text-sm text-muted-foreground">
        Admins can do everything here, including changing who is staff. Program
        leads can see every list and invite people, but cannot change
        integration settings or staff. Everyone else — every mentor and mentee —
        has no access to this dashboard.
      </p>
      {result.status !== "ok" ? (
        <EmptyState message={adminResultMessage(result, "managing staff") ?? "Something went wrong."} />
      ) : (
        <>
          {result.data.length === 0 ? (
            <EmptyState message="No one is staff." />
          ) : (
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Name</TableHead>
                  <TableHead>Email</TableHead>
                  <TableHead>Role</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {result.data.map((member) => (
                  <TableRow key={member.userId} data-testid="staff-row">
                    <TableCell>{member.displayName}</TableCell>
                    <TableCell>{member.email}</TableCell>
                    <TableCell>{ROLE_LABELS[member.role]}</TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          )}
          <StaffRoleForm orgId={ORG_ID} />
        </>
      )}
    </div>
  );
}
