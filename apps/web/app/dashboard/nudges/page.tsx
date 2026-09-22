import { fetchAdminRoute } from "@/lib/server-api";
import { adminResultMessage } from "@/lib/admin-result-message";
import type { Nudge } from "@/lib/types";
import { formatTimestamp, nudgeStateTone } from "@/lib/format";
import { ToneBadge } from "@/components/tone-badge";
import { EmptyState } from "@/components/empty-state";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";

const ORG_ID = process.env["ORG_ID"];

export default async function NudgesPage() {
  if (!ORG_ID) {
    throw new Error("ORG_ID is not set for apps/web — see .env.example.");
  }

  const result = await fetchAdminRoute<Nudge[]>(`/orgs/${ORG_ID}/nudges?limit=200`);
  const message =
    result.status === "ok" && result.data.length === 0
      ? "No nudges recorded."
      : adminResultMessage(result, "nudges");

  return (
    <div className="space-y-4">
      <h1 className="text-xl font-semibold">Nudges</h1>
      {message !== null || result.status !== "ok" ? (
        <EmptyState message={message ?? "Something went wrong."} />
      ) : (
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>State</TableHead>
              <TableHead>Channel</TableHead>
              <TableHead>Body</TableHead>
              <TableHead>Escalation</TableHead>
              <TableHead>Sent</TableHead>
              <TableHead>Dropped reason</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {result.data.map((nudge) => (
              <TableRow key={nudge.id}>
                <TableCell>
                  <ToneBadge tone={nudgeStateTone(nudge.state)} label={nudge.state} />
                </TableCell>
                <TableCell>{nudge.channel}</TableCell>
                <TableCell className="max-w-md whitespace-normal">{nudge.body}</TableCell>
                <TableCell>{nudge.escalationLevel}</TableCell>
                <TableCell>{formatTimestamp(nudge.sentAt)}</TableCell>
                <TableCell>{nudge.droppedReason ?? "—"}</TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      )}
    </div>
  );
}
