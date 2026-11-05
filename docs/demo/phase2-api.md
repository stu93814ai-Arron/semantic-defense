# 第 2 階段：control-api 現場演示（給非工程觀眾）

用瀏覽器以外的方式，直接問「管理大門」幾句話，證明門鎖有裝好。  
**不要在正式環境做**；這裡用的是倉庫內的**測試種子帳號**（明碼只寫在種子檔，本頁不重複密碼）。

## 你需要什麼

- 專案根目錄已 `pnpm install`
- 兩個終端機視窗（一個開伺服器，一個打指令）
- 指令列工具：`curl`（macOS／Linux 通常已有）

## 測試帳號在哪裡（請自己打開看密碼）

| 使用者名稱 | 角色 | 密碼定義位置（請打開檔案查看，勿把正式密鑰貼到聊天） |
| --- | --- | --- |
| `operator1` | 值班 | `apps/control-api/src/seed-phase2.ts` |
| `owner1` | 應用負責人（應用 `app-alpha`） | 同上 |
| `owner2` | 應用負責人（應用 `app-beta`） | 同上 |
| `admin1` | 平台管理員 | 同上 |

也寫在 `apps/control-api/test/README.md`「種子帳號」表。本頁 curl 範例用環境變數 `PASS_OPERATOR1` 等，請先在本機設定：

```bash
# 範例：打開種子檔後，把對應測試密碼填進變數（僅本機 shell，勿提交、勿貼到公開場合）
export PASS_OPERATOR1='（見 seed-phase2.ts 裡 operator1 那一列）'
export PASS_OWNER1='（見 owner1 那一列）'
export PASS_ADMIN1='（見 admin1 那一列）'
export BASE=http://127.0.0.1:8787
```

---

## 一、啟動（終端機 A）

在**專案根目錄**執行。外層的 `with-pg.mjs` 會起一個用完即丟的 Postgres，並設定 `DATABASE_URL`；演示程式只聽 **管理埠 8787**，不會當流量入口。

```bash
# 預設閒置 15 秒（最後一步可改短）；種子帳號會自動寫入
node scripts/with-pg.mjs env DEMO_PORT=8787 DEMO_IDLE_MS=15000 DEMO_SEED=1 \
  pnpm exec vitest run --config docs/demo/vitest.demo.config.ts --reporter=verbose
```

**你應該看到**一行類似：

```text
DEMO_READY base=http://127.0.0.1:8787 idleTimeoutMs=15000 seed=yes
```

**這證明**：管理 API 已在單一管理埠就緒，並連上本次拋棄式資料庫。

> 結束演示：在此終端機按 `Ctrl+C`。若埠佔用，可再執行 `fuser -k 8787/tcp`。

---

## 二、登入與 Cookie（終端機 B）

**要打的字：**

```bash
curl -sS -D - -o /tmp/sd-body.txt -c /tmp/sd-cookies.txt \
  -X POST "$BASE/api/session/login" \
  -H 'content-type: application/json' \
  -d "{\"username\":\"operator1\",\"password\":\"$PASS_OPERATOR1\"}"
echo; cat /tmp/sd-body.txt; echo
```

**你應該看到：**

- 狀態列 `HTTP/1.1 200`
- 本文 `{"ok":true}`
- `set-cookie:` 開頭含 `sd_session=`，且帶 **`HttpOnly`**、**`Secure`**、**`SameSite=Strict`**

再問「我是誰」：

```bash
curl -sS -b /tmp/sd-cookies.txt -w "\nHTTP:%{http_code}\n" "$BASE/api/session/me"
```

**你應該看到：** `{"username":"operator1","role":"operator"}` 與 `HTTP:200`。

**這證明：** 能登入；工作階段 Cookie 名稱正確且瀏覽器腳本讀不到（HttpOnly），並限制跨站帶出（SameSite=Strict）。

---

## 三、三種身分：自己的門進得去、別人的門被擋

### 3.1 值班打管理名單 → 應被拒

（沿用上一節的 cookie）

```bash
curl -sS -b /tmp/sd-cookies.txt -w "\nHTTP:%{http_code}\n" "$BASE/api/admin/users"
```

**你應該看到：** 本文含「權限不足」，`HTTP:403`。

### 3.2 換成應用負責人，看自己的應用／別人的應用

```bash
curl -sS -b /tmp/sd-cookies.txt -c /tmp/sd-cookies.txt -X POST "$BASE/api/session/logout" >/dev/null
rm -f /tmp/sd-cookies.txt
curl -sS -c /tmp/sd-cookies.txt -X POST "$BASE/api/session/login" \
  -H 'content-type: application/json' \
  -d "{\"username\":\"owner1\",\"password\":\"$PASS_OWNER1\"}"
echo
curl -sS -b /tmp/sd-cookies.txt -w "\nHTTP:%{http_code}\n" "$BASE/api/apps/app-alpha"
curl -sS -b /tmp/sd-cookies.txt -w "\nHTTP:%{http_code}\n" "$BASE/api/apps/app-beta"
```

**你應該看到：**

- `app-alpha` → `{"id":"app-alpha"}`、`HTTP:200`
- `app-beta` → 錯誤本文（例如「查無應用」）、`HTTP:404`（實作也可能是 403；重點是**看不到 beta 內容**）

### 3.3 平台管理員：管理 OK、值班案件被擋

```bash
rm -f /tmp/sd-cookies.txt
curl -sS -c /tmp/sd-cookies.txt -X POST "$BASE/api/session/login" \
  -H 'content-type: application/json' \
  -d "{\"username\":\"admin1\",\"password\":\"$PASS_ADMIN1\"}" >/dev/null
curl -sS -b /tmp/sd-cookies.txt -w "\nHTTP:%{http_code}\n" "$BASE/api/admin/users"
curl -sS -b /tmp/sd-cookies.txt -w "\nHTTP:%{http_code}\n" "$BASE/api/judgments"
```

**你應該看到：**

- `/api/admin/users` → `{"items":[]}`、`HTTP:200`（空清單，不是白頁／不是 500）
- `/api/judgments` → 「權限不足」、`HTTP:403`

**這證明：** 三種身分各走各的門；改網址／直接打 API 也進不了別人的房間。

---

## 四、打錯密碼：訊息一樣；連錯六次會暫時擋住

先確認「不存在的帳號」與「存在但密碼錯」**字一模一樣**（位元組一致）：

```bash
curl -sS -o /tmp/sd-known.txt -w "HTTP:%{http_code}\n" -X POST "$BASE/api/session/login" \
  -H 'content-type: application/json' \
  -d '{"username":"operator1","password":"definitely-wrong"}'
curl -sS -o /tmp/sd-unknown.txt -w "HTTP:%{http_code}\n" -X POST "$BASE/api/session/login" \
  -H 'content-type: application/json' \
  -d '{"username":"no-such-user-zzz","password":"definitely-wrong"}'
echo "known=$(cat /tmp/sd-known.txt)"
echo "unknown=$(cat /tmp/sd-unknown.txt)"
cmp /tmp/sd-known.txt /tmp/sd-unknown.txt && echo '兩段本文完全相同'
```

**你應該看到：** 兩次皆 `HTTP:401`，本文皆為 `{"error":"帳號或密碼錯誤"}`，且 `cmp` 成功。

**速率限制演示**請在**剛種子過、此帳號尚未失敗過**時做（可重啟終端機 A 的啟動指令，或新開一次 `with-pg` 工作階段）。連續六次：

```bash
for i in 1 2 3 4 5 6; do
  echo -n "第 ${i} 次: "
  curl -sS -w " HTTP:%{http_code}\n" -X POST "$BASE/api/session/login" \
    -H 'content-type: application/json' \
    -d "{\"username\":\"operator1\",\"password\":\"bad-rate-$i\"}"
done
```

**你應該看到：** 前五次 `HTTP:401` 與「帳號或密碼錯誤」；**第六次** `HTTP:429`，本文含「帳號或密碼錯誤，請稍後再試」。

**這證明：** 猜密碼不會洩漏帳號是否存在；同一個帳號＋來源連錯會被暫時擋住。

---

## 五、關掉再開（同一資料庫）：登入狀態還在

種子每次預設會**清空表再寫入**，所以「重啟後還記住你」必須第二次啟動時加上 **`DEMO_SEED=0`**（沿用同一個 `with-pg` 提供的 `DATABASE_URL`）。

1. 終端機 A 已在跑（`DEMO_SEED=1`）。在終端機 B 登入 `owner1` 並存 cookie（同第三節）。
2. 確認：

```bash
curl -sS -b /tmp/sd-cookies.txt -w "\nHTTP:%{http_code}\n" "$BASE/api/session/me"
```

應為 `owner1`／`app_owner`、`HTTP:200`。

3. 終端機 A：`Ctrl+C` 停掉 API。**不要結束**外層的 `with-pg` 的話——實務上請用「同一個 with-pg 包住的 shell」再開一次。示範做法：在**已有 `DATABASE_URL` 的 shell**（先跑過 with-pg 進入的子 shell）執行：

```bash
# 第二次啟動：不要重播種子，以免清掉 sessions
DEMO_PORT=8787 DEMO_IDLE_MS=15000 DEMO_SEED=0 \
  pnpm exec vitest run --config docs/demo/vitest.demo.config.ts --reporter=verbose
```

若你是「一條指令」啟動，請改用：

```bash
node scripts/with-pg.mjs bash -lc '
  DEMO_PORT=8787 DEMO_IDLE_MS=15000 DEMO_SEED=1 pnpm exec vitest run --config docs/demo/vitest.demo.config.ts --reporter=verbose &
  API=$!
  # …中間在另一終端機登入…
  kill $API; wait $API || true
  DEMO_PORT=8787 DEMO_IDLE_MS=15000 DEMO_SEED=0 pnpm exec vitest run --config docs/demo/vitest.demo.config.ts --reporter=verbose
'
```

4. 終端機 B **不要重新登入**，再用同一 cookie 檔：

```bash
curl -sS -b /tmp/sd-cookies.txt -w "\nHTTP:%{http_code}\n" "$BASE/api/session/me"
```

**你應該看到：** 仍是 `owner1`／`app_owner`、`HTTP:200`（不是「未登入」）。

**這證明：** 工作階段寫在 Postgres，不是只活在記憶體裡的一次性程式。

---

## 六、亂打網址／假裝代理 → 只有 404，不會幫你轉發

```bash
curl -sS -o /dev/null -w "GET /          -> %{http_code}\n" "$BASE/"
curl -sS -o /dev/null -w "GET /anything  -> %{http_code}\n" "$BASE/anything"
curl -sS -o /dev/null -w "GET /proxy?... -> %{http_code}\n" \
  "$BASE/proxy?url=http://127.0.0.1:9/secret"
```

**你應該看到：** 三行皆為 `404`。

**這證明：** control-api 是管理平面，不是流量入口／反向代理。

（進階）可另開一個本機小伺服器當「哨兵」，確認命中次數仍為 0；自動化測試見 `plane-separation.test.ts`。

---

## 七、太久沒操作 → 要重新登入

1. 停掉 API 後，以**短閒置**重啟（例如 2 秒）：

```bash
node scripts/with-pg.mjs env DEMO_PORT=8787 DEMO_IDLE_MS=2000 DEMO_SEED=1 \
  pnpm exec vitest run --config docs/demo/vitest.demo.config.ts --reporter=verbose
```

2. 登入後立刻問 me（應 200），等 3 秒再問一次：

```bash
rm -f /tmp/sd-cookies.txt
curl -sS -c /tmp/sd-cookies.txt -X POST "$BASE/api/session/login" \
  -H 'content-type: application/json' \
  -d "{\"username\":\"operator1\",\"password\":\"$PASS_OPERATOR1\"}" >/dev/null
curl -sS -b /tmp/sd-cookies.txt -w "\nHTTP:%{http_code}\n" "$BASE/api/session/me"
sleep 3
curl -sS -b /tmp/sd-cookies.txt -w "\nHTTP:%{http_code}\n" "$BASE/api/session/me"
```

**你應該看到：** 第一次 `HTTP:200`；約 3 秒後第二次 `HTTP:401`，本文含「未登入」。

**這證明：** 閒置逾時由伺服器判定，過期工作階段不能再進門。

---

## 對照：這些步驟對應什麼驗收

| 步驟 | 對應 |
| --- | --- |
| Cookie 旗標與 me | 準則 3／登入 |
| 三角色 403、空清單 | 準則 1／5、空狀態 |
| owner 跨應用 | 準則 2 |
| 相同錯誤文案與 429 | 準則 6 |
| 重啟後 session | 持久化（Postgres） |
| `/`、`/proxy` → 404 | 管理／流量平面分離（管理側） |
| 短閒置後 401 | 閒置自動登出 |

控制台畫面（無權限頁、主題北歐／義式）請用 Playwright／實際開 console；本腳本只演示 **API 大門**。
