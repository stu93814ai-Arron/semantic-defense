import { expect, test } from "@playwright/test";
import { loginAs } from "./helpers/auth.js";

/** DESIGN_SYSTEM §8 七項驗收（主題切換）。 */

test.describe("§8 主題切換驗收", () => {
  test("1. 無 sd.theme 時為 nordic", async ({ page }) => {
    await page.goto("/login");
    await expect(page.locator("html")).toHaveAttribute("data-theme", "nordic");
    await expect(page.getByTestId("theme-switcher").first()).toBeVisible();
  });

  test("2. 切義式立即生效、寫入 sd.theme、重整不閃北歐", async ({ page }) => {
    await page.goto("/login");
    await page.getByTestId("theme-option-italian").click();
    await expect(page.locator("html")).toHaveAttribute("data-theme", "italian");
    expect(await page.evaluate(() => localStorage.getItem("sd.theme"))).toBe(
      "italian",
    );

    // 重新導向：在 document 解析後、React 前讀 data-theme（防 FOUC 腳本）
    const themeAtCommit = await page.evaluate(async () => {
      const res = await fetch("/login");
      const html = await res.text();
      // 確認 head 內嵌腳本存在
      return /localStorage\.getItem\(['"]sd\.theme['"]\)/.test(html);
    });
    expect(themeAtCommit).toBe(true);

    await page.reload();
    // 首屏屬性應已是 italian（inline script）
    await expect(page.locator("html")).toHaveAttribute("data-theme", "italian");
  });

  test("3. 亂值回 nordic", async ({ page }) => {
    await page.goto("/login");
    await page.evaluate(() => localStorage.setItem("sd.theme", "garbage"));
    await page.reload();
    await expect(page.locator("html")).toHaveAttribute("data-theme", "nordic");
  });

  test("4. 鍵盤切換與 roving tabindex", async ({ page }) => {
    await page.goto("/login");
    const nordic = page.getByTestId("theme-option-nordic");
    await nordic.focus();
    await expect(nordic).toHaveAttribute("tabindex", "0");
    await expect(page.getByTestId("theme-option-italian")).toHaveAttribute(
      "tabindex",
      "-1",
    );
    await page.keyboard.press("ArrowRight");
    await expect(page.locator("html")).toHaveAttribute("data-theme", "italian");
    await expect(page.getByTestId("theme-option-italian")).toBeFocused();
    await page.keyboard.press("Home");
    await expect(page.locator("html")).toHaveAttribute("data-theme", "nordic");
  });

  test("5. radiogroup 可及名稱與 radio 狀態", async ({ page }) => {
    await page.goto("/login");
    const group = page.getByRole("radiogroup", { name: "介面主題" });
    await expect(group).toBeVisible();
    await expect(group.getByRole("radio", { name: /北歐/ })).toHaveAttribute(
      "aria-checked",
      "true",
    );
  });

  test("6. 切換只改 token、主色變更且殼尺寸穩定", async ({ page }) => {
    await page.goto("/login");
    const shell = page.getByTestId("app-shell");
    const before = await shell.boundingBox();
    const primaryBefore = await page.evaluate(() =>
      getComputedStyle(document.documentElement)
        .getPropertyValue("--color-primary")
        .trim()
        .toLowerCase(),
    );
    expect(primaryBefore).toBe("#4f6b57");
    await page.getByTestId("theme-option-italian").click();
    const primaryAfter = await page.evaluate(() =>
      getComputedStyle(document.documentElement)
        .getPropertyValue("--color-primary")
        .trim()
        .toLowerCase(),
    );
    expect(primaryAfter).toBe("#a4472c");
    const after = await shell.boundingBox();
    expect(before).toBeTruthy();
    expect(after).toBeTruthy();
    expect(Math.abs((after!.width ?? 0) - (before!.width ?? 0))).toBeLessThan(2);
    expect(Math.abs((after!.height ?? 0) - (before!.height ?? 0))).toBeLessThan(2);
  });

  test("7. 登入右上、北歐側欄、義式頂欄皆可見切換器", async ({ page }) => {
    await page.goto("/login");
    await expect(page.getByTestId("theme-slot-login")).toBeVisible();
    await expect(
      page.getByTestId("theme-slot-login").getByTestId("theme-switcher"),
    ).toBeVisible();

    await loginAs(page, "operator1", "pass-operator-1");
    await page.goto("/judgments");
    await page.evaluate(() => {
      localStorage.setItem("sd.theme", "nordic");
      document.documentElement.dataset.theme = "nordic";
      window.dispatchEvent(new CustomEvent("sd-theme", { detail: "nordic" }));
    });
    await expect(page.getByTestId("theme-slot-sidebar")).toBeVisible();
    await expect(
      page.getByTestId("theme-slot-sidebar").getByTestId("theme-switcher"),
    ).toBeVisible();

    await page.getByTestId("theme-slot-sidebar").getByTestId("theme-option-italian").click();
    await expect(page.getByTestId("theme-slot-topbar")).toBeVisible();
    await expect(
      page.getByTestId("theme-slot-topbar").getByTestId("theme-switcher"),
    ).toBeVisible();
  });
});
