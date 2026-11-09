import { expect, test } from "@playwright/test";
import { loginAs } from "./helpers/auth.js";

/**
 * PLAN-ADDENDUM-MONITOR.md §8 第 3 階段 B 組：
 * 白名單頁可新增／刪除 IP 或 CIDR，格式錯誤擋下。
 * 路徑見 §7a：/whitelist（platform_admin）。
 * 選取器以畫面可見繁中標籤為準（不依賴未入 PLAN 的 testid）。
 */
test.describe("第 3 階段：白名單新增／刪除與格式", () => {
  test("平台管理員：格式錯誤擋下；合法 CIDR 可新增再刪除", async ({ page }) => {
    await loginAs(page, "admin1", "pass-admin-1");
    await page.goto("/whitelist");
    await expect(page.getByTestId("no-permission")).toHaveCount(0);
    await expect(page.getByRole("heading", { name: "白名單" })).toBeVisible();

    const cidr = page.getByLabel("IP 或 CIDR");
    const reason = page.getByLabel("理由");
    const add = page.getByRole("button", { name: "新增" });

    await cidr.fill("10.0.0.0/7");
    await reason.fill("過寬網段");
    await add.click();
    await expect(page.getByText(/格式不符|請輸入/)).toBeVisible();
    await expect(page.getByTestId("empty-state")).toBeVisible();

    await cidr.fill("203.0.113.0/24");
    await reason.fill("夥伴出口");
    await add.click();
    await expect(page.getByTestId("empty-state")).toHaveCount(0);
    await expect(page.getByText("203.0.113.0/24")).toBeVisible();
    await expect(page.getByText(/夥伴出口/)).toBeVisible();

    await page.getByRole("button", { name: "刪除" }).click();
    await expect(page.getByTestId("empty-state")).toBeVisible();
    await expect(page.getByTestId("empty-state")).toContainText(/尚無|沒有|尚不|暫無/);
  });
});
