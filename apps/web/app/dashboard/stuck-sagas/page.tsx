import { fetchAdminRoute } from "@/lib/server-api";
import { adminResultMessage } from "@/lib/admin-result-message";
import type { StuckSagaInstance } from "@/lib/types";
import { daysSince, formatTimestamp } from "@/lib/format";
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

/** A `running` instance stuck this long or longer shows up on this page. */
const STUCK_THRESHOLD_DAYS = 3;

export default async function StuckSagasPage() {
  if (!ORG_ID) {
    throw new Error("ORG_ID is not set for apps/web — see .env.example.");
  }

  const result = await fetchAdminRoute<StuckSagaInstance[]>(
    `/orgs/${ORG_ID}/stuck-sagas?limit=200&days=${STUCK_THRESHOLD_DAYS}`,
  );
  const message =
    result.status === "ok" && result.data.length === 0
      ? `No saga instances stuck for ${STUCK_THRESHOLD_DAYS}+ days.`
      : adminResultMessage(result, "stuck sagas");

  return (
    <div className="space-y-4">
      <h1 className="text-xl font-semibold">Stuck sagas</h1>
      <p className="text-sm text-muted-foreground">
        Running instances that have not advanced in {STUCK_THRESHOLD_DAYS}+ days —
        a due timer that never fired, or a step that keeps throwing.
      </p>
      {message !== null || result.status !== "ok" ? (
        <EmptyState message={message ?? "Something went wrong."} />
      ) : (
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>Saga</TableHead>
              <TableHead>Subject</TableHead>
              <TableHead>Stuck for</TableHead>
              <TableHead>Last progress</TableHead>
              <TableHead>Timeout</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {result.data.map((instance) => (
              <TableRow key={instance.id}>
                <TableCell className="font-medium">{instance.sagaName}</TableCell>
                <TableCell className="font-mono text-xs">{instance.subjectRef}</TableCell>
                <TableCell>
                  <ToneBadge tone="critical" label={daysSince(instance.updatedAt)} />
                </TableCell>
                <TableCell>{formatTimestamp(instance.updatedAt)}</TableCell>
                <TableCell>{formatTimestamp(instance.timeoutAt)}</TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      )}
    </div>
  );
}
