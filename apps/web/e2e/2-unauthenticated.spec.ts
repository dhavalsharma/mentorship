import { expect, test } from "@playwright/test";

/** Every dashboard route, with no session cookie at all, ends on /login. */
const DASHBOARD_ROUTES = [
  "/dashboard",
  "/dashboard/risk-findings",
  "/dashboard/nudges",
  "/dashboard/pair-preferences",
  "/dashboard/stuck-sagas",
  "/dashboard/dead-letters",
  "/dashboard/matching-rounds",
  "/dashboard/settings/document",
  "/dashboard/settings/sheet",
  "/dashboard/settings/staff",
  "/dashboard/invites",
];

test("each /dashboard route redirects to /login without a session", async ({ page }) => {
  for (const route of DASHBOARD_ROUTES) {
    await page.goto(route);
    await expect(page, `${route} should redirect`).toHaveURL(/\/login$/);
    await expect(page.getByRole("button", { name: "Send sign-in link" })).toBeVisible();
  }
});
