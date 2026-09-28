import { randomUUID } from "node:crypto";
import { expect, test } from "@playwright/test";
import { db, seed, signIn } from "./support";

async function bindingConfig(orgId: string, slot: string): Promise<unknown> {
  const [row] = await db()<{ config: unknown }[]>`
    select config from integration_bindings where org_id = ${orgId} and slot = ${slot}`;
  return row?.config;
}

test("document and sheet settings: form → integration_bindings → reload", async ({
  page,
  context,
}) => {
  const s = seed();
  await signIn(context, s.orgA, s.userA);
  const tag = randomUUID().slice(0, 8);

  // Document slot — pasted browser URLs, which apps/api reduces to ids.
  const folderId = `e2eDocFolder${tag}`;
  const guidelineDocId = `e2eGuideline${tag}`;
  const namingTemplate = `E2E {{pairTitle}} ${tag}`;
  await page.goto("/dashboard/settings/document");
  await page.getByLabel("Drive folder").fill(`https://drive.google.com/drive/folders/${folderId}`);
  await page
    .getByLabel("Guideline document (optional)")
    .fill(`https://docs.google.com/document/d/${guidelineDocId}/edit`);
  await page.getByLabel("Naming template").fill(namingTemplate);
  await page.getByRole("button", { name: "Save" }).click();
  await expect(page.getByText(/^Saved\./)).toBeVisible();

  expect(await bindingConfig(s.orgA, "document")).toEqual({ folderId, guidelineDocId });

  await page.reload();
  await expect(page.getByLabel("Drive folder")).toHaveValue(folderId);
  await expect(page.getByLabel("Guideline document (optional)")).toHaveValue(guidelineDocId);
  await expect(page.getByLabel("Naming template")).toHaveValue(namingTemplate);

  // Sheet slot.
  const sheetFolderId = `e2eSheetFolder${tag}`;
  const spreadsheetId = `e2eSpreadsheet${tag}`;
  await page.goto("/dashboard/settings/sheet");
  await page.getByLabel("Drive folder").fill(`https://drive.google.com/drive/folders/${sheetFolderId}`);
  await page
    .getByLabel("Spreadsheet (optional)")
    .fill(`https://docs.google.com/spreadsheets/d/${spreadsheetId}/edit`);
  await page.getByRole("button", { name: "Save" }).click();
  await expect(page.getByText(/^Saved\./)).toBeVisible();

  expect(await bindingConfig(s.orgA, "sheet")).toEqual({ folderId: sheetFolderId, spreadsheetId });

  await page.reload();
  await expect(page.getByLabel("Drive folder")).toHaveValue(sheetFolderId);
  await expect(page.getByLabel("Spreadsheet (optional)")).toHaveValue(spreadsheetId);
});
