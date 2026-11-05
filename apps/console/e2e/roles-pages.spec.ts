import { expect, test } from "@playwright/test";
import { loginAs } from "./helpers/auth.js";
import {
  ADMIN_ROUTES,
  OPERATOR_ROUTES,
  OWNER_ROUTES,
} from "./helpers/routes.js";

/** 準則1＋5：三角色只進自己的頁；越權見無權限。 */

test.describe("準則1／5：角色頁面隔離與無權限", () => {
  test("operator 可見值勤頁，越權為無權限", async ({ page }) => {
    await loginAs(page, "operator1", "pass-operator-1");
    for (const path of OPERATOR_ROUTES) {
      await page.goto(path);
      await expect(page.getByTestId("no-permission")).toHaveCount(0);
      await expect(page.locator("body")).not.toBeEmpty();
    }
    for (const path of [...OWNER_ROUTES, ...ADMIN_ROUTES]) {
      await page.goto(path);
      await expect(page.getByTestId("no-permission")).toBeVisible();
      await expect(page.getByTestId("no-permission")).toContainText(/無權限/);
    }
  });

  test("app_owner 可見應用頁，越權為無權限", async ({ page }) => {
    await loginAs(page, "owner1", "pass-owner-1");
    for (const path of OWNER_ROUTES) {
      await page.goto(path);
      await expect(page.getByTestId("no-permission")).toHaveCount(0);
    }
    for (const path of [...OPERATOR_ROUTES, ...ADMIN_ROUTES]) {
      await page.goto(path);
      await expect(page.getByTestId("no-permission")).toBeVisible();
    }
  });

  test("platform_admin 可見管理頁，越權為無權限", async ({ page }) => {
    await loginAs(page, "admin1", "pass-admin-1");
    for (const path of ADMIN_ROUTES) {
      await page.goto(path);
      await expect(page.getByTestId("no-permission")).toHaveCount(0);
    }
    for (const path of [...OPERATOR_ROUTES, ...OWNER_ROUTES]) {
      await page.goto(path);
      await expect(page.getByTestId("no-permission")).toBeVisible();
    }
  });
});
