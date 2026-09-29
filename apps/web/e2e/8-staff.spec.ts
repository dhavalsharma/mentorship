import { expect, test } from "@playwright/test";
import { db, seed, signIn } from "./support";

/**
 * Staff management from the dashboard (ADR-0010): the seeded admin makes
 * another seeded user a program lead, sees them in the table, and removes
 * them — and the candidate's own session follows each change on its next
 * request. The admin cannot remove themselves while they are the only one.
 */
test("admin grants program lead from the staff page, then removes it", async ({
  page,
  context,
  browser,
}) => {
  const s = seed();
  await signIn(context, s.orgA, s.userA);
  await page.goto("/dashboard/settings/staff");
  await expect(page.getByRole("heading", { name: "Staff" })).toBeVisible();
  const rows = page.getByTestId("staff-row");
  await expect(rows.filter({ hasText: s.adminEmail })).toContainText("Admin");
  await expect(rows.filter({ hasText: s.staffCandidateEmail })).toHaveCount(0);

  // Grant.
  await page.getByLabel("Email").fill(s.staffCandidateEmail);
  await page.getByLabel("Role").selectOption("program_lead");
  await page.getByRole("button", { name: "Save" }).click();
  await expect(page.getByText(`${s.staffCandidateEmail} is now a program lead.`)).toBeVisible();
  await expect(rows.filter({ hasText: s.staffCandidateEmail })).toContainText("Program lead");

  // The candidate, signed in separately, is staff now — but a program lead,
  // so this page is the one thing on the dashboard they are refused.
  const candidate = await browser.newContext();
  await signIn(candidate, s.orgA, s.staffCandidateId);
  const candidatePage = await candidate.newPage();
  await candidatePage.goto("/dashboard/settings/staff");
  await expect(candidatePage).toHaveURL(/\/dashboard\/settings\/staff$/);
  await expect(
    candidatePage.getByText("Your role doesn't include managing staff. Ask an admin of this organisation."),
  ).toBeVisible();
  await expect(candidatePage.getByLabel("Email")).toHaveCount(0);

  // The last admin cannot remove themselves; the API's 409 is shown as is.
  await page.getByLabel("Email").fill(s.adminEmail);
  await page.getByLabel("Role").selectOption("none");
  await page.getByRole("button", { name: "Save" }).click();
  await expect(page.getByText(/would leave the organisation with no admin/)).toBeVisible();
  await expect(rows.filter({ hasText: s.adminEmail })).toContainText("Admin");

  // Remove.
  await page.getByLabel("Email").fill(s.staffCandidateEmail);
  await page.getByLabel("Role").selectOption("none");
  await page.getByRole("button", { name: "Save" }).click();
  await expect(page.getByText(`Removed ${s.staffCandidateEmail}'s access.`, { exact: false })).toBeVisible();
  await expect(rows.filter({ hasText: s.staffCandidateEmail })).toHaveCount(0);

  // Their very next request is refused.
  await candidatePage.goto("/dashboard/risk-findings");
  await expect(candidatePage).toHaveURL(/\/no-access$/);
  await candidate.close();

  const audit = await db()<{ actor_type: string; actor_ref: string; after: { staffRole: string | null } }[]>`
    select actor_type, actor_ref, after from audit_log
    where org_id = ${s.orgA} and action = 'staff.role_changed'
      and subject_ref = ${`user:${s.staffCandidateId}`}
    order by created_at`;
  expect(audit.map((r) => [r.actor_type, r.actor_ref, r.after.staffRole])).toEqual([
    ["admin", s.userA, "program_lead"],
    ["admin", s.userA, null],
  ]);
});
