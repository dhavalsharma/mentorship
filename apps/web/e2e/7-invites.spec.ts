import { randomUUID } from "node:crypto";
import { expect, test } from "@playwright/test";
import { db, readMagicLinkToken, seed, signIn } from "./support";

/**
 * Admin invites someone through the form; the invitee follows the link
 * `apps/api` printed for them, and that sign-in is what enrols them — and
 * lands them on `/no-access`, never the admin dashboard (ADR-0010).
 */
test("invite form → invited participant → invitee follows the link → enrolled, and not an admin", async ({
  page,
  context,
  browser,
}) => {
  const s = seed();
  const tag = randomUUID().slice(0, 8);
  const email = `e2e-invitee-${tag}@example.test`;

  const [program] = await db()<{ id: string }[]>`
    select id from programs where org_id = ${s.orgA} limit 1`;
  const [cohort] = await db()<{ id: string }[]>`
    insert into cohorts (org_id, program_id, name, starts_at, ends_at)
    values (${s.orgA}, ${program!.id}, ${`E2E cohort ${tag}`}, now(), now() + interval '90 days')
    returning id`;

  await signIn(context, s.orgA, s.userA);
  await page.goto("/dashboard/invites");
  await page.getByLabel("Email").fill(email);
  await page.getByLabel("Cohort id").fill(cohort!.id);
  await page.getByLabel("Role").fill("mentee");
  await page.getByRole("button", { name: "Invite" }).click();
  await expect(page.getByText(/^Invited\. A sign-in link has been issued\./)).toBeVisible();

  // An unknown role comes back as a field error, not a generic failure.
  await page.getByLabel("Role").fill("sponsor");
  await page.getByRole("button", { name: "Invite" }).click();
  await expect(page.getByText(/not a role in this cohort's program/)).toBeVisible();

  const participantState = async () => {
    const [row] = await db()<{ state: string }[]>`
      select p.state from participants p join users u on u.id = p.user_id
      where p.org_id = ${s.orgA} and u.email = ${email}`;
    return row?.state;
  };
  expect(await participantState()).toBe("invited");

  // The invitee, in a browser with no admin session, follows their link.
  const token = await readMagicLinkToken(email);
  const invitee = await browser.newContext();
  const inviteePage = await invitee.newPage();
  const verified = inviteePage.waitForResponse(
    (r) => r.url().includes("/auth/verify") && r.request().method() === "POST",
  );
  await inviteePage.goto(`/verify?token=${token}`);
  expect((await verified).status()).toBe(200);

  // Signed in for real, and not staff: `/verify` sends them to `/dashboard`,
  // whose layout turns them away to `/no-access` — not back to `/login`,
  // which would loop them through another link to the same refusal.
  await expect(inviteePage).toHaveURL(/\/no-access$/);
  await expect(
    inviteePage.getByText("You're signed in, but you don't have admin access to this organisation."),
  ).toBeVisible();
  await expect(inviteePage.getByRole("link", { name: "Risk findings" })).toHaveCount(0);

  // Every dashboard route, typed in directly, ends in the same place.
  for (const route of ["/dashboard/risk-findings", "/dashboard/invites", "/dashboard/settings/document"]) {
    await inviteePage.goto(route);
    await expect(inviteePage, `${route} should refuse the invitee`).toHaveURL(/\/no-access$/);
  }

  // And the API itself refuses their session — the dashboard is not the gate.
  const cookie = (await invitee.cookies()).find((c) => c.name === "mentorship_session");
  expect(cookie).toBeDefined();
  const direct = await inviteePage.request.post(`/api/orgs/${s.orgA}/invites`, {
    data: { email: `e2e-friend-${tag}@example.test`, cohortId: cohort!.id, role: "mentee" },
  });
  expect(direct.status()).toBe(403);
  await invitee.close();

  expect(await participantState()).toBe("enrolled");
  const audit = await db()<{ action: string }[]>`
    select action from audit_log where org_id = ${s.orgA} order by created_at`;
  expect(audit.map((r) => r.action)).toEqual(
    expect.arrayContaining(["participant.invited", "identity.verified"]),
  );
});
