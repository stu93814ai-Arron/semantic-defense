# 允許的意圖模型清單（出處審查）

狀態：第一批總召裁示已填（2026-11-05 Asia/Taipei）。  
維護：新增／變更模型須 PR；資安簽核對照 [SECURITY-CHECKLIST-INTENT-MODEL.md](../../SECURITY-CHECKLIST-INTENT-MODEL.md) **M7**。  
裁示不明項：送軟體大總召（不得自行放行）。

## 判定規則（摘要）

1. **維護者／發布組織所在地**不得為中華人民共和國（含其管轄之發布主體）；見檢查表 M7。
2. **權重出處**（含微調、蒸餾、合併、量化自他模）之上游同樣適用；衍生自不允許上游者 → **不允許**。
3. **本表只收官方發布者原始權重**：Hugging Face 組織限下表「HF 組織」欄。**第三方**量化、微調、合併版本 **一律不許**，除非另送總召裁示並增列本表。
4. **判定不明＝不允許**，送總召裁示後才能列入本表。
5. 產品預設 **本地模型**；**Grok 為選配**（雲端時另過金鑰／出站條款，且須另列本表）。

## 允許列（系列級 — 僅官方原始權重）

| 系列標識 | 角色 | HF 組織（唯一允許來源） | 維護者／組織所在地 | 衍生關係 | 授權條款摘要 | 列入日期 | 證據 |
| --- | --- | --- | --- | --- | --- | --- | --- |
| **Gemma**（Google） | 本地意圖候選 | [`google`](https://huggingface.co/google) | 美國（Google LLC） | **僅**該組織發布之原始權重；禁止第三方 quant／微調／合併 | **Gemma 1–3 等**：[Gemma Terms of Use](https://ai.google.dev/gemma/terms)（開放權重＋使用限制／禁止用途政策；可商用但須轉傳條款與 Notice）。**Gemma 4**：Google 宣布改採 **Apache-2.0**（[說明](https://ai.google.dev/gemma/apache_2)）— 選用之具體 repo 須核對該卡 `license` 欄，不得假設全系列同一授權 | 2026-11-05 | 總召裁示；[terms](https://ai.google.dev/gemma/terms) |
| **Llama**（Meta） | 本地意圖候選 | [`meta-llama`](https://huggingface.co/meta-llama) | 美國（Meta Platforms, Inc.） | **僅**該組織發布之原始權重；禁止第三方 quant／微調／合併 | **Meta Llama Community License**（以所用主版本為準，如 Llama 3／後續卡上全文）。**商用（本產品對外銷售須特別注意）**：(1) 允許在遵守協議下商用／再散布，但須附協議副本、產品／文件顯著標示 *Built with Meta Llama …*、保留 Notice、遵守 Acceptable Use Policy；(2) **不得**用 Llama 材料或其輸出去改進「其他」大語言模型（不含 Llama 自身衍生）；(3) **額外商用門檻**：若授權方（含關係企業）在該 Llama 版本發布日當月之前一曆月之產品／服務 **MAU > 7 億**，須另向 Meta 申請授權，未獲前不得行使協議權利；(4) 商標使用受限。法務上線前應再核對實際選用之 `meta-llama/*` 卡上授權全文 | 2026-11-05 | 總召裁示；例：[Llama 3 LICENSE](https://github.com/meta-llama/llama3/blob/main/LICENSE) |
| **Mistral**（Mistral AI） | 本地意圖候選 | [`mistralai`](https://huggingface.co/mistralai) | 法國（Mistral AI） | **僅**該組織發布之原始權重；禁止第三方 quant／微調／合併 | **多數開源權重為 Apache-2.0**（可商用、修改、再散布）。**例外**：部分型號為 **modified MIT**（月營收逾約 USD 2,000 萬須另洽商用授權或走官方 Studio）或 **Mistral Ecosystem Open-Weight License**（若經營「Model as a Service」對外提供推論／後訓練控制權，須另簽商用條款；內嵌於終端產品功能通常除外—以該卡 LICENSE 為準）。選型時**逐卡**確認 `license`，不得整系列假設 Apache-2.0 | 2026-11-05 | 總召裁示；[Mistral 授權說明](https://help.mistral.ai/en/articles/347393-under-which-license-are-mistral-s-open-models-available) |

> 具體 checkpoint（例如 `google/gemma-2-9b-it`）落地時：在實作／`deps:` 變更中註明完整 HF repo id，且必須屬於上列組織、為官方原始權重；授權以該 repo 當下卡片為準。

## 明確不允許

| 標識或模式 | 原因 |
| --- | --- |
| 非 `google`／`meta-llama`／`mistralai` 之 HF 或其他托管上的「Gemma／Llama／Mistral」標名權重 | 非官方原始；第三方 quant／微調／合併 |
| 來源或維護組織在中國大陸之權重／API／映像 | 產品禁令 |
| 由禁上游或不明上游微調／蒸餾／合併／量化而得之衍生權重 | 同源／不明禁令 |
| 未列本表且無總召書面放行 | 判定不明＝不許 |
| Grok 或其他雲端 | 選配；**尚未**列入本表，啟用前須另裁示＋金鑰條款 |

## 變更紀錄

| 日期 | 說明 |
| --- | --- |
| 2026-11-05 | 初版：建立清單格式與規則 |
| 2026-11-05 | 總召第一批：Gemma／Llama／Mistral；僅 HF `google`、`meta-llama`、`mistralai` 原始權重；第三方 quant／微調／合併不許；各列授權摘要（Llama 商用條款加註） |
