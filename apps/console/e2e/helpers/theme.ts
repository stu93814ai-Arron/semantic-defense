import { expect, type Page } from "@playwright/test";

export async function gotoLogin(page: Page): Promise<void> {
  await page.goto("/login");
}

export async function expectTheme(page: Page, theme: "nordic" | "italian"): Promise<void> {
  await expect(page.locator("html")).toHaveAttribute("data-theme", theme);
}

export async function clickTheme(
  page: Page,
  theme: "nordic" | "italian",
): Promise<void> {
  await page.getByTestId(`theme-option-${theme}`).click();
}

export async function readStoredTheme(page: Page): Promise<string | null> {
  return page.evaluate(() => localStorage.getItem("sd.theme"));
}

export async function setStoredTheme(page: Page, value: string): Promise<void> {
  await page.evaluate((v) => localStorage.setItem("sd.theme", v), value);
}

/** 確認 index.html head 內嵌防閃爍腳本仍讀 sd.theme。 */
export async function headScriptReadsSdTheme(page: Page): Promise<boolean> {
  return page.evaluate(async () => {
    const res = await fetch("/login");
    const html = await res.text();
    return /localStorage\.getItem\(['"]sd\.theme['"]\)/.test(html);
  });
}

export async function cssPrimary(page: Page): Promise<string> {
  return page.evaluate(() =>
    getComputedStyle(document.documentElement)
      .getPropertyValue("--color-primary")
      .trim()
      .toLowerCase(),
  );
}

export async function forceNordic(page: Page): Promise<void> {
  await page.evaluate(() => {
    localStorage.setItem("sd.theme", "nordic");
    document.documentElement.dataset.theme = "nordic";
    window.dispatchEvent(new CustomEvent("sd-theme", { detail: "nordic" }));
  });
}

export async function expectSwitcherIn(
  page: Page,
  slotTestId: string,
): Promise<void> {
  const slot = page.getByTestId(slotTestId);
  await expect(slot).toBeVisible();
  await expect(slot.getByTestId("theme-switcher")).toBeVisible();
}
