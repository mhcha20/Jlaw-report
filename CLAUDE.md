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

## 約定
- 報告檔名：`YYYY-MM-DD_TICKER_類型.pdf`；程式亦兼容 `TICKER-report-YYYY-MM-DD-繁體版`、`TICKER_JLaw_MYT_…_YYYYMMDD` 等格式，日期同股票代號由檔名解析。類型主要由 Drive 資料夾決定。
- 只提交 `server.js`、`index.html`、`data.js`、`package.json`、`docs/`、`CLAUDE.md`。測試用檔案放 scratchpad，唔好入 repo。
- 改動前端後，先用 Playwright（`/opt/pw-browsers/chromium`）以 390px 手機闊度測試。
- 管理功能（上傳／隱藏／刪除／覆蓋檢查）需 `ADMIN_PASSWORD`；Drive 刪除需用戶 Google 授權（service account 唔可以刪用戶個人 Drive 嘅檔案）。

## 參考資料
- `docs/open-card.md`：**開盤睇盤流程卡 V1.0**（點樣用每日三份報告：行動卡／本體報告／核對附錄、盤前三分鐘盤中零閱讀收市後十分鐘、三道閘、常見錯誤）。原檔 `docs/open-card-V1.0-PANW-2026-10-06.pdf`。用戶會就呢份資料跟進，處理相關問題前請先讀。
