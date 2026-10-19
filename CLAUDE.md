# JLaw 報告中心（jlaw-report）

給日後對話嘅項目背景。用戶用廣東話溝通，回覆請用廣東話（繁體）。

## 呢個項目係咩
- 一個網頁：列出兩個 Google Drive 資料夾入面嘅 PDF 報告，可剔選後經 WhatsApp 分享（連結或直接分享 PDF 檔案），可上傳／隱藏／刪除報告，並有「覆蓋檢查」比對股票清單表格同 Drive 報告。
- Drive 資料夾：根目錄 `1AeIL4vlhY5dqij_wtIF9paB0-cadqowE`（每日跨股總表＋子資料夾 行動卡／個股研究報告／核實報告）；大盤分析 `18yWn2hUykKaKru44HavWutfUST9Dux6_`。
- 股票清單 Google Sheet（第一個分頁「個股 research list」）：`1da207nad2cL2hN4vRLNtsOt2UXwgVTzMvoXS3VF98Fw`。

## 技術同部署
- 純 Node（無依賴）：`server.js`（伺服器＋API）、`index.html`（前端，單檔）、`data.js`（報告清單快照，網頁會用 Drive API 同步覆蓋）。
- 部署：Railway project `jlaw-report`（`a358b772-7b5a-4459-8207-17b52019e588`），service `web`（`5b0d435c-c2e9-4374-a2c9-f10772af8b81`），environment `production`（`dfaafb33-e564-40ab-a485-58fba582049b`）。volume `/data` 存隱藏清單同 Google token。公開網址 `jlaw-report-a74806.up.railway.app`。
- Railway 由 GitHub branch `claude/drive-reports-whatsapp-share-6m44wo` 自動部署。若 push 後冇自動重新部署，用 Railway MCP 嘅 `connect-service-source`（同一 repo＋branch）觸發。
- 環境變數（只記名稱，值喺 Railway）：`DRIVE_API_KEY`、`ADMIN_PASSWORD`、`GOOGLE_CLIENT_ID`、`GOOGLE_CLIENT_SECRET`、`GOOGLE_SA_JSON`（已不再需要）、`SHEET_ID`（選填）。Google OAuth redirect URI：`https://jlaw-report-a74806.up.railway.app/oauth/callback`。
- **唔好提交任何密碼、金鑰、token。** repo 係公開嘅。

## 買賣訊號（📊 分頁）
- `signals.js`：用 `pdfjs-dist` 讀「一頁行動卡」PDF 文字，抽取評等／分數／三道閘／今日動作（未持倉、已持倉）／三條價位／警報；`classify()` 按卡內文字機械歸類（零新倉、條件式建倉、三閘全過、觀望；續抱、減倉、離場），**唔係獨立買賣判斷**。
- `server.js`：`GET /api/signals`（**公開唯讀**；`?refresh=1` 重新分析需密碼）背景處理**所有日子**嘅行動卡（每股每日只取最新上傳），每份解析結果永久存 `/data/signals.json`（Drive 檔案日後被刪，歷史仍保留）；已處理過嘅卡唔會重讀（除非 `signals.js` 嘅 `VERSION` 升版，會用新解析規則重讀全部；改解析規則記得加 `VERSION`）；伺服器每 30 分鐘自動更新一次。`signals.js` 嘅 `diffCards()`／`buildHistory()` 逐日比較，標示 🟢買入訊號（未持倉轉條件式建倉／三閘全過、評等轉買入）同 🔴賣出訊號（已持倉轉減倉／離場、評等跌出買入），並記錄分數、閘、價位、大盤嘅每日變化。`backtest()` 做「每隻 $100」模擬：**訊號喺行動卡日期收市後先出 → 下一個交易日開市價成交**（買入訊號買、賣出訊號全數賣），複利滾存；唔計手續費、滑點；同日買賣並存持倉當賣、未持倉唔買；起始日已係買入狀態亦當買入訊號；持倉中按最新收市價計；下一個交易日未有行情則顯示「待成交」。開市價由 `prices.js` 讀 Yahoo Finance 日線（Stooq 後備；代號對應：字母＝美股、5 位數字＝港股 `.HK`、6 位數字＝韓股 `.KS`、4 位數字＝日股 `.T`／0 開頭港股；NESN、SCHN 歐洲 `.SW`、ATD 加拿大 `.TO` 喺 `prices.js` 嘅 `OVERRIDE` 同 `index.html` 嘅 `MKT_OVERRIDE` 手動指定，新增非美股字母代號要兩邊一齊加），存 `/data/prices.json`，每 3 小時更新；攞唔到行情時回測顯示「未攞到行情」而唔會亂計。結果喺 `/api/signals` 嘅 `bt`／`px`，網頁「💰 回測」視圖顯示每筆買賣嘅出訊號日、成交日同價位。網頁喺分析期間每 3 秒輪詢。
- 卡內「分析交易日」若係週六日（例如 10-17 批其實係 10-16 收市），`buildHistory()` 用 `tradingDate()` 退返上一個交易日。
- 行動卡版面變更時要更新 `signals.js` 嘅解析規則（以 `2 今日動作`、`3 三條價位` 等格標題切段）。真實卡文字屬內部資料，測試用文本放 scratchpad，唔好提交入 repo。
- 未有讀取：個股本體報告、核對附錄。

## 約定
- 報告檔名：`YYYY-MM-DD_TICKER_類型.pdf`；程式亦兼容 `TICKER-report-YYYY-MM-DD-繁體版`、`TICKER_JLaw_MYT_…_YYYYMMDD` 等格式，日期同股票代號由檔名解析。類型主要由 Drive 資料夾決定。
- 只提交 `server.js`、`index.html`、`data.js`、`package.json`、`docs/`、`CLAUDE.md`。測試用檔案放 scratchpad，唔好入 repo。
- 改動前端後，先用 Playwright（`/opt/pw-browsers/chromium`）以 390px 手機闊度測試。
- 管理功能（上傳／隱藏／刪除／覆蓋檢查／重新分析訊號）需 `ADMIN_PASSWORD`（買賣訊號頁本身公開）；Drive 刪除需用戶 Google 授權（service account 唔可以刪用戶個人 Drive 嘅檔案）。

## 參考資料
- `docs/open-card.md`：**開盤睇盤流程卡 V1.0**（點樣用每日三份報告：行動卡／本體報告／核對附錄、盤前三分鐘盤中零閱讀收市後十分鐘、三道閘、常見錯誤）。原檔 `docs/open-card-V1.0-PANW-2026-10-06.pdf`。用戶會就呢份資料跟進，處理相關問題前請先讀。
