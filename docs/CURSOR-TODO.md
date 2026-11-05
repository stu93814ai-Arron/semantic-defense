# 交給 Cursor 處理的事項（2026-11-05 整理）

1. 建立遠端程式庫
   - 在 GitHub 建一個私人 repo（例如 semantic-defense），把 /workspace/semantic-defense 的 main、team-a、team-b 推上去。
   - 目前專案沒有遠端，程式只存在機器人的電腦上，沒有備份。
   - 開啟 GitHub Actions，跑 typecheck、lint、測試、覆蓋率與 gitleaks。
   - 設定 main 分支保護：只能 fast-forward，禁止 force push。

2. 本地 AI 模型的推論環境（第 4 階段要用）
   - 準備一台有 GPU 的 Linux 主機，或確認現有主機的規格。
   - 安裝美國或歐洲來源的推論伺服器，例如 Ollama 或 vLLM，提供 OpenAI 相容的端點，只綁在內部位址。
   - 從官方帳號下載 Gemma、Llama 或 Mistral 的原始權重，不使用任何第三方改版或中國來源的模型。

3. 上線前（之後再處理）
   - 安排 Fortinet 與 Palo Alto 實機，測試 EDL 黑名單拉取。
   - 準備有 SPAN 鏡像埠的交換器，接旁路感測器。

處理完請告訴軟體大總召：repo 網址，以及推論端點的位址和模型名稱（金鑰不要貼在對話裡）。
