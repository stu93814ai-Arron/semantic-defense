import { useEffect, useRef, useState, type KeyboardEvent } from "react";
import {
  THEME_OPTIONS,
  applyTheme,
  readDomTheme,
  type ThemeId,
} from "./theme";
import { nextIndex } from "./roving";

/** DESIGN_SYSTEM §8 ThemeSwitch：radiogroup + roving tabindex。 */
export function ThemeSwitch() {
  const [theme, setTheme] = useState<ThemeId>(() => readDomTheme());
  const refs = useRef<(HTMLButtonElement | null)[]>([]);

  useEffect(() => {
    const onTheme = (e: Event) => {
      const t = (e as CustomEvent<ThemeId>).detail;
      if (t === "nordic" || t === "italian") setTheme(t);
    };
    window.addEventListener("sd-theme", onTheme);
    return () => window.removeEventListener("sd-theme", onTheme);
  }, []);

  function select(next: ThemeId) {
    applyTheme(next);
    setTheme(next);
  }

  function onKey(e: KeyboardEvent<HTMLButtonElement>, i: number) {
    const n = THEME_OPTIONS.length;
    if (e.key === " " || e.key === "Enter") {
      e.preventDefault();
      const opt = THEME_OPTIONS.at(i);
      if (opt) select(opt.value);
      return;
    }
    const j = nextIndex(e.key, i, n);
    if (j === null) return;
    e.preventDefault();
    const opt = THEME_OPTIONS.at(j);
    if (!opt) return;
    select(opt.value);
    refs.current.at(j)?.focus();
  }

  return (
    <div
      role="radiogroup"
      aria-label="介面主題"
      className="theme-switch"
      data-testid="theme-switcher"
    >
      {THEME_OPTIONS.map((o, i) => (
        <button
          key={o.value}
          ref={(el) => {
            if (i === 0) refs.current = [el, refs.current[1] ?? null];
            else refs.current = [refs.current[0] ?? null, el];
          }}
          type="button"
          role="radio"
          aria-checked={theme === o.value}
          tabIndex={theme === o.value ? 0 : -1}
          data-selected={theme === o.value}
          data-testid={`theme-option-${o.value}`}
          className="theme-switch__option"
          onClick={() => select(o.value)}
          onKeyDown={(e) => onKey(e, i)}
        >
          <span aria-hidden className={`dot dot--${o.value}`} />
          {o.label}
          {theme === o.value ? (
            <span className="theme-switch__check"> ✓</span>
          ) : null}
        </button>
      ))}
    </div>
  );
}
