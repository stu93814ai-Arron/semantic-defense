import { expect, test } from "@playwright/test";

/** 準則6：連續登入失敗受限；錯誤不枚舉帳號。 */

test.describe("準則6：登入失敗 UI", () => {
  test("未知帳號與錯密碼顯示相同錯誤文案", async ({ page }) => {
    await page.goto("/login");
    await page.getByTestId("login-username").fill("no-such-user");
    await page.getByTestId("login-password").fill("x");
    await page.getByTestId("login-submit").click();
    const err1 = page.getByTestId("login-error");
    await expect(err1).toBeVisible();
    const t1 = await err1.innerText();
    expect(t1).toContain("帳號或密碼錯誤");

    await page.getByTestId("login-username").fill("operator1");
    await page.getByTestId("login-password").fill("wrong");
    await page.getByTestId("login-submit").click();
    const err2 = page.getByTestId("login-error");
    await expect(err2).toBeVisible();
    expect(await err2.innerText()).toBe(t1);
  });

  test("連續失敗後出現速率限制提示且不揭露帳號存在", async ({ page }) => {
    await page.goto("/login");
    for (let i = 0; i < 6; i += 1) {
      await page.getByTestId("login-username").fill("operator1");
      await page.getByTestId("login-password").fill("bad");
      await page.getByTestId("login-submit").click();
      await page.getByTestId("login-error").waitFor({ state: "visible" });
    }
    const text = await page.getByTestId("login-error").innerText();
    expect(text).toMatch(/稍後|次數|限制|太多次/);
    expect(text).not.toMatch(/不存在|未註冊/);
  });
});
