# WORKER.md — 單隻股票 V2.0 報告流程（排程子 session／子代理用）

輸入：`TICKER`、`DATE`（交易日 YYYY-MM-DD，＝截圖日期資料夾 `DD mon YYYY`）、個股資料夾 id、日期資料夾 id、`MODE`（full＝三份；card＝只出行動卡）。輸出：上載到 Drive（經網站 `/api/upload`）＋回報一行 JSON。

## 0. 環境（每個新 session 做一次）
```
cd <repo>/tools/stockreport && npm ci --silent        # 字體 @fontsource/noto-sans-tc
cd <repo> && npm ci --silent                          # signals.js 用 pdfjs-dist（測行動卡解析）
```
Playwright／Chromium 已預裝（`/opt/node22/lib/node_modules/playwright`，唔好 `playwright install`）。

## 1. 取截圖（要齊 17 張，缺就停，回報 `incomplete`）
排程 session **冇 Drive 連接器**，一律用 `drive.py`（經網站 API；有連接器都照用呢套，結果一樣）：
```
python3 drive.py tickerfolder <TICKER>                      # 個股資料夾 id（重點股 id 已喺任務俾咗）
python3 drive.py datefolder <個股資料夾id> "22 oct 2026"      # 日期資料夾 id（月份三個小寫字母）
python3 drive.py shots <日期資料夾id> /tmp/<TICKER>           # 01–17 齊先下載；唔齊印 INCOMPLETE＋缺邊啲
```
截圖喺日期資料夾（任務會俾「個股資料夾 id」同「日期資料夾 id」兩個，唔好混）。**唔好用 Drive 嘅文字辨識（部分圖回傳空白或讀錯），要用 Read 工具直接睇圖。** 圖面右下角 UTC 鐘係截圖時間，唔係 K 線時間；盤後價只記錄唔用。

### 亞洲個股版面（港股、日股、韓股，代號全數字；日股 ETF 見下）
用 `drive.py shots <id> [outDir] --asia`：只要求 01–14；**15 內部人**（亞洲冇）、**16 預測評級**、**17 估值 P/S** 可能缺（例如 000660 缺 15、17；其餘多數缺 15）→ 對應欄位如實標「缺項（該市場冇此頁）」，唔當負面證據；覆蓋率按實際格數列出。價格幣別 HKD／JPY／KRW，日股成交量單位係股（100 股一手）；`S['asof']` 用該市場收市時間（港 16:00 HKT、日 15:00 JST＝14:00 HKT、韓 15:30 KST＝14:30 HKT）；無本地大盤報告就 `S['mkt_ref']`＝『無（只用圖面指數）』，唔好引用美股大盤報告當本地大市。

### ETF 版面（例如 XLV、XLK、QQQ、SOXX…）
ETF 資料夾只有 **12 張**：01 Daily／02 Weekly／03 4H／04 2H（TradingView）＋05 Futubull_Chart_Daily ＋06 Fund_Holdings、07 Fund_Portfolio、08 Fund_AUM、09 Fund_Description、10 Fund_Basic_Info、11 Fund_Dividends、12 Fund_Stock_Splits。`drive.py shots` 見到 `OK (ETF 12 張版面)` 就算齊。處理方式：
- 九構面仍然全部評分：**基本面**按 ETF 持倉集中度／板塊權重／費用率／AUM 變化判斷（唔係公司財報）；**機構支持**冇 13F／Form 4／分析員評級頁 → 標「N/A（ETF 無此頁）」，該構面用持倉 AUM 資金流向或標 3 星並寫明「缺資料，按中性計」（覆蓋率要如實列出少於 100%）；Minervini／CANSLIM 只做可量度嘅價格趨勢項，C／A／N／S／I 標 N/A。
- `fund_rows` 改為 ETF 項目（前十大持倉權重、板塊／行業分佈、AUM、費用率、派息、拆股歷史），`smart` 放 AUM／持倉變化；唔好硬套公司財報用語。
- `prep.py images` 只會裁 Futubull 圖；ETF 圖直接睇原圖或 `_c.png`。

## 2. 數據
```
python3 prep.py data <TICKER> <DATE>          # （網站 /api/ohlcv 曾回 502，重試一次先算失敗；data 同 images 分開跑，唔好用 && 串）網站 /api/ohlcv（Yahoo 日線）→ data/<TICKER>.json；最後一根要＝DATE
python3 prep.py images <TICKER> /tmp/<TICKER>  # 裁切 Futubull 圖：*_c.png（主畫面）、06–09 另有 *_t.png（標籤欄＋最近 6 季，字夠大）
```
**如果 `prep.py data` 話最後一根 K 線唔係 DATE（Yahoo 過咗 UTC 午夜有時會唔再回傳前一日 bar；網站由 2026-10-23 起會保存已見過嘅日線）**：用 Longbridge MCP `history_candlesticks_by_offset`（period=day, count=5, forward_adjust=false, trade_sessions=intraday）攞最近幾日，再用 `--extra '[{"d":"YYYY-MM-DD","o":..,"h":..,"l":..,"c":..,"v":股數}]'` 補入，並喺附錄第三節註明該日 OHLCV 來源係 Longbridge。

Yahoo 成交量同 Longbridge／TradingView 有時唔同（例：NVDA 2026-09-21 Yahoo 109.8M vs Longbridge 161.3M）；**多來源並列，唔平均**。圖面 MA（TradingView）同重算 SMA 要一致到兩位小數，否則先查（復權、時段）。

> 注意：任務俾你嘅有「個股資料夾 id」同「日期資料夾 id」兩個，**截圖喺日期資料夾**。`_t.png` 拼接圖只啱 NVDA／PFE 嗰種版面（06–09 欄位位置固定）；其他股票先睇 `_c.png`，唔清楚再自己用 PIL 裁左 45%＋右 30%。新上市未滿 200 日嘅股票：`prep.py data` 會因日線 <260 根而失敗——手動放寬 assert、MA200／52 週高低標「N/A（上市未滿 N 日）」並喺 `spec`／`texts` 內避開 MA200 相關欄位。

## 3. 睇圖（每張都要睇；睇唔清嘅數字寫「無法辨識」，唔好估）
01–04 TradingView 日／週／4H／2H：價、MA、RSI、成交量。05 Futubull 日線；06 關鍵指標、07 損益、08 資產負債、09 現金流（用 `_t.png`）；10 營運效率、11 收入拆分、12 全部持有人、13 股東活動、14 機構、15 內部人、16 預測評級、17 估值 P/S（用 `_c.png`）。ETF／非公司（如 XLV）冇財報頁就如實標「缺項」，基本面構面按 ETF 持倉／估值頁判斷或標 N/A，唔好湊分。

## 4. 寫分析（`work/<TICKER>_<DATE>.py`）
照 `examples/`（`specs_NVDA_PFE.py`、`texts_NVDA.py`、`texts_PFE.py`）嘅結構寫 `spec(m)` 同 `texts(m, S)`。**只學結構同寫法，數字全部由當日截圖／行情重新得出，唔好沿用範例內容。** 必守：
- 九構面＝趨勢、成交量、圖形、Momentum、基本面、市場配合、機構支持、Pullback、Breakout，星 1–5，分數＝星數÷45×100。
- 回踩路徑（機械式入場區）＋順勢路徑；R1–R4；止損％÷入場價、距離％÷現價；R4 四項測試（大市／第二階段／RRR≥2／雜訊被掃率＜30%，被掃率由 `plan_numbers` 按群組定義計）。
- 紀律十條（`docs/jlaw-myt-stock-prompt-v2.md`）：收市價為準、同一事實只計一次、多來源並列不調和、承襲門檻不自行改、Form 4 唔直接當看淡、突破成功率冇樣本一律 N/A。
- 大盤／板塊背景：美股引用最近一份我哋嘅大盤報告（`python3 drive.py market` 列出，`drive.py pdf` 下載）；港股、日股冇大盤報告就只用圖面指數同當日板塊，並註明。群組大盤執行規則（半倉上限等）未提供就唔套用。
- 上一份：Drive 同股票最近一份行動卡／報告（用 `read_file_content` 或下載 PDF 再 `pdftotext`）；對比價位前先核對佢嘅日期同收市價係咪真係屬於該交易日（曾發現 10/20 卡其實用 10/19 收市）。
- **今日動作（≤40 字）**要寫成「未持倉：…。已持倉：續抱，按警報價處理。」——已持倉**唔好出現「減倉／離場／清倉」字眼**（`signals.js` 會機械歸類成賣出訊號）；`signals.js` 對 flat 嘅歸類字眼：「零新倉／零倉／不買／觀望／保持觀望／唔入場」→零新倉；「低吸／吸納／分批／建倉／買入／入場／開倉／加碼」→條件式建倉（會變買入訊號！）；其他（例如只寫「等」）→觀望。價位只放第 3、5 格（`買入觸發 227.00 ▲2.27%`、`減倉 212.77 ▼4.14%`、`離場 203.00 ▼8.55%`、`227.00 要升 2.27% …`）。
- 朗讀稿：3 分鐘 ≤950 字、完整 ≤3,500 字；口語廣東話；數字寫成適合朗讀（`examples/texts_NVDA.py` 有 `zh()`）。
- 唔好用 `+`／`-` 表示升跌，用 `▲`／`▼`（build 會後處理 `+x%`／`-x%`）。

## 4b. 篇幅（本體 ≤10 頁，好易爆）
`fund_rows` 最多 8 行、`risk` 每項 ≤1 行、`pattern_notes` ≤2 條、`smart` 放附錄（唔放本體）。`S['prior']` 字串入面如有括號，第一段（括號前）係評等分數，其餘放最後。`prior` 讀唔到 PDF 時用 `/api/signals` 嘅 rows／history 欄位，並喺附錄第三節註明。

## 5. 覆核（必做）
**凡係 `texts` 內寫死嘅數字、計數、日期序列，同「從未／最大／最小／連續」類斷言，全部要入 QA 檢查**（ESTC、FPS 兩次試做，初稿分別有 5、8 項錯誤，多數係憑印象寫嘅派發日數、升跌％、「從未觸發」）。
把報告內所有寫死嘅數字（價、量比、距離、R 值、基本面算術、日期序列）用原始數據獨立重算一次（見 `examples/qa_example.py`），失敗就改文字；更正項數寫入行動卡第 7 格同附錄第四節（`corr`、`corr_html`）；`NQ`（覆核數字個數）要等於 QA 檔實際檢查數，「另有 N 項對照差異」要等於附錄第三節實際並列數，唔好照抄範例。

## 6. 出 PDF、測試、上載
```
python3 build.py <TICKER> <DATE> work/<TICKER>_<DATE>.py     # → out/<DATE>_<TICKER>_行動卡／股票分析終極報告／核對附錄.pdf（行動卡 1 頁、本體 ≤10 頁，超出會 assert）
node sigtest.js out/<DATE>_<TICKER>_行動卡.pdf                # 要見到 date、ticker、評等、score、levels(buy/trim/stop)、alerts 3 條、flat/held 分類
```
上載（`ADMIN_PASSWORD` 由環境 proxy 自動帶 header，唔使寫密碼）：
```
python3 drive.py upload out/<檔名>.pdf        # 檔名＝YYYY-MM-DD_TICKER_行動卡.pdf／…_股票分析終極報告.pdf／…_核對附錄.pdf，cat=auto
python3 drive.py reports <TICKER> <DATE>      # 上載前後都查：同 ticker 同日同類型已有舊檔嘅 id
python3 drive.py trash <舊檔id> …              # 上載成功後將同名舊檔放入垃圾桶（用戶已授權刪舊版；可還原）
```

## 7. 回報（最後一行，JSON）
`{"ticker","date","mode","status":"done|incomplete|failed","rating","score","tier","pages":{…},"corrections":N,"notes":"…"}`
