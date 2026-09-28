import { expect, test } from "@playwright/test";
import { seed, signIn } from "./support";

/**
 * The four read tables, each showing a row the global setup seeded — a real
 * value through apps/api's query, the server component's cookie forwarding
 * and the render, not just "a table exists".
 */
test("risk findings, nudges, stuck sagas and dead letters render seeded rows", async ({
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

  // Tenancy on the read path too: org B's finding never shows up for org A.
  await page.goto("/dashboard/risk-findings");
  await expect(page.getByText(s.orgBRiskSummary)).toHaveCount(0);
});
