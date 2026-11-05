import { expect, test } from "@playwright/test";
import { loginAs } from "./helpers/auth.js";

/** 準則2：應用負責人換別人的 appId，介面看不到。 */

test.describe("準則2：應用負責人 UI 隔離", () => {
  test("owner1 開 app-beta 地圖為無權限或空且無 beta 資料", async ({
    page,
  }) => {
    await loginAs(page, "owner1", "pass-owner-1");
    await page.goto("/apps/app-beta/map");
    const denied = page.getByTestId("no-permission");
    const empty = page.getByTestId("empty-state");
    const deniedVisible = await denied.isVisible().catch(() => false);
    const emptyVisible = await empty.isVisible().catch(() => false);
    expect(deniedVisible || emptyVisible).toBe(true);
    await expect(page.locator("body")).not.toContainText(/app-beta-secret/i);
    await expect(page.locator("body")).not.toContainText(/應用 beta 專屬/i);
  });
});
