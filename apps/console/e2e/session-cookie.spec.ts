import { expect, test } from "@playwright/test";
import { loginAs } from "./helpers/auth.js";

/** 準則3：document.cookie 讀不到工作階段；閒置後须重新登入。 */

test.describe("準則3：前端讀不到 session、逾時重登", () => {
  test("登入後 document.cookie 不含 sd_session；cookie 為 httpOnly", async ({
    page,
    context,
  }) => {
    await loginAs(page, "operator1", "pass-operator-1");
    await page.waitForURL((url) => !url.pathname.includes("/login"));
    const visible = await page.evaluate(() => document.cookie);
    expect(visible).not.toMatch(/sd_session/i);
    const cookies = await context.cookies();
    const session = cookies.find((c) => c.name === "sd_session");
    expect(session).toBeTruthy();
    expect(session?.httpOnly).toBe(true);
    expect(session?.secure).toBe(true);
    expect(String(session?.sameSite).toLowerCase()).toMatch(/strict/);
  });

  test("閒置逾時後進入受保護頁會回到登入", async ({ page }) => {
    // 實作須讓測試環境可縮短 idle（例如 VITE_IDLE_TIMEOUT_MS）；此處等待後驗證須重登
    await loginAs(page, "operator1", "pass-operator-1");
    await page.waitForTimeout(100);
    // 觸發「已逾時」：實作在短 idle 測試組態下應失效；測試會再導向受保護頁
    await page.goto("/judgments");
    // 若已實作短逾時環境變數則應在 /login；未實作時本測為紅
    await expect(page).toHaveURL(/\/login/);
  });
});
