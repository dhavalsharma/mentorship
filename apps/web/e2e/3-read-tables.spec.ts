import { expect, test } from "@playwright/test";
import { seed, signIn } from "./support";

/**
 * The five read tables, each showing a row the global setup seeded — a real
 * value through apps/api's query, the server component's cookie forwarding
 * and the render, not just "a table exists".
 */
test("risk findings, nudges, stuck sagas, dead letters and pair preferences render seeded rows", async ({
  page,
  context,
}) => {
  const s = seed();
  await signIn(context, s.orgA, s.userA);

  const pages: [string, string][] = [
    ["/dashboard/risk-findings", s.riskSummary],
    ["/dashboard/nudges", s.nudgeBody],
    ["/dashboard/stuck-sagas", s.stuckSubjectRef],
    ["/dashboard/dead-letters", s.deadLetterError],
  ];
  for (const [route, seededValue] of pages) {
    await page.goto(route);
    await expect(page).toHaveURL(new RegExp(`${route}$`));
    await expect(page.getByRole("cell", { name: seededValue })).toBeVisible();
  }

  // Pair preferences: who changed it, what they changed, and — because the
  // pair moved off the program's 45-minute default — the drift marker.
  // Exact names: the mentee's name also appears inside the "Pair" cell.
  await page.goto("/dashboard/pair-preferences");
  await expect(page).toHaveURL(/\/dashboard\/pair-preferences$/);
  const row = page.getByRole("row").filter({ hasText: s.preferenceChangedBy });
  await expect(row.getByRole("cell", { name: s.preferenceChangedBy, exact: true })).toBeVisible();
  await expect(row.getByRole("cell", { name: "length → 30 min", exact: true })).toBeVisible();
  await expect(row.getByText("Differs from default")).toBeVisible();
  await expect(row.getByRole("cell", { name: "45 min, every 2 weeks", exact: true })).toBeVisible();

  // Tenancy on the read path too: org B's finding never shows up for org A.
  await page.goto("/dashboard/risk-findings");
  await expect(page.getByText(s.orgBRiskSummary)).toHaveCount(0);
});
