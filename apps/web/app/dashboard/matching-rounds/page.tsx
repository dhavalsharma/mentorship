import { fetchAdminRoute } from "@/lib/server-api";
import { adminResultMessage } from "@/lib/admin-result-message";
import type { MatchingRoundCandidates } from "@/lib/types";
import { formatTimestamp } from "@/lib/format";
import { ToneBadge } from "@/components/tone-badge";
import { EmptyState } from "@/components/empty-state";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
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
 * The appeal view: every (mentee, mentor) pair a matching round considered,
 * winners and losers alike, with the score and explanation behind each —
 * "why wasn't I matched with X" has to be a row here, not a rerun of the
 * solver (see `CandidateRecordSchema` in
 * `packages/primitives/matching/src/types.ts`).
 *
 * There is no list of past rounds to browse yet — matching is not wired
 * into any admin flow that would produce one (see the "Matching" row in
 * CLAUDE.md) — so this is a lookup by run id (an `ai_runs.id`) rather than
 * a table with a row per round, the same shape `/dashboard/settings/document`
 * takes for a single, id-addressed resource.
 */
export default async function MatchingRoundsPage({
  searchParams,
}: {
  searchParams: Promise<{ runId?: string }>;
}) {
  if (!ORG_ID) {
    throw new Error("ORG_ID is not set for apps/web — see .env.example.");
  }

  const { runId } = await searchParams;

  return (
    <div className="space-y-4">
      <h1 className="text-xl font-semibold">Matching round candidates</h1>
      <p className="text-sm text-muted-foreground">
        Every candidate pair a matching round scored — including the ones it
        did not pick — with the feature scores and explanation behind each.
        Paste the round&apos;s run id below.
      </p>
      <form className="flex items-end gap-2" action="/dashboard/matching-rounds">
        <div className="flex flex-col gap-1">
          <Label htmlFor="runId">Run id</Label>
          <Input
            id="runId"
            name="runId"
            defaultValue={runId ?? ""}
            placeholder="00000000-0000-0000-0000-000000000000"
            className="w-96 font-mono text-xs"
          />
        </div>
        <Button type="submit">Look up</Button>
      </form>
      {runId ? <Candidates orgId={ORG_ID} runId={runId} /> : null}
    </div>
  );
}

async function Candidates({ orgId, runId }: { orgId: string; runId: string }) {
  const result = await fetchAdminRoute<MatchingRoundCandidates>(
    `/orgs/${orgId}/matching-rounds/${runId}/candidates`,
  );

  if (result.status === "error" && result.statusCode === 404) {
    return <EmptyState message="No matching round found for that run id." />;
  }
  const message = adminResultMessage(result, "matching round candidates");
  if (message !== null || result.status !== "ok") {
    return <EmptyState message={message ?? "Something went wrong."} />;
  }

  if (result.data.candidates.length === 0) {
    return <EmptyState message="This round considered no candidates." />;
  }

  const rows = [...result.data.candidates].sort((a, b) =>
    a.menteeId === b.menteeId
      ? a.rank - b.rank
      : a.menteeId.localeCompare(b.menteeId),
  );

  return (
    <div className="space-y-2">
      <p className="text-sm text-muted-foreground">
        Cohort <span className="font-mono">{result.data.cohortId}</span>, as of{" "}
        {formatTimestamp(result.data.asOf)}.
      </p>
      <Table>
        <TableHeader>
          <TableRow>
            <TableHead>Mentee</TableHead>
            <TableHead>Mentor</TableHead>
            <TableHead>Result</TableHead>
            <TableHead>Score</TableHead>
            <TableHead>Rank</TableHead>
            <TableHead>Why</TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {rows.map((candidate) => (
            <TableRow key={`${candidate.menteeId}:${candidate.mentorId}`}>
              <TableCell className="font-mono text-xs">{candidate.menteeId}</TableCell>
              <TableCell className="font-mono text-xs">{candidate.mentorId}</TableCell>
              <TableCell>
                <ToneBadge
                  tone={candidate.won ? "neutral" : candidate.eligible ? "warning" : "critical"}
                  label={candidate.won ? "Matched" : candidate.eligible ? "Considered" : "Ineligible"}
                />
              </TableCell>
              <TableCell>{candidate.adjustedScore.toFixed(2)}</TableCell>
              <TableCell>{candidate.rank > 0 ? candidate.rank : "—"}</TableCell>
              <TableCell className="max-w-md whitespace-normal">
                {explanationFor(candidate)}
              </TableCell>
            </TableRow>
          ))}
        </TableBody>
      </Table>
    </div>
  );
}

/**
 * One line an appeal can actually read: why this pair was ruled out
 * entirely, or — for an eligible pair — the rationale a human/model gave,
 * falling back to the first scored feature's own explanation.
 */
function explanationFor(candidate: MatchingRoundCandidates["candidates"][number]): string {
  if (!candidate.eligible) {
    return candidate.violations.length > 0
      ? `Ruled out: ${candidate.violations.join(", ")}`
      : "Ruled out by a hard constraint.";
  }
  if (candidate.rationale) return candidate.rationale;
  const [firstExplanation] = Object.values(candidate.explanations);
  return firstExplanation ?? "—";
}
