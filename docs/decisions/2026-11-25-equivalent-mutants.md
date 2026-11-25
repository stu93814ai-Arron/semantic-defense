# 2026-11-25 等價突變 m9 與 p1（不改程式）

分支 team-a-lows-s2。這兩筆突變改了程式、測試仍綠，而且改完的行為與現行程式在觀測得到的結果上相同。不為了殺掉它們去改正式碼。

## m9：`timeout` 底下 trap 的 exit 0 與 exit 143 都是 124

`scripts/required.sh` 第 10 行：

```bash
trap 'bash scripts/dump-partial.sh; exit 143' TERM
```

`scripts/ci.sh` 用 `timeout 600 bash scripts/required.sh` 包住必跑。GNU `timeout` 在時限到了之後送 TERM，被包住的行程若在寬限內結束，`timeout` 自己的退出碼是 124，不管 trap 裡寫的是 `exit 0` 還是 `exit 143`。

2026-11-25 在這台機器上重跑（兩者都印出 `Terminated`，外層 `echo` 的退出碼都是 124）：

```bash
timeout 2 bash -c 'trap "exit 0" TERM; sleep 30'; echo $?
timeout 2 bash -c 'trap "exit 143" TERM; sleep 30'; echo $?
```

直接對 `required.sh` 送 TERM（沒有外包 `timeout`）時，143 仍是 trap 自己的退出碼。m9 的等價只出現在 `timeout` 這條路徑。trap 維持 `exit 143`，不改成 0。

## p1：先截到 200 字再遮罩，測不到 SECRET_TRUNC 外漏

`scripts/live-report.mjs` 的 `redactQuery` 先遮註解、引號、E 字串、美元引號與數字，沒閉合就遮到結尾，最後才 `slice(0, 200)`。

把順序對調（先 `slice(0, 200)` 再遮、不再做第二次截斷）之後，`scripts/test/ci-hang.test.ts` 的「截斷切在字串中間時不會留下 SECRET_TRUNC」仍然通過。原因：測資是 180 個 `Q`、一個未閉合的單引號、然後 `SECRET_TRUNC_`。先截到 200 字時密文還在片段裡，但未閉合引號會被遮到該片段結尾，遮完後的輸出不含 `SECRET_TRUNC`。沒有密文的查詢在截斷後長度也不會變長，所以「長度等於 200」也擋不住這次對調。

因此 p1 留在文件，不改遮罩順序。
