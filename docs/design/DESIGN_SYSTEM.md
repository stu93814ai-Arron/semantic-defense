# 應用語意防禦 設計規範（Design System）v1.0 — 已定案

> **版本 v1.0（2026-11-05 定案）**：預設主題 **D 北歐溫潤**（`<html data-theme="nordic">`），使用者可切換為 **E 義式極簡**（`data-theme="italian"`）。A／B／C 已否決（見附錄）。
> v1.0 調色：橡木漸層由 #C9A57A→#B88F62 調亮為 **#D2B288→#C6A072**，橡木上的字標由 #3D3226 改為 **#33291F**（原組合疊木紋後僅 3.88:1，未達 AA）。新增 tokens `--color-wood-from`、`--color-wood-to`、`--color-on-wood`、`--color-on-wood-muted`。
> 2026-11-09：新增第 10 節 `/apps/new` 狀態規格（不改 v1.0 tokens）。
> 視覺稿：`direction-d-*.png`、`direction-e-*.png`；HTML／產生腳本：`mockups/gen_de.py`；對比表：`mockups/contrast.md`；B 組交接：`HANDOFF_B.md`。

## 1. 設計理念
- **D 北歐溫潤**：亞麻底、燕麥卡片、橡木側欄、鼠尾草綠主色；大圓角與膠囊按鈕，像溫暖的木質書房。
- **E 義式極簡**：大理石白底（淡紋理）、細線、零圓角、赤陶主色、置中寬留白，像精品店展間。
- 兩者共同：大量留白（頁面左右邊距 72–96px、卡片內距 32px）、襯線標題、無工程／控制台元素（不用霓虹、等寬大字、密集格線）。

## 2. 顏色 tokens
| Token | D 北歐溫潤 | E 義式極簡 | 用途 |
|---|---|---|---|
| `--color-bg` | #F4EFE6 亞麻 | #FAF8F5 大理石白 | 頁底 |
| `--color-surface` | #FBF8F2 | #FFFFFF | 卡片 |
| `--color-surface-2` | #ECE4D6 燕麥 | #F1EDE8 石灰 | 次層、停用按鈕 |
| `--color-border` | #D9CDB8 | #E2DCD4 | 細線 |
| `--color-text` | #2E2A24 | #1E1C1A | 主要文字 |
| `--color-text-muted` | #5F574B | #5E5751 | 次要文字 |
| `--color-primary` | #4F6B57 鼠尾草綠 | #A4472C 赤陶 | 主要動作、focus |
| `--color-danger` | #9E3B2C 磚紅 | #A3262A 酒紅 | 高風險、衝突、退回 |
| `--color-warning` | #8A5A12 焦糖 | #87570F 琥珀 | 逾時、入口異常 |
| `--color-success` | #3F6B4A | #3B6B52 | 建議就緒 |
| `--color-info` | #3E5F78 霧藍 | #3B5675 石板藍 | 撰寫中 |
| `--color-neutral` | #6B6358 | #6A635D | 已到期、已撤回、停用 |

語意色皆為「柔和但深」的色階：標籤用 10–12% 同色調淡底＋原色字，橫幅用 1px 原色框＋7–8% 淡底＋襯線粗體標題，狀態另以文字說明（不只靠顏色）。E 的主色赤陶與危險酒紅色相相近，因此危險一律加「高風險／已由他人核准」文字與外框，主色只用於實心按鈕。

## 3. 字型
```css
--font-serif-d: "Cormorant Garamond", "Noto Serif TC", "Noto Serif CJK TC", "Source Han Serif TC", serif; /* D 標題 */
--font-serif-e: "Playfair Display", "Noto Serif TC", "Noto Serif CJK TC", "Source Han Serif TC", serif;  /* E 標題 */
--font-sans: "Noto Sans TC", "Noto Sans CJK TC", "PingFang TC", "Microsoft JhengHei", sans-serif;      /* 內文 */
```
- 拉丁襯線放在堆疊最前，數字與英文用 Garamond／Playfair，中文自動落到思源宋體。
- 尺度：12（眉標，字距 .3em 大寫）/ 13 / 15（內文，行高 1.75）/ 18（橫幅標題）/ 22（建議內容）/ 40（頁標）/ 96（倒數秒數）。
- 標題字重：D 600、E 500（E 更纖細）。倒數用 `font-variant-numeric: lining-nums tabular-nums`，避免 Garamond 舊式數字跳動。
- 字型以 `@fontsource/noto-serif-tc`、`@fontsource/cormorant-garamond`、`@fontsource/playfair-display` 自帶，不依賴使用者電腦。

## 4. 間距、圓角、陰影、材質
- 間距 4 為基數：4, 8, 12, 16, 24, 32, 40, 56, 72, 96。
- 圓角：D 卡片 18px、控制項膠囊 999px；E 一律 0。
- 陰影：不用陰影，以 1px 細線和底色分層（E 可用 `0 1px 0 var(--color-border)`）。
- **材質紋理做法（純 CSS，無圖檔、不影響效能）**：
  - D 亞麻：`radial-gradient(rgba(120,95,60,.05) 1px, transparent 1px) 0 0/5px 5px` 疊 `repeating-linear-gradient(90deg, rgba(150,110,60,.025) 0 2px, transparent 2px 7px)`。
  - D 橡木（側欄、登入左半）：`linear-gradient(180deg,#D2B288,#C6A072)` 疊 `repeating-linear-gradient(92deg, rgba(90,60,30,.08) 0 3px, transparent 3px 19px)`。
  - E 大理石：兩道斜向極淡 `linear-gradient(115deg/28deg, …rgba(160,150,140,.07)…)` 模擬石紋。
  - 紋理只放在 `body` 與側欄，卡片保持素面以確保文字對比；`prefers-contrast: more` 時移除紋理。

## 5. 元件
- **按鈕**：主要（primary 實心＋白字）、退回（danger 1px 外框）、停用（surface-2 底＋neutral 字＋`aria-disabled`）。高 48px、左右 32px、字距 .1em。
- **標籤**：D 膠囊、E 方形；淡底＋同色字。
- **卡片**：surface＋1px border＋32px 內距。
- **表格列**：列高 ~72px、只有底線、案件編號用襯線、整列可點與 Tab/Enter。
- **倒數計時**：襯線 96px 秒數＋4px 細進度線＋狀態標籤。0–4 秒 info、4–7 秒 warning、>7 秒轉逾時；`aria-live="polite"` 只在狀態轉換時朗讀。
- **提示橫幅**：1px 語意色框＋淡底＋襯線粗體標題＋一句說明。
- **對話框**：核准前確認「將簽名並送往入口執行」；D 圓角 18、E 直角，焦點鎖定、Esc 關閉。

## 6. 狀態樣式
| 狀態 | 呈現 |
|---|---|
| 載入 | surface-2 骨架（`prefers-reduced-motion` 時靜止） |
| 空 | 襯線一句「目前沒有待判斷案件，入口運作正常。」＋大量留白 |
| 錯誤／入口連不上 | warning 橫幅「入口連線中斷」＋重試 |
| 無權限 | 整頁中性訊息，不回空白 |
| 逾時（>7 秒） | warning 橫幅、倒數變 warning、核准停用、保留「手動退回」 |
| 兩人同時核准 | danger 橫幅「已由他人核准，你的核准未寫入」、按鈕全停用、顯示生效版本 |
| 已到期／已撤回 | neutral 橫幅、唯讀、按鈕全停用 |
| 停用 | surface-2 底＋neutral 字（對比仍 ≥ 4.5） |
| focus | `outline: 2px solid var(--color-primary); outline-offset: 3px`（`:focus-visible`） |

## 7. 落地給 React（CSS 變數）
命名：`--{color|font|text|space|radius}-{角色}[-{變體}]`，語意命名不用色名；元件只引用 token。以 `<html data-theme="nordic|italian">` 切換。

```css
/* src/styles/tokens.css — 在 main.tsx 匯入一次 */
:root, [data-theme="nordic"] {
  --color-bg:#F4EFE6; --color-surface:#FBF8F2; --color-surface-2:#ECE4D6; --color-border:#D9CDB8;
  --color-text:#2E2A24; --color-text-muted:#5F574B; --color-primary:#4F6B57; --color-on-primary:#FFFFFF;
  --color-danger:#9E3B2C; --color-warning:#8A5A12; --color-success:#3F6B4A; --color-info:#3E5F78; --color-neutral:#6B6358;
  --radius-md:18px; --radius-control:999px;
  --font-serif:"Cormorant Garamond","Noto Serif CJK TC","Noto Serif TC",serif;
}
[data-theme="italian"] {
  --color-bg:#FAF8F5; --color-surface:#FFFFFF; --color-surface-2:#F1EDE8; --color-border:#E2DCD4;
  --color-text:#1E1C1A; --color-text-muted:#5E5751; --color-primary:#A4472C; --color-on-primary:#FFFFFF;
  --color-danger:#A3262A; --color-warning:#87570F; --color-success:#3B6B52; --color-info:#3B5675; --color-neutral:#6A635D;
  --radius-md:0px; --radius-control:0;
  --font-serif:"Playfair Display","Noto Serif CJK TC","Noto Serif TC",serif;
}
:root, [data-theme="nordic"] {
  --color-wood-from:#D2B288; --color-wood-to:#C6A072; --color-on-wood:#2E2A24; --color-on-wood-muted:#33291F;
  --texture-wood: repeating-linear-gradient(92deg, rgba(90,60,30,.08) 0 3px, transparent 3px 19px);
}
[data-theme="italian"] { --color-wood-from:#1E1C1A; --color-wood-to:#1E1C1A; --color-on-wood:#FFFFFF; --color-on-wood-muted:#E2DCD4; --texture-wood:none; }
:root { --font-sans:"Noto Sans TC","Noto Sans CJK TC","PingFang TC","Microsoft JhengHei",sans-serif; }
:focus-visible { outline:2px solid var(--color-primary); outline-offset:3px; }
.tag[data-tone="danger"] { color:var(--color-danger); background:color-mix(in srgb,var(--color-danger) 10%,var(--color-surface)); }
```
```tsx
<Banner tone="warning" title="已超過七秒">仍未取得 AI 建議。</Banner>
<section className="judgment-card" data-state="conflict">…</section>
```

## 8. 主題切換元件（ThemeSwitch）
- **位置**：D 放在側欄底部、使用者名稱上方；E 放在頂部導覽列最右側、使用者名稱左邊。登入頁右上角也放一個（登入前就能切換）。
- **外觀**：兩段式分段控制（segmented control），標籤「北歐」「義式」，前面各加一個小色點（鼠尾草綠／赤陶）。高 36px；D 用膠囊外框，E 用直角 1px 細線。選中段：surface 底＋text 色＋字重 700；未選段：透明底＋text-muted。不只靠顏色區分，選中段另有 ✓ 或底線。
- **兩種狀態**：`nordic`（預設、選「北歐」）／`italian`（選「義式」）。
- **語意與 aria**：用 `role="radiogroup"`，`aria-label="介面主題"`；每段 `role="radio"`、`aria-checked`。採 roving tabindex：選中段 `tabIndex=0`、其餘 `-1`。
- **鍵盤**：Tab 進出整組；←／→（及 ↑／↓）切換並立即套用；Home／End 跳到第一／最後；Space／Enter 選取聚焦段。focus 用全域 `:focus-visible` 樣式。
- **儲存**：`localStorage` 鍵名 **`sd.theme`**，值只接受 `"nordic"` 或 `"italian"`；其他值或讀取失敗（例如無痕模式）一律回到 `nordic`。不讀 `prefers-color-scheme`（兩個主題都是淺色系）。
- **初始化避免閃爍**：在 `index.html` 的 `<head>`、CSS 之前放同步內嵌腳本，先在 `<html>` 設好 `data-theme`；HTML 本身預設寫 `<html lang="zh-Hant" data-theme="nordic">`，所以腳本失效時也是北歐。

```html
<!-- index.html <head> 最前面 -->
<script>
  (function(){try{var t=localStorage.getItem('sd.theme');
    document.documentElement.dataset.theme=(t==='italian'||t==='nordic')?t:'nordic';
  }catch(e){document.documentElement.dataset.theme='nordic';}})();
</script>
```

```tsx
// ThemeSwitch.tsx（僅為規格範例，不在專案中）
import { useState, useRef, KeyboardEvent } from 'react';
type Theme = 'nordic' | 'italian';
const OPTIONS: { value: Theme; label: string }[] = [
  { value: 'nordic', label: '北歐' }, { value: 'italian', label: '義式' },
];
const KEY = 'sd.theme';
function read(): Theme {
  const t = document.documentElement.dataset.theme;
  return t === 'italian' ? 'italian' : 'nordic';
}
export function ThemeSwitch() {
  const [theme, setTheme] = useState<Theme>(read);
  const refs = useRef<(HTMLButtonElement | null)[]>([]);
  const apply = (t: Theme) => {
    document.documentElement.dataset.theme = t;
    try { localStorage.setItem(KEY, t); } catch {}
    setTheme(t);
  };
  const onKey = (e: KeyboardEvent, i: number) => {
    const n = OPTIONS.length;
    const next = { ArrowRight: i + 1, ArrowDown: i + 1, ArrowLeft: i - 1, ArrowUp: i - 1, Home: 0, End: n - 1 }[e.key];
    if (next === undefined) return;
    e.preventDefault();
    const j = (next + n) % n;
    apply(OPTIONS[j].value);
    refs.current[j]?.focus();
  };
  return (
    <div role="radiogroup" aria-label="介面主題" className="theme-switch">
      {OPTIONS.map((o, i) => (
        <button key={o.value} ref={el => (refs.current[i] = el)} type="button" role="radio"
          aria-checked={theme === o.value} tabIndex={theme === o.value ? 0 : -1}
          onClick={() => apply(o.value)} onKeyDown={e => onKey(e, i)}
          className="theme-switch__option" data-selected={theme === o.value}>
          <span aria-hidden className={`dot dot--${o.value}`} />{o.label}
        </button>
      ))}
    </div>
  );
}
```
```css
.theme-switch{display:inline-flex;border:1px solid var(--color-border);border-radius:var(--radius-control);padding:2px}
.theme-switch__option{height:32px;padding:0 14px;border:0;background:transparent;color:var(--color-text-muted);border-radius:var(--radius-control);font:inherit}
.theme-switch__option[data-selected="true"]{background:var(--color-surface);color:var(--color-text);font-weight:700;box-shadow:inset 0 -2px 0 var(--color-primary)}
.dot{display:inline-block;width:8px;height:8px;border-radius:50%;margin-right:6px}.dot--nordic{background:#4F6B57}.dot--italian{background:#A4472C}
```
**驗收標準**
1. 第一次開啟（無 `sd.theme`）顯示北歐，`<html data-theme="nordic">`。
2. 點「義式」後整頁立即換色，`localStorage['sd.theme']==="italian"`；重新整理後仍為義式，且首屏不先閃北歐（以 Performance 錄影或慢速 3G 檢查無 FOUC）。
3. `sd.theme` 被設成亂值或 localStorage 不可用時，回到北歐、不報錯。
4. 鍵盤：Tab 只停在選中段；←→／↑↓／Home／End 能切換並移動焦點；focus 環可見。
5. 螢幕報讀器念出「介面主題，單選群組，北歐，已選取，1／2」。
6. 兩個主題下第 9 節所有組合對比 ≥ 4.5:1；切換不改版面尺寸，只改 token 值。
7. 登入頁、側欄（D）／頂欄（E）都看得到切換元件。

## 9. WCAG 對比實測（腳本計算，相對亮度公式 WCAG 2.1）
所有組合皆 ≥ 4.5:1（v1.0 調色後）。D 最低 4.66:1、E 最低 5.07:1。完整表見 `mockups/contrast.md`，節錄：

| 方向 | 前景 | 背景 | 對比 | AA |
|---|---|---|---|---|
| D | tx #2E2A24 | bg #F4EFE6 | 12.45:1 | ✓ |
| D | tx #2E2A24 | sf #FBF8F2 | 13.45:1 | ✓ |
| D | tx #2E2A24 | sf2 #ECE4D6 | 11.29:1 | ✓ |
| D | mu #5F574B | bg #F4EFE6 | 6.21:1 | ✓ |
| D | mu #5F574B | sf #FBF8F2 | 6.71:1 | ✓ |
| D | mu #5F574B | sf2 #ECE4D6 | 5.64:1 | ✓ |
| D | pr #4F6B57 | bg #F4EFE6 | 5.13:1 | ✓ |
| D | pr #4F6B57 | sf #FBF8F2 | 5.54:1 | ✓ |
| D | pr #4F6B57 | sf2 #ECE4D6 | 4.66:1 | ✓ |
| D | dan #9E3B2C | bg #F4EFE6 | 5.88:1 | ✓ |
| D | dan #9E3B2C | sf #FBF8F2 | 6.36:1 | ✓ |
| D | dan #9E3B2C | sf2 #ECE4D6 | 5.34:1 | ✓ |
| D | war #8A5A12 | bg #F4EFE6 | 5.16:1 | ✓ |
| D | war #8A5A12 | sf #FBF8F2 | 5.58:1 | ✓ |
| D | war #8A5A12 | sf2 #ECE4D6 | 4.68:1 | ✓ |
| D | ok #3F6B4A | bg #F4EFE6 | 5.37:1 | ✓ |
| D | ok #3F6B4A | sf #FBF8F2 | 5.80:1 | ✓ |
| D | ok #3F6B4A | sf2 #ECE4D6 | 4.87:1 | ✓ |
| D | inf #3E5F78 | bg #F4EFE6 | 5.89:1 | ✓ |
| D | inf #3E5F78 | sf #FBF8F2 | 6.36:1 | ✓ |
| D | inf #3E5F78 | sf2 #ECE4D6 | 5.34:1 | ✓ |
| D | neu #6B6358 | bg #F4EFE6 | 5.16:1 | ✓ |
| D | neu #6B6358 | sf #FBF8F2 | 5.58:1 | ✓ |
| D | neu #6B6358 | sf2 #ECE4D6 | 4.68:1 | ✓ |
| D | pron #FFFFFF | pr #4F6B57 | 5.88:1 | ✓ |
| D | dan #9E3B2C | dan-tint #F2E5DE | 5.47:1 | ✓ |
| D | war #8A5A12 | war-tint #EDE5D7 | 4.73:1 | ✓ |
| D | ok #3F6B4A | ok-tint #E4E7DE | 4.92:1 | ✓ |
| D | inf #3E5F78 | inf-tint #E8E9E6 | 5.53:1 | ✓ |
| E | tx #1E1C1A | bg #FAF8F5 | 16.02:1 | ✓ |
| E | tx #1E1C1A | sf #FFFFFF | 16.99:1 | ✓ |
| E | tx #1E1C1A | sf2 #F1EDE8 | 14.58:1 | ✓ |
| E | mu #5E5751 | bg #FAF8F5 | 6.70:1 | ✓ |
| E | mu #5E5751 | sf #FFFFFF | 7.10:1 | ✓ |
| E | mu #5E5751 | sf2 #F1EDE8 | 6.09:1 | ✓ |
| E | pr #A4472C | bg #FAF8F5 | 5.63:1 | ✓ |
| E | pr #A4472C | sf #FFFFFF | 5.97:1 | ✓ |
| E | pr #A4472C | sf2 #F1EDE8 | 5.12:1 | ✓ |
| E | dan #A3262A | bg #FAF8F5 | 6.91:1 | ✓ |
| E | dan #A3262A | sf #FFFFFF | 7.32:1 | ✓ |
| E | dan #A3262A | sf2 #F1EDE8 | 6.28:1 | ✓ |
| E | war #87570F | bg #FAF8F5 | 5.83:1 | ✓ |
| E | war #87570F | sf #FFFFFF | 6.18:1 | ✓ |
| E | war #87570F | sf2 #F1EDE8 | 5.30:1 | ✓ |
| E | ok #3B6B52 | bg #FAF8F5 | 5.81:1 | ✓ |
| E | ok #3B6B52 | sf #FFFFFF | 6.16:1 | ✓ |
| E | ok #3B6B52 | sf2 #F1EDE8 | 5.28:1 | ✓ |
| E | inf #3B5675 | bg #FAF8F5 | 7.14:1 | ✓ |
| E | inf #3B5675 | sf #FFFFFF | 7.57:1 | ✓ |
| E | inf #3B5675 | sf2 #F1EDE8 | 6.50:1 | ✓ |
| E | neu #6A635D | bg #FAF8F5 | 5.57:1 | ✓ |
| E | neu #6A635D | sf #FFFFFF | 5.91:1 | ✓ |
| E | neu #6A635D | sf2 #F1EDE8 | 5.07:1 | ✓ |
| E | pron #FFFFFF | pr #A4472C | 5.97:1 | ✓ |
| E | dan #A3262A | dan-tint #F6E9EA | 6.19:1 | ✓ |
| E | war #87570F | war-tint #F1EBE2 | 5.21:1 | ✓ |
| E | ok #3B6B52 | ok-tint #E7EDEA | 5.19:1 | ✓ |
| E | inf #3B5675 | inf-tint #EBEEF1 | 6.50:1 | ✓ |

| D | 側欄／登入字標 eyebrow #33291F | 橡木淺端 #D2B288 | 7.08:1 | ✓ |
| D | 側欄／登入字標 eyebrow #33291F | 橡木深端 #C6A072 | 5.87:1 | ✓ |
| D | 側欄／登入字標 eyebrow #33291F | 橡木深端＋木紋條 #BD986B | 5.32:1 | ✓ |
| D | 側欄文字 #2E2A24 | 橡木淺端 #D2B288 | 7.10:1 | ✓ |
| D | 側欄文字 #2E2A24 | 橡木深端＋木紋條 #BD986B | 5.34:1 | ✓ |
| D | 側欄選中項 #2E2A24 | #FBF8F2 | 13.45:1 | ✓ |
| D | primary 連結 #4F6B57 | bg #F4EFE6 | 5.13:1 | ✓ |
| D | primary 連結 #4F6B57 | sf #FBF8F2 | 5.54:1 | ✓ |
| E | primary 導覽／連結 #A4472C | sf #FFFFFF | 5.97:1 | ✓ |
| E | primary 導覽／連結 #A4472C | bg #FAF8F5 | 5.63:1 | ✓ |

v1.0 補測：橡木區、側欄、主色作文字等先前未測組合全部 ≥ 4.5:1（最低 5.13:1，D primary 連結 on bg）。全表最低值 D 4.66:1、E 5.07:1。

## 10. `/apps/new` 應用接入：狀態規格（2026-11-09 新增）

依據：PLAN.md「階段 3：應用接入」。注意：`PLAN-ADDENDUM-MONITOR.md` 第 8 節已把原第 3 階段（應用接入）順延到「6 起」，現行第 3 階段是黑名單／白名單頁。本節是先備好的設計稿，B 組實作時程以增補為準。
角色：`app_owner`（側欄只顯示「應用接入」「應用地圖」）。其他角色進入此頁顯示無權限頁，不回空白。
視覺稿：`apps-new-{nordic|italian}-{no-events|received|loading|empty|error}.png`；HTML：`mockups/apps-new-*.html`；產生腳本：`mockups/gen_apps.py`。

### 10.1 版面與元件
- **頁首**：眉標「應用接入 / 新增」＋標題「接入新應用」＋**只觀察徽章**（`.observe`，info 色、10% 淡底、D 膠囊／E 直角），文案「◉ 只觀察模式」；下方說明「接入後只收事件、建立地圖，不產生限制草案、不呼叫模型。」徽章在所有狀態都存在。
- **步驟條**：1 基本資料 → 2 入口設定 → 3 等待合法事件 → 4 完成接入。完成段 success 色加「✓」；目前段 primary 粗線加粗字；未到段 border 色。用 `<ol aria-label="接入步驟">`，目前段加 `aria-current="step"`。
- **左卡「應用資料」**：應用名稱、應用代號（app_id，英數與連字號）、事件來源（應用反向代理／存取紀錄）。固定提示「入口權杖由平台管理員於控制程序設定，不在此畫面顯示。」（權杖不進前端）
- **右卡「事件接收」**：合法事件筆數（襯線 56px，`lining-nums tabular-nums`）、最後一筆時間（含時區，例如 `2026-11-09 15:18:42（UTC+8）`）、最近 3 筆（時間／路徑樣板／`response_class` 標籤）。**只顯示 `route_template` 與 `response_class`，不顯示參數值、本文、標頭。** 容器 `aria-live="polite"`，只在筆數從 0 變成 ≥1 或錯誤出現時朗讀。
- **底部動作**：主要「完成接入」、次要「稍後再完成」。按鈕停用時旁邊顯示原因（ⓘ＋文字），按鈕帶 `aria-disabled="true"` 和 `aria-describedby` 指向原因。停用時不用 `disabled` 屬性，保留焦點讓報讀器念得到原因。
- **禁止出現**：限制草案、AI 建議、倒數、核准／退回按鈕、任何模型相關字樣（除了「不呼叫模型」的說明）。

### 10.2 狀態表
| 狀態 | data-state | 橫幅 | 右卡 | 完成鈕 | 原因文案 |
|---|---|---|---|---|---|
| 空（首次進入、未填） | `empty` | 無 | 「尚未開始接收」＋「填完應用資料並儲存後，這裡會即時顯示入口送來的事件。」 | 停用 | 請先填完應用資料。 |
| 載入 | `loading` | 無 | 骨架（`aria-busy="true"`）＋「正在讀取事件筆數…」 | 停用 | 正在確認事件… |
| 尚無合法事件 | `no-events` | info「**等待事件** 應用已儲存。入口送來合法事件後即可完成接入。」 | 筆數 0、時間「—」、「等待入口送來第一筆事件… 每 5 秒自動更新。請在應用上操作任一功能（例如開啟訂單頁）以產生事件。」 | **停用** | 尚未收到合法事件，至少需要 1 筆才能完成接入。 |
| 已收到事件 | `received` | success「**已收到合法事件** 可以完成接入。完成後此應用以『只觀察』模式運作。」 | 筆數 N、最後一筆時間、最近 3 筆 | **可用** | — |
| 錯誤：不合法事件 | `error` + `data-error="invalid"` | danger（`role="alert"`）「**收到不合法事件** N 筆含不允許的欄位（參數值、本文或標頭），已整份拒收。請檢查入口設定。」 | 筆數仍為合法筆數；「已拒收 N 筆不合法事件（不計入筆數）。」 | 合法筆數為 0 時停用 | 同「尚無合法事件」 |
| 錯誤：連線失敗 | `error` + `data-error="gateway"` | warning「**入口連線失敗** 最近 N 分鐘無法連上「X」。重新連線」 | 保留上次數字 | 合法筆數為 0 時停用 | 同上 |
兩種錯誤可以同時出現（稿中一起畫），danger 在上。合法筆數已 ≥1 時又發生錯誤：完成鈕仍可用，橫幅照常顯示。

### 10.3 驗收對照（PLAN.md 階段 3 三條）
| PLAN 驗收 | 畫面怎麼證明 | 對應稿 |
|---|---|---|
| 沒有收到至少一筆合法事件，完成鈕不可用 | `empty`／`loading`／`no-events`／`error`（合法 0 筆）時完成鈕 `aria-disabled` 並顯示原因；不合法事件不計入筆數 | `apps-new-*-no-events.png`、`-empty`、`-loading`、`-error` |
| 接入過程不產生限制草案，也不呼叫模型 | 全程顯示「只觀察模式」徽章與說明；頁面沒有任何限制草案／AI 建議區塊；前端不呼叫任何意圖或模型 API（測試可斷言網路請求清單） | 全部 10 張 |
| 事件寫入後，頁面能看到筆數與最後一筆時間 | `received`：筆數＋最後一筆時間（含時區）＋最近 3 筆 | `apps-new-*-received.png` |

### 10.4 新色組合對比（腳本實測，全部 ≥ 4.5:1，最低 4.68:1）
| 方向 | 前景 | 背景 | 對比 | AA |
|---|---|---|---|---|
| D（nordic） | /apps/new 等待事件橫幅 info #3E5F78 | 7% 淡底 #EEEDE9 | 5.76:1 | ✓ |
| D（nordic） | /apps/new 已收到橫幅 success #3F6B4A | 8% 淡底 #ECEDE5 | 5.22:1 | ✓ |
| D（nordic） | /apps/new 只觀察徽章 info #3E5F78 | 10% 淡底 #E8E9E6 | 5.53:1 | ✓ |
| D（nordic） | /apps/new 錯誤橫幅 danger #9E3B2C | 7% 淡底 #F4EBE4 | 5.73:1 | ✓ |
| D（nordic） | /apps/new 連線失敗橫幅 warning #8A5A12 | 8% 淡底 #F2EBE0 | 4.99:1 | ✓ |
| D（nordic） | 主題切換未選段 text-muted #5F574B | surface-2 #ECE4D6 | 5.64:1 | ✓ |
| D（nordic） | 主題切換選中段 text #2E2A24 | surface #FBF8F2 | 13.45:1 | ✓ |
| D（nordic） | 停用「完成接入」 neutral #6B6358 | surface-2 #ECE4D6 | 4.68:1 | ✓ |
| D（nordic） | 步驟已完成 success #3F6B4A | bg #F4EFE6 | 5.37:1 | ✓ |
| E（italian） | /apps/new 等待事件橫幅 info #3B5675 | 7% 淡底 #F1F3F5 | 6.81:1 | ✓ |
| E（italian） | /apps/new 已收到橫幅 success #3B6B52 | 8% 淡底 #EFF3F1 | 5.50:1 | ✓ |
| E（italian） | /apps/new 只觀察徽章 info #3B5675 | 10% 淡底 #EBEEF1 | 6.50:1 | ✓ |
| E（italian） | /apps/new 錯誤橫幅 danger #A3262A | 7% 淡底 #F9F0F0 | 6.54:1 | ✓ |
| E（italian） | /apps/new 連線失敗橫幅 warning #87570F | 8% 淡底 #F5F2EC | 5.53:1 | ✓ |
| E（italian） | 主題切換未選段 text-muted #5E5751 | surface-2 #F1EDE8 | 6.09:1 | ✓ |
| E（italian） | 主題切換選中段 text #1E1C1A | surface #FFFFFF | 16.99:1 | ✓ |
| E（italian） | 停用「完成接入」 neutral #6A635D | surface-2 #F1EDE8 | 5.07:1 | ✓ |
| E（italian） | 步驟已完成 success #3B6B52 | bg #FAF8F5 | 5.81:1 | ✓ |

---
## 附錄：已否決方向（A 深色值勤控制台、B 淺色清爽企業、C 高對比緊湊）
**已被使用者否決，請勿實作。** 圖檔 `direction-a|b|c-*.png` 保留作紀錄。
