export type ThemeId = "nordic" | "italian";

export const DEFAULT_THEME: ThemeId = "nordic";
/** DESIGN_SYSTEM §8 — localStorage 鍵名 */
export const THEME_STORAGE_KEY = "sd.theme";

export const THEME_OPTIONS: { value: ThemeId; label: string }[] = [
  { value: "nordic", label: "北歐" },
  { value: "italian", label: "義式" },
];

export function parseTheme(raw: string | null | undefined): ThemeId {
  return raw === "italian" || raw === "nordic" ? raw : "nordic";
}

export function readStoredTheme(): ThemeId {
  try {
    return parseTheme(localStorage.getItem(THEME_STORAGE_KEY));
  } catch {
    return DEFAULT_THEME;
  }
}

export function readDomTheme(): ThemeId {
  return parseTheme(document.documentElement.dataset.theme);
}

export function applyTheme(theme: ThemeId): void {
  document.documentElement.dataset.theme = theme;
  try {
    localStorage.setItem(THEME_STORAGE_KEY, theme);
  } catch {
    /* private mode */
  }
  window.dispatchEvent(new CustomEvent("sd-theme", { detail: theme }));
}

export function initTheme(): ThemeId {
  const theme = readStoredTheme();
  applyTheme(theme);
  return theme;
}
