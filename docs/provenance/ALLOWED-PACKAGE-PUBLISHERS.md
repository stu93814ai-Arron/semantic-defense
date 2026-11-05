# 允許的套件發布者清單（出處審查）

狀態：第一批（2026-11-05 Asia/Taipei）— **只列實際用到的模型權重發布組織**。  
推論 runtime（vLLM、llama.cpp、transformers 等）尚未選定前**不預先擴大**本表；選定時以 `deps:` commit 附證據後再增列。  
對照：[SECURITY-CHECKLIST-INTENT-MODEL.md](../../SECURITY-CHECKLIST-INTENT-MODEL.md) **M7**。  
判定不明＝不允許，送軟體大總召裁示。

## 判定規則（摘要）

1. 以**發布者／維護組織所在地**為準。
2. 不得引入中國來源之模型執行期相依、映像或服務客戶端。
3. **新增依賴**須 `deps:` commit，附出處證據。
4. 與允許模型對齊：權重**只**得自下列 HF 組織拉取官方原始檔。

## 允許發布者（目前實際用到 — 模型權重）

| 生態系 | 發布者／scope | 所在地依據 | 證據摘記 | 列入日期 |
| --- | --- | --- | --- | --- |
| Hugging Face | [`google`](https://huggingface.co/google) | 美國 — Google LLC | Gemma 官方原始權重；總召 2026-11-05 | 2026-11-05 |
| Hugging Face | [`meta-llama`](https://huggingface.co/meta-llama) | 美國 — Meta Platforms, Inc. | Llama 官方原始權重；總召 2026-11-05 | 2026-11-05 |
| Hugging Face | [`mistralai`](https://huggingface.co/mistralai) | 法國 — Mistral AI | Mistral 官方原始權重；總召 2026-11-05 | 2026-11-05 |

> 未列於本表之**既有**應用相依不追溯封鎖，但**新建或升級進入模型／推論路徑**者必須先列入或獲總召裁示。

## 變更紀錄

| 日期 | 說明 |
| --- | --- |
| 2026-11-05 | 初版：建立發布者清單格式 |
| 2026-11-05 | 只列實際用到的 HF：`google`、`meta-llama`、`mistralai` |
