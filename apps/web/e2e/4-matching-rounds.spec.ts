import { randomUUID } from "node:crypto";
import { expect, test } from "@playwright/test";
import { seed, signIn } from "./support";

test("look up a matching round by run id, and a run id that does not exist", async ({
  page,
  context,
}) => {
  const s = seed();
  await signIn(context, s.orgA, s.userA);

  await page.goto("/dashboard/matching-rounds");
  await page.getByLabel("Run id").fill(s.matchingRunId);
  await page.getByRole("button", { name: "Look up" }).click();
  await expect(page).toHaveURL(new RegExp(`runId=${s.matchingRunId}`));

  // Winner and loser both — the loser is the row an appeal is for.
  const winner = page.getByRole("row").filter({ hasText: s.matchingWinnerMentorId });
  const loser = page.getByRole("row").filter({ hasText: s.matchingLoserMentorId });
  await expect(winner).toContainText(s.matchingMenteeId);
  await expect(winner).toContainText("Matched");
  await expect(winner).toContainText("best available fit");
  await expect(loser).toContainText("Considered");

  await page.getByLabel("Run id").fill(randomUUID());
  await page.getByRole("button", { name: "Look up" }).click();
  await expect(page.getByText("No matching round found for that run id.")).toBeVisible();
  await expect(page.getByRole("row").filter({ hasText: s.matchingWinnerMentorId })).toHaveCount(0);
});
