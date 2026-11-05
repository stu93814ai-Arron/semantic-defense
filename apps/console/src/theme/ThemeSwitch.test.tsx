import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { ThemeSwitch } from "./ThemeSwitch";
import { applyTheme, THEME_STORAGE_KEY } from "./theme";

describe("ThemeSwitch (§8 驗收 4／5)", () => {
  beforeEach(() => {
    localStorage.clear();
    document.documentElement.dataset.theme = "nordic";
  });

  afterEach(() => {
    cleanup();
    localStorage.clear();
  });

  it("4. radiogroup／radio／aria-checked／roving tabindex；方向鍵切換", async () => {
    const user = userEvent.setup();
    render(<ThemeSwitch />);
    const group = screen.getByRole("radiogroup", { name: "介面主題" });
    expect(group).toBeTruthy();
    const nordic = screen.getByTestId("theme-option-nordic");
    const italian = screen.getByTestId("theme-option-italian");
    expect(nordic.getAttribute("role")).toBe("radio");
    expect(nordic.getAttribute("aria-checked")).toBe("true");
    expect(nordic.tabIndex).toBe(0);
    expect(italian.getAttribute("aria-checked")).toBe("false");
    expect(italian.tabIndex).toBe(-1);

    nordic.focus();
    await user.keyboard("{ArrowRight}");
    expect(document.documentElement.dataset.theme).toBe("italian");
    expect(localStorage.getItem(THEME_STORAGE_KEY)).toBe("italian");
    expect(italian.getAttribute("aria-checked")).toBe("true");
    expect(italian.tabIndex).toBe(0);
    expect(nordic.tabIndex).toBe(-1);
    expect(document.activeElement).toBe(italian);

    await user.keyboard("{Home}");
    expect(document.documentElement.dataset.theme).toBe("nordic");
    expect(document.activeElement).toBe(nordic);

    await user.keyboard("{End}");
    expect(document.documentElement.dataset.theme).toBe("italian");
  });

  it("5. 報讀：radiogroup 名為介面主題，選中 radio aria-checked", () => {
    applyTheme("nordic");
    render(<ThemeSwitch />);
    const group = screen.getByRole("radiogroup", { name: "介面主題" });
    const checked = group.querySelector('[aria-checked="true"]');
    expect(checked?.textContent).toMatch(/北歐/);
    expect(group.querySelectorAll('[role="radio"]')).toHaveLength(2);
  });
});
