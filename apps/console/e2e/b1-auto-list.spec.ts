import { expect, test, type Page } from "@playwright/test";
import { loginAs } from "./helpers/auth.js";
import {
  HANDSHAKE_BLOCKED,
  PLUGIN_NOT_FOUND,
  installAutoListMock,
} from "./helpers/auto-list.js";

/**
 * B1（PR #73）：/whitelist 自動上榜開關。
 * data-testid=auto-list 是容器；role=switch 是其內按鈕；狀態是 auto-list-state
 * （apps/console/src/review/AutoListSwitch.tsx）。
 * /whitelist 僅 platform_admin（roles.ts）；operator／app_owner 進此路徑為無權限頁，頁面不掛載。
 */

async function openWhitelist(page: Page, username: string, password: string): Promise<void> {
  await loginAs(page, username, password);
  await page.goto("/whitelist");
}

async function adminReadsBackend(page: Page): Promise<void> {
  const mock = await installAutoListMock(page);
  await openWhitelist(page, "admin1", "pass-admin-1");
  const block = page.getByTestId("judgment-settings");
  const widget = block.getByTestId("auto-list");
  const sw = widget.getByRole("switch");
  const state = widget.getByTestId("auto-list-state");
  await expect(block.getByRole("heading", { level: 2, name: "判定設定" })).toBeVisible();
  await expect(sw).toBeVisible();
  await expect(state).toHaveText("已關閉");
  await expect(sw).toHaveAttribute("aria-checked", "false");
  const firstGets = mock.gets;
  expect(firstGets).toBeGreaterThan(0);
  await page.reload();
  await expect(state).toHaveText("已關閉");
  expect(mock.gets).toBeGreaterThan(firstGets);
  mock.setEnabled(true);
  const beforeOn = mock.gets;
  await page.reload();
  await expect(state).toHaveText("已開啟");
  await expect(widget.getByRole("switch")).toHaveAttribute("aria-checked", "true");
  expect(mock.gets).toBeGreaterThan(beforeOn);
}

async function hiddenFromNonAdmin(page: Page): Promise<void> {
  const mock = await installAutoListMock(page);
  const users = [
    ["operator1", "pass-operator-1"],
    ["owner1", "pass-owner-1"],
  ] as const;
  for (const [username, password] of users) {
    await page.context().clearCookies();
    await openWhitelist(page, username, password);
    await expect(page.getByTestId("no-permission")).toBeVisible();
    await expect(page.getByTestId("judgment-settings")).toHaveCount(0);
    await expect(page.getByTestId("auto-list")).toHaveCount(0);
    await expect(page.getByRole("switch")).toHaveCount(0);
  }
  expect(mock.gets).toBe(0);
  expect(mock.puts).toEqual([]);
}

async function enableNeedsConfirm(page: Page): Promise<void> {
  const mock = await installAutoListMock(page);
  await openWhitelist(page, "admin1", "pass-admin-1");
  const sw = page.getByTestId("auto-list").getByRole("switch");
  await sw.click();
  const dialog = page.getByRole("alertdialog");
  await expect(dialog).toBeVisible();
  await expect(page.getByRole("button", { name: "取消" })).toBeFocused();
  await page.keyboard.press("Escape");
  await expect(dialog).toHaveCount(0);
  expect(mock.puts).toEqual([]);
  await sw.click();
  await page.getByRole("button", { name: "確認開啟" }).click();
  await expect(page.getByTestId("auto-list-write-error")).toHaveText(HANDSHAKE_BLOCKED);
  await expect(page.getByTestId("auto-list-state")).toHaveText("已關閉");
  await expect(sw).toHaveAttribute("aria-checked", "false");
  await expect(page.getByRole("alertdialog")).toHaveCount(0);
  expect(mock.puts).toEqual([{ enabled: true }]);
  expect(mock.blacklistWrites).toEqual([]);
}

async function disableWithoutConfirm(page: Page): Promise<void> {
  const mock = await installAutoListMock(page, { enabled: true });
  await openWhitelist(page, "admin1", "pass-admin-1");
  const sw = page.getByTestId("auto-list").getByRole("switch");
  await expect(page.getByTestId("auto-list-state")).toHaveText("已開啟");
  await sw.click();
  await expect(page.getByRole("alertdialog")).toHaveCount(0);
  await expect(page.getByTestId("auto-list-state")).toHaveText("已關閉");
  await expect(sw).toHaveAttribute("aria-checked", "false");
  await expect(page.getByTestId("auto-list-write-error")).toHaveCount(0);
  expect(mock.puts).toEqual([{ enabled: false }]);
  expect(mock.blacklistWrites).toEqual([]);
}

async function readFailure(page: Page): Promise<void> {
  const mock = await installAutoListMock(page, { failRead: true });
  await openWhitelist(page, "admin1", "pass-admin-1");
  const err = page.getByTestId("judgment-settings").getByTestId("auto-list-read-error");
  await expect(err).toBeVisible();
  await expect(err).toHaveText(PLUGIN_NOT_FOUND);
  await expect(page.getByTestId("auto-list-state")).toHaveCount(0);
  await expect(page.getByTestId("auto-list").getByRole("switch")).toHaveCount(0);
  expect(mock.gets).toBeGreaterThan(0);
  expect(mock.puts).toEqual([]);
}

test.describe("B1：/whitelist 自動上榜開關", () => {
  test("platform_admin：判定設定內的開關顯示 GET 值，重新載入仍以後端為準", async ({ page }) => {
    await adminReadsBackend(page);
  });

  test("operator 與 app_owner 不渲染區塊與開關，且不送 GET", async ({ page }) => {
    await hiddenFromNonAdmin(page);
  });

  test("開啟要確認：取消取得焦點，Esc 不 PUT；確認得 409 且維持關閉、不寫黑名單", async ({ page }) => {
    await enableNeedsConfirm(page);
  });

  test("關閉不需確認且成功", async ({ page }) => {
    await disableWithoutConfirm(page);
  });

  test("讀取失敗顯示 auto-list-read-error", async ({ page }) => {
    await readFailure(page);
  });
});
