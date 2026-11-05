import type { Page } from "@playwright/test";

export async function loginAs(
  page: Page,
  username: string,
  password: string,
): Promise<void> {
  await page.goto("/login");
  await page.getByTestId("login-username").fill(username, { timeout: 5_000 });
  await page.getByTestId("login-password").fill(password, { timeout: 5_000 });
  await page.getByTestId("login-submit").click({ timeout: 5_000 });
}
