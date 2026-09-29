import { fetchAdminRoute } from "@/lib/server-api";
import { adminResultMessage } from "@/lib/admin-result-message";
import type { PairPreferenceChanges } from "@/lib/types";
import {
  describeChanged,
  describeSessionCadence,
  formatTimestamp,
} from "@/lib/format";
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

/**
 * Pairs changing their own session length and rhythm (ADR-0009 action 7).
 * The ADR accepted that one member can change the pair's rhythm unilaterally;
 * this is where an admin sees a pair drifting from what the program intends —
 * each change set beside the program's own default for that pair's cohort.
 */
export default async function PairPreferencesPage() {
  if (!ORG_ID) {
    throw new Error("ORG_ID is not set for apps/web — see .env.example.");
  }

  const result = await fetchAdminRoute<PairPreferenceChanges>(
    `/orgs/${ORG_ID}/pair-preference-changes?limit=200`,
  );
  const message =
    result.status === "ok" && result.data.changes.length === 0
      ? "No pair has changed its session length or rhythm."
      : adminResultMessage(result, "pair preference changes");

  return (
    <div className="space-y-4">
      <h1 className="text-xl font-semibold">Pair preferences</h1>
      {result.status === "ok" && result.data.skipped > 0 ? (
        <p className="text-sm text-muted-foreground">
          {result.data.skipped} change{result.data.skipped === 1 ? "" : "s"} could not be read and{" "}
          {result.data.skipped === 1 ? "is" : "are"} not shown.
        </p>
      ) : null}
      {message !== null || result.status !== "ok" ? (
        <EmptyState message={message ?? "Something went wrong."} />
      ) : (
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>When</TableHead>
              <TableHead>Pair</TableHead>
              <TableHead>Changed by</TableHead>
              <TableHead>Changed</TableHead>
              <TableHead>Now</TableHead>
              <TableHead>Program default</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {result.data.changes.map((change) => (
              <TableRow key={change.eventId}>
                <TableCell>{formatTimestamp(change.occurredAt)}</TableCell>
                <TableCell>
                  {change.mentorName ?? "Unknown"} &amp; {change.menteeName ?? "Unknown"}
                </TableCell>
                <TableCell>{change.changedBy.displayName ?? "Unknown"}</TableCell>
                <TableCell>{describeChanged(change.changed)}</TableCell>
                <TableCell>
                  <span className="flex items-center gap-2">
                    {describeSessionCadence(change.result)}
                    {change.differsFromProgramDefault ? (
                      <ToneBadge tone="warning" label="Differs from default" />
                    ) : null}
                  </span>
                </TableCell>
                <TableCell>
                  {change.programDefault ? describeSessionCadence(change.programDefault) : "—"}
                </TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      )}
    </div>
  );
}
