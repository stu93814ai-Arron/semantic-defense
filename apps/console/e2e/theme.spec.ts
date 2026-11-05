import { expect, test } from "@playwright/test";
import { loginAs } from "./helpers/auth.js";
import {
  clickTheme,
  cssPrimary,
  expectSwitcherIn,
  expectTheme,
  forceNordic,
  gotoLogin,
  headScriptReadsSdTheme,
  readStoredTheme,
  setStoredTheme,
} from "./helpers/theme.js";

/** DESIGN_SYSTEM §8 七項驗收（主題切換）。 */

test.describe("§8 主題切換驗收", () => {
  test("1. 無 sd.theme 時為 nordic", async ({ page }) => {
    await gotoLogin(page);
    await expectTheme(page, "nordic");
    await expect(page.getByTestId("theme-switcher").first()).toBeVisible();
  });

  test("2. 切義式立即生效、寫入 sd.theme、重整不閃北歐", async ({ page }) => {
    await gotoLogin(page);
    await clickTheme(page, "italian");
    await expectTheme(page, "italian");
    expect(await readStoredTheme(page)).toBe("italian");
    expect(await headScriptReadsSdTheme(page)).toBe(true);
    await page.reload();
    await expectTheme(page, "italian");
  });

  test("3. 亂值回 nordic", async ({ page }) => {
    await gotoLogin(page);
    await setStoredTheme(page, "garbage");
    await page.reload();
    await expectTheme(page, "nordic");
  });

  test("4. 鍵盤切換與 roving tabindex", async ({ page }) => {
    await gotoLogin(page);
    const nordic = page.getByTestId("theme-option-nordic");
    await nordic.focus();
    await expect(nordic).toHaveAttribute("tabindex", "0");
    await expect(page.getByTestId("theme-option-italian")).toHaveAttribute(
      "tabindex",
      "-1",
    );
    await page.keyboard.press("ArrowRight");
    await expectTheme(page, "italian");
    await expect(page.getByTestId("theme-option-italian")).toBeFocused();
    await page.keyboard.press("Home");
    await expectTheme(page, "nordic");
  });

  test("5. radiogroup 可及名稱與 radio 狀態", async ({ page }) => {
    await gotoLogin(page);
    const group = page.getByRole("radiogroup", { name: "介面主題" });
    await expect(group).toBeVisible();
    await expect(group.getByRole("radio", { name: /北歐/ })).toHaveAttribute(
      "aria-checked",
      "true",
    );
  });

  test("6. 切換只改 token、主色變更且殼尺寸穩定", async ({ page }) => {
    await gotoLogin(page);
    const shell = page.getByTestId("app-shell");
    const before = await shell.boundingBox();
    expect(await cssPrimary(page)).toBe("#4f6b57");
    await clickTheme(page, "italian");
    expect(await cssPrimary(page)).toBe("#a4472c");
    const after = await shell.boundingBox();
    expect(before).toBeTruthy();
    expect(after).toBeTruthy();
    expect(Math.abs((after!.width ?? 0) - (before!.width ?? 0))).toBeLessThan(2);
    expect(Math.abs((after!.height ?? 0) - (before!.height ?? 0))).toBeLessThan(2);
  });

  test("7. 登入右上、北歐側欄、義式頂欄皆可見切換器", async ({ page }) => {
    await gotoLogin(page);
    await expectSwitcherIn(page, "theme-slot-login");
    await loginAs(page, "operator1", "pass-operator-1");
    await page.goto("/judgments");
    await forceNordic(page);
    await expectSwitcherIn(page, "theme-slot-sidebar");
    await page
      .getByTestId("theme-slot-sidebar")
      .getByTestId("theme-option-italian")
      .click();
    await expectSwitcherIn(page, "theme-slot-topbar");
  });
});
