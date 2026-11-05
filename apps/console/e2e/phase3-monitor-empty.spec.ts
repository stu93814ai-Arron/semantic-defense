import { expect, test } from "@playwright/test";
import { loginAs } from "./helpers/auth.js";

/**
 * 第 3 階段監看模式空狀態（B 組；不改動驗收測試師的 routes.ts／routes-empty-states）。
 * 路由鎖定：/blacklist/review、/blacklist、/whitelist、/mode。
 */
test.describe("第 3 階段：黑白名單／模式空狀態", () => {
  test("值班：審核與撤回頁為繁中空狀態", async ({ page }) => {
    await loginAs(page, "operator1", "pass-operator-1");
    for (const path of ["/blacklist/review", "/blacklist"]) {
      await page.goto(path);
      await expect(page.getByTestId("no-permission")).toHaveCount(0);
      const empty = page.getByTestId("empty-state");
      await expect(empty).toBeVisible();
      await expect(empty).toContainText(/尚無|沒有|尚不|暫無/);
    }
  });

  test("平台管理員：白名單與模式頁為繁中空狀態", async ({ page }) => {
    await loginAs(page, "admin1", "pass-admin-1");
    for (const path of ["/whitelist", "/mode"]) {
      await page.goto(path);
      await expect(page.getByTestId("no-permission")).toHaveCount(0);
      const empty = page.getByTestId("empty-state");
      await expect(empty).toBeVisible();
      await expect(empty).toContainText(/尚無|沒有|尚不|暫無/);
    }
  });
});
