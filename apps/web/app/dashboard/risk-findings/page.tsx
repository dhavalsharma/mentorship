import { fetchAdminRoute } from "@/lib/server-api";
import { adminResultMessage } from "@/lib/admin-result-message";
import type { RiskFinding } from "@/lib/types";
import { formatTimestamp, requiresHumanLabel, severityTone } from "@/lib/format";
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

export default async function RiskFindingsPage() {
  if (!ORG_ID) {
    throw new Error("ORG_ID is not set for apps/web — see .env.example.");
  }

  const result = await fetchAdminRoute<RiskFinding[]>(
    `/orgs/${ORG_ID}/risk-findings?limit=200`,
  );
  const message =
    result.status === "ok" && result.data.length === 0
      ? "No risk findings recorded."
      : adminResultMessage(result, "risk findings");

  return (
    <div className="space-y-4">
      <h1 className="text-xl font-semibold">Risk findings</h1>
      {message !== null || result.status !== "ok" ? (
        <EmptyState message={message ?? "Something went wrong."} />
      ) : (
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>Severity</TableHead>
              <TableHead>Code</TableHead>
              <TableHead>Summary</TableHead>
              <TableHead>Detected</TableHead>
              <TableHead>Handling</TableHead>
              <TableHead>Acknowledged</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {result.data.map((finding) => (
              <TableRow key={finding.id}>
                <TableCell>
                  <ToneBadge tone={severityTone(finding.severity)} label={finding.severity} />
                </TableCell>
                <TableCell className="font-mono text-xs">{finding.code}</TableCell>
                <TableCell className="max-w-md whitespace-normal">{finding.summary}</TableCell>
                <TableCell>{formatTimestamp(finding.detectedAt)}</TableCell>
                <TableCell>
                  <ToneBadge
                    tone={finding.requiresHuman ? "critical" : "neutral"}
                    label={requiresHumanLabel(finding.requiresHuman)}
                  />
                </TableCell>
                <TableCell>{formatTimestamp(finding.acknowledgedAt)}</TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      )}
    </div>
  );
}
