import { createHash, randomUUID } from "node:crypto";
import { expect, test, type Page } from "@playwright/test";
import { SESSION_COOKIE, apiLogMentions, db, readMagicLinkToken, seed } from "./support";

/**
 * The whole auth round trip through a real browser: the login form, the
 * `/api` rewrite to apps/api, the printed link, `/verify`, the session cookie
 * set through the proxy, and the dashboard accepting it on the next request.
 */

async function requestLink(page: Page, email: string) {
  await page.goto("/login");
  await page.getByLabel("Email").fill(email);
  const response = page.waitForResponse("**/api/auth/request-link");
  await page.getByRole("button", { name: "Send sign-in link" }).click();
  const res = await response;
  const card = page.locator('[data-slot="card-content"]');
  await expect(card).toContainText("check for a sign-in link");
  return { status: res.status(), body: await res.text(), rendered: await card.innerText() };
}

test("a known and an unknown email render the identical message", async ({ page }) => {
  const { adminEmail } = seed();
  const unknownEmail = `nobody-${randomUUID().slice(0, 8)}@example.test`;

  const known = await requestLink(page, adminEmail);
  const unknown = await requestLink(page, unknownEmail);

  // The client claims enumeration safety too: nothing it renders, and
  // nothing it received, may tell the two apart.
  expect(unknown.rendered).toBe(known.rendered);
  expect(unknown.status).toBe(known.status);
  expect(unknown.body).toBe(known.body);

  expect(await apiLogMentions(`magic link for ${unknownEmail}`)).toBe(false);
});

test("request a link, follow it, land on the dashboard with a session that survives a reload", async ({
  page,
  context,
}) => {
  const { adminEmail, orgA } = seed();
  await requestLink(page, adminEmail);
  const token = await readMagicLinkToken(adminEmail);

  // What the database holds is the hash, never the bearer token itself.
  const hash = createHash("sha256").update(token).digest("hex");
  const rows = await db()<{ token_hash: string; consumed_at: Date | null }[]>`
    select token_hash, consumed_at from magic_links where org_id = ${orgA}`;
  expect(rows.map((r) => r.token_hash)).toContain(hash);
  expect(rows.map((r) => r.token_hash)).not.toContain(token);

  await page.goto(`/verify?token=${token}`);
  await expect(page).toHaveURL(/\/dashboard\/risk-findings$/);
  await expect(page.getByRole("heading", { name: "Risk findings" })).toBeVisible();

  const cookie = (await context.cookies()).find((c) => c.name === SESSION_COOKIE);
  expect(cookie?.httpOnly).toBe(true);

  await page.reload();
  await expect(page).toHaveURL(/\/dashboard\/risk-findings$/);

  // One-time use: the same link a second time is refused.
  await page.goto(`/verify?token=${token}`);
  await expect(page.getByText("That link has already been used.")).toBeVisible();
});
