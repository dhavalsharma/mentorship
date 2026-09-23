import { expect, test } from "@playwright/test";
import { db, seed, signIn } from "./support";

/**
 * Invariant 3 from the browser's side. apps/web has no org in its own URLs —
 * it is configured for one org — so "org B's URL" is the proxied api route a
 * browser can simply type, carrying org A's cookie through the same `/api`
 * rewrite the forms use.
 */
test("a session in org A is refused org B's data, reads and writes", async ({ page, context }) => {
  const s = seed();
  await signIn(context, s.orgA, s.userA);

  // Control: the same session reads its own org fine.
  const own = await page.request.get(`/api/orgs/${s.orgA}/risk-findings`);
  expect(own.status()).toBe(200);

  const read = await page.request.get(`/api/orgs/${s.orgB}/risk-findings`);
  expect(read.status()).toBe(403);
  expect(await read.text()).not.toContain(s.orgBRiskSummary);

  const settings = await page.request.get(`/api/orgs/${s.orgB}/settings/document`);
  expect(settings.status()).toBe(403);
  expect(await settings.text()).not.toContain(s.orgBFolderId);

  const write = await page.request.put(`/api/orgs/${s.orgB}/settings/document`, {
    data: { folder: "hijackedFolder", guideline: "", namingTemplate: "{{pairTitle}}" },
  });
  expect(write.status()).toBe(403);
  const [binding] = await db()<{ config: { folderId?: string } }[]>`
    select config from integration_bindings where org_id = ${s.orgB} and slot = 'document'`;
  expect(binding?.config.folderId).toBe(s.orgBFolderId);
});

test("a session from org B does not open org A's dashboard", async ({ browser }) => {
  const s = seed();
  const context = await browser.newContext();
  await signIn(context, s.orgB, s.userB);
  const page = await context.newPage();

  await page.goto("/dashboard/risk-findings");
  await expect(page).toHaveURL(/\/login$/);
  await expect(page.getByText(s.riskSummary)).toHaveCount(0);
  await context.close();
});
