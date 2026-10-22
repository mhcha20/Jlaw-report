# WORKER.md — 單隻股票 V2.0 報告流程（排程子 session／子代理用）

輸入：`TICKER`、`DATE`（交易日 YYYY-MM-DD，＝截圖日期資料夾 `DD mon YYYY`）、個股資料夾 id、日期資料夾 id、`MODE`（full＝三份；card＝只出行動卡）。輸出：上載到 Drive（經網站 `/api/upload`）＋回報一行 JSON。

## 0. 環境（每個新 session 做一次）
```
cd <repo>/tools/stockreport && npm ci --silent        # 字體 @fontsource/noto-sans-tc
cd <repo> && npm ci --silent                          # signals.js 用 pdfjs-dist（測行動卡解析）
```
Playwright／Chromium 已預裝（`/opt/node22/lib/node_modules/playwright`，唔好 `playwright install`）。

## 1. 取截圖（要齊 17 張，缺就停，回報 `incomplete`）
1. Drive MCP `search_files`：`parentId = '<日期資料夾 id>'`，pageSize 100，跟 `nextPageToken`。檔名 `01_Daily_TradingView … 17_Futubull_Valuation_PS`。
2. 逐張 `curl -sL -o /tmp/<TICKER>/<檔名> "https://drive.google.com/uc?export=download&id=<fileId>"`（連結分享，免登入）。**唔好用 Drive 嘅文字辨識（部分圖回傳空白或讀錯）**，要用 Read 工具直接睇圖。
3. 圖面右下角 UTC 鐘係截圖時間，唔係 K 線時間；盤後價只記錄唔用。

## 2. 數據
```
python3 prep.py data <TICKER> <DATE>          # 網站 /api/ohlcv（Yahoo 日線）→ data/<TICKER>.json；最後一根要＝DATE
python3 prep.py images <TICKER> /tmp/<TICKER>  # 裁切 Futubull 圖：*_c.png（主畫面）、06–09 另有 *_t.png（標籤欄＋最近 6 季，字夠大）
```
Yahoo 成交量同 Longbridge／TradingView 有時唔同（例：NVDA 2026-09-21 Yahoo 109.8M vs Longbridge 161.3M）；**多來源並列，唔平均**。圖面 MA（TradingView）同重算 SMA 要一致到兩位小數，否則先查（復權、時段）。

## 3. 睇圖（每張都要睇；睇唔清嘅數字寫「無法辨識」，唔好估）
01–04 TradingView 日／週／4H／2H：價、MA、RSI、成交量。05 Futubull 日線；06 關鍵指標、07 損益、08 資產負債、09 現金流（用 `_t.png`）；10 營運效率、11 收入拆分、12 全部持有人、13 股東活動、14 機構、15 內部人、16 預測評級、17 估值 P/S（用 `_c.png`）。ETF／非公司（如 XLV）冇財報頁就如實標「缺項」，基本面構面按 ETF 持倉／估值頁判斷或標 N/A，唔好湊分。

## 4. 寫分析（`work/<TICKER>_<DATE>.py`）
照 `examples/`（`specs_NVDA_PFE.py`、`texts_NVDA.py`、`texts_PFE.py`）嘅結構寫 `spec(m)` 同 `texts(m, S)`。**只學結構同寫法，數字全部由當日截圖／行情重新得出，唔好沿用範例內容。** 必守：
- 九構面＝趨勢、成交量、圖形、Momentum、基本面、市場配合、機構支持、Pullback、Breakout，星 1–5，分數＝星數÷45×100。
- 回踩路徑（機械式入場區）＋順勢路徑；R1–R4；止損％÷入場價、距離％÷現價；R4 四項測試（大市／第二階段／RRR≥2／雜訊被掃率＜30%，被掃率由 `plan_numbers` 按群組定義計）。
- 紀律十條（`docs/jlaw-myt-stock-prompt-v2.md`）：收市價為準、同一事實只計一次、多來源並列不調和、承襲門檻不自行改、Form 4 唔直接當看淡、突破成功率冇樣本一律 N/A。
- 大盤／板塊背景：美股引用當日我哋嘅大盤報告（Drive 大盤分析資料夾）；港股、日股冇大盤報告就只用圖面指數同當日板塊，並註明。群組大盤執行規則（半倉上限等）未提供就唔套用。
- 上一份：Drive 同股票最近一份行動卡／報告（用 `read_file_content` 或下載 PDF 再 `pdftotext`）；對比價位前先核對佢嘅日期同收市價係咪真係屬於該交易日（曾發現 10/20 卡其實用 10/19 收市）。
- **今日動作（≤40 字）**要寫成「未持倉：…。已持倉：續抱，按警報價處理。」——已持倉**唔好出現「減倉／離場／清倉」字眼**（`signals.js` 會機械歸類成賣出訊號）；價位只放第 3、5 格（`買入觸發 227.00 ▲2.27%`、`減倉 212.77 ▼4.14%`、`離場 203.00 ▼8.55%`、`227.00 要升 2.27% …`）。
- 朗讀稿：3 分鐘 ≤950 字、完整 ≤3,500 字；口語廣東話；數字寫成適合朗讀（`examples/texts_NVDA.py` 有 `zh()`）。
- 唔好用 `+`／`-` 表示升跌，用 `▲`／`▼`（build 會後處理 `+x%`／`-x%`）。

## 5. 覆核（必做）
把報告內所有寫死嘅數字（價、量比、距離、R 值、基本面算術、日期序列）用原始數據獨立重算一次（見 `examples/qa_example.py`），失敗就改文字；更正項數寫入行動卡第 7 格同附錄第四節（`corr`、`corr_html`）。

## 6. 出 PDF、測試、上載
```
python3 build.py <TICKER> <DATE> work/<TICKER>_<DATE>.py     # → out/<DATE>_<TICKER>_行動卡／股票分析終極報告／核對附錄.pdf（行動卡 1 頁、本體 ≤10 頁，超出會 assert）
node sigtest.js out/<DATE>_<TICKER>_行動卡.pdf                # 要見到 date、ticker、評等、score、levels(buy/trim/stop)、alerts 3 條、flat/held 分類
```
上載（`ADMIN_PASSWORD` 由環境 proxy 自動帶 header，唔使寫密碼）：
```
curl -sS -X POST "https://jlaw-report-a74806.up.railway.app/api/upload?name=<URL 編碼檔名.pdf>&cat=auto" -H "Content-Type: application/pdf" --data-binary @out/<檔名>.pdf
```
檔名＝`YYYY-MM-DD_TICKER_行動卡.pdf`／`…_股票分析終極報告.pdf`／`…_核對附錄.pdf`。上載前用 Drive `search_files` 搵同 ticker 同日同類型嘅舊檔，上載成功後用 `trash_file` 放入垃圾桶（用戶已授權刪舊版；Drive 垃圾桶可還原）。

## 7. 回報（最後一行，JSON）
`{"ticker","date","mode","status":"done|incomplete|failed","rating","score","tier","pages":{…},"corrections":N,"notes":"…"}`
