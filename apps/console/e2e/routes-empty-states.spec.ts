import { expect, test } from "@playwright/test";
import { loginAs } from "./helpers/auth.js";
import {
  ADMIN_ROUTES,
  OPERATOR_ROUTES,
  OWNER_ROUTES,
  PLAN_ROUTES,
} from "./helpers/routes.js";

/** 準則4：PLAN／附錄路由皆存在；有資料頁空狀態非空白繁中。 */

test.describe("準則4：路由存在與空狀態", () => {
  test("所有 PLAN 路由可導向且為應用殼（非靜態 404）", async ({ page }) => {
    for (const path of PLAN_ROUTES) {
      const res = await page.goto(path);
      expect(res).not.toBeNull();
      expect(res!.status()).toBeLessThan(500);
      // 實作後每頁應有應用根；佔位靜態 404 不得過關
      await expect(page.getByTestId("app-shell")).toBeVisible({ timeout: 5_000 });
      const text = await page.locator("body").innerText();
      expect(text.trim().length).toBeGreaterThan(0);
      expect(text).not.toMatch(/Error response|File not found/i);
    }
  });

  test("各角色登入後其頁有繁中空狀態", async ({ page }) => {
    await loginAs(page, "operator1", "pass-operator-1");
    for (const path of OPERATOR_ROUTES) {
      await page.goto(path);
      const empty = page.getByTestId("empty-state");
      await expect(empty).toBeVisible();
      await expect(empty).toContainText(/尚無|沒有|尚不|暫無/);
    }

    await loginAs(page, "owner1", "pass-owner-1");
    for (const path of OWNER_ROUTES) {
      await page.goto(path);
      await expect(page.getByTestId("empty-state")).toBeVisible();
      await expect(page.getByTestId("empty-state")).toContainText(
        /尚無|沒有|尚不|暫無/,
      );
    }

    await loginAs(page, "admin1", "pass-admin-1");
    for (const path of ADMIN_ROUTES) {
      await page.goto(path);
      await expect(page.getByTestId("empty-state")).toBeVisible();
      await expect(page.getByTestId("empty-state")).toContainText(
        /尚無|沒有|尚不|暫無/,
      );
    }
  });
});
