import { fetchAdminRoute } from "@/lib/server-api";
import { adminResultMessage } from "@/lib/admin-result-message";
import type { DeadLetteredEvent } from "@/lib/types";
import { formatTimestamp } from "@/lib/format";
import { ToneBadge } from "@/components/tone-badge";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";

const ORG_ID = process.env["ORG_ID"];

export default async function DeadLettersPage() {
  if (!ORG_ID) {
    throw new Error("ORG_ID is not set for apps/web — see .env.example.");
  }

  const result = await fetchAdminRoute<DeadLetteredEvent[]>(
    `/orgs/${ORG_ID}/dead-letters?limit=200`,
  );
  const message =
    result.status === "ok" && result.data.length === 0
      ? "No dead-lettered events."
      : adminResultMessage(result, "dead letters");

  return (
    <div className="space-y-4">
      <h1 className="text-xl font-semibold">Dead letters</h1>
      <p className="text-sm text-muted-foreground">
        Events the relay parked after repeated failures — nothing retries these
        automatically; each one needs a look.
      </p>
      {message !== null || result.status !== "ok" ? (
        <EmptyState message={message ?? "Something went wrong."} />
      ) : (
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>Event</TableHead>
              <TableHead>Subject</TableHead>
              <TableHead>Attempts</TableHead>
              <TableHead>Last error</TableHead>
              <TableHead>Parked</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {result.data.map((event) => (
              <TableRow key={event.id}>
                <TableCell className="font-medium">{event.name}</TableCell>
                <TableCell className="font-mono text-xs">{event.subjectRef}</TableCell>
                <TableCell>
                  <ToneBadge tone="critical" label={String(event.attempts)} />
                </TableCell>
                <TableCell className="max-w-md whitespace-normal">
                  {event.lastError ?? "—"}
                </TableCell>
                <TableCell>{formatTimestamp(event.deadLetteredAt)}</TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      )}
    </div>
  );
}

function EmptyState({ message }: { message: string }) {
  return (
    <p className="rounded-md border border-dashed p-6 text-sm text-muted-foreground">
      {message}
    </p>
  );
}
