# JLaw 報告中心（jlaw-report）

給日後對話嘅項目背景。用戶用廣東話溝通，回覆請用廣東話（繁體）。

## 呢個項目係咩
- 一個網頁：列出兩個 Google Drive 資料夾入面嘅 PDF 報告，可剔選後經 WhatsApp 分享（連結或直接分享 PDF 檔案），可上傳／隱藏／刪除報告，並有「覆蓋檢查」比對股票清單表格同 Drive 報告。
- Drive 資料夾：根目錄 `1AeIL4vlhY5dqij_wtIF9paB0-cadqowE`（每日跨股總表＋子資料夾 行動卡／個股研究報告／核實報告）；大盤分析 `18yWn2hUykKaKru44HavWutfUST9Dux6_`。
- 股票清單 Google Sheet（第一個分頁「個股 research list」）：`1da207nad2cL2hN4vRLNtsOt2UXwgVTzMvoXS3VF98Fw`。

## 技術同部署
- 純 Node（無依賴）：`server.js`（伺服器＋API）、`index.html`（前端，單檔）、`data.js`（報告清單快照，網頁會用 Drive API 同步覆蓋）。
- 部署：Railway project `jlaw-report`（`a358b772-7b5a-4459-8207-17b52019e588`），service `web`（`5b0d435c-c2e9-4374-a2c9-f10772af8b81`），environment `production`（`dfaafb33-e564-40ab-a485-58fba582049b`）。volume `/data` 存隱藏清單同 Google token。公開網址 `jlaw-report-a74806.up.railway.app`。
- `railway.json`：啟動用 `node server.js`（唔經 npm，重新部署時 SIGTERM 正常退出，唔再出「npm error signal SIGTERM」被當 crash）；`watchPatterns` 只限網站檔案，改 `tools/`、`docs/`、`CLAUDE.md` 唔會觸發重新部署。
- Railway 由 GitHub branch `claude/drive-reports-whatsapp-share-6m44wo` 自動部署。若 push 後冇自動重新部署，用 Railway MCP 嘅 `connect-service-source`（同一 repo＋branch）觸發。
- 環境變數（只記名稱，值喺 Railway）：`DRIVE_API_KEY`、`ADMIN_PASSWORD`、`GOOGLE_CLIENT_ID`、`GOOGLE_CLIENT_SECRET`、`GOOGLE_SA_JSON`（已不再需要）、`SHEET_ID`（選填）。Google OAuth redirect URI：`https://jlaw-report-a74806.up.railway.app/oauth/callback`。
- **唔好提交任何密碼、金鑰、token。** repo 係公開嘅。

## 買賣訊號（📊 分頁）
- `signals.js`：用 `pdfjs-dist` 讀「一頁行動卡」PDF 文字，抽取評等／分數／三道閘／今日動作（未持倉、已持倉）／三條價位／警報；`classify()` 按卡內文字機械歸類（零新倉、條件式建倉、三閘全過、觀望；續抱、減倉、離場），**唔係獨立買賣判斷**。
- `server.js`：`GET /api/signals`（**公開唯讀**；`?refresh=1` 重新分析需密碼）背景處理**所有日子**嘅行動卡（每股每日只取最新上傳），每份解析結果永久存 `/data/signals.json`（Drive 檔案日後被刪，歷史仍保留）；已處理過嘅卡唔會重讀（除非 Drive 檔案大小變咗＝原檔被改，或 `signals.js` 嘅 `VERSION` 升版，會用新解析規則重讀全部；改解析規則記得加 `VERSION`）；伺服器每 30 分鐘自動更新一次。`signals.js` 嘅 `diffCards()`／`buildHistory()` 逐日比較，標示 🟢買入訊號（未持倉轉條件式建倉／三閘全過、評等轉買入）同 🔴賣出訊號（已持倉轉減倉／離場、評等跌出買入），並記錄分數、閘、價位、大盤嘅每日變化。`backtest()` 做「每隻 $100」模擬：**訊號喺行動卡日期收市後先出 → 下一個交易日開市價成交**（買入訊號買、賣出訊號全數賣），複利滾存；唔計手續費、滑點；同日買賣並存持倉當賣、未持倉唔買；起始日已係買入狀態亦當買入訊號；持倉中按最新收市價計；下一個交易日未有行情則顯示「待成交」。開市價由 `prices.js` 讀 Yahoo Finance 日線（Stooq 後備；代號對應：字母＝美股、5 位數字＝港股 `.HK`、6 位數字＝韓股 `.KS`、4 位數字＝日股 `.T`／0 開頭港股；NESN、SCHN 歐洲 `.SW`、MC 巴黎 `.PA`、ATD 加拿大 `.TO` 喺 `prices.js` 嘅 `OVERRIDE` 同 `index.html` 嘅 `MKT_OVERRIDE` 手動指定，新增非美股字母代號要兩邊一齊加），存 `/data/prices.json`，每 3 小時更新；攞唔到行情時回測顯示「未攞到行情」而唔會亂計。結果喺 `/api/signals` 嘅 `bt`／`px`，網頁「💰 回測」視圖顯示每筆買賣嘅出訊號日、成交日同價位。網頁喺分析期間每 3 秒輪詢。
- 卡內「分析交易日」若係週六日（例如 10-17 批其實係 10-16 收市），`buildHistory()` 用 `tradingDate()` 退返上一個交易日。
- 行動卡版面變更時要更新 `signals.js` 嘅解析規則（以 `2 今日動作`、`3 三條價位` 等格標題切段）。真實卡文字屬內部資料，測試用文本放 scratchpad，唔好提交入 repo。
- **V2.0 生成器卡標記**：`parseCard()` 嘅 `gen`（`genOf()`）＝`"v2"` 代表本站 `tools/stockreport` 出嘅卡；規則：有「JLaw V2.0 生成器」（`gen.py build_card` 頁尾細字，2026-10-24 起）即係，否則要三個字眼齊全（第 5 格「三個警報價（可入 TradingView）」＋「口徑：距離一律 ÷ 現價」＋「框架 JLaw × MYT V2.0」；Gemini 舊卡都有「框架 JLaw × MYT V2.0」，單一字眼唔算）。比對時先刪晒空白（PDF 會斷行）。`buildHistory()` 每日項目同 `/api/signals` rows 都帶 `gen`。用 Drive 459 張卡測過：50 張 V2.0、Gemini 舊卡 409 張零誤判。
- **只用 V2.0 卡計訊號／回測**（2026-10-24 用戶決定）：`sigPayload()` 嘅 `history`／`rows`／`feed`／`bt` 只由 `gen=v2` 嘅卡建；`historyAll`（全部卡）只供群友對照頁顯示「Gemini 舊卡」。舊卡係之前用 Google Gemini 出，經 `tools/stockreport/audit_cards.py` 抽查：數字約一半錯、10/20 批 66% 落後一日、「四線多頭」81% 唔屬實、分數平均高過日線客觀分 28 分。
- 未有讀取：個股本體報告、核對附錄。

## 群友對照（👥 分頁，獨立，唔入訊號／回測）
- **群友回測**（👥 分頁內「💰 群友回測 $100」）：`peersRefresh()` 尾段 `peersBacktest()` 只用群友報告行動卡（每股每日取最新 `mt`，唔分負責人；`claim.action` 以「未持倉：／已持倉：」切 flat／held，非 /100 分數唔用）行同一套 `buildHistory()`／`backtest()`，行情用 `peerRows`；結果存 `peers.bt`／`btPx`／`btAt`，由 `/api/peers` 回傳，前端 `btHtml(d, {links:false, extra})` 顯示。**同 V2.0 回測完全分開，唔會撈埋**（用戶 2026-10-29 要求）。
- 資料來源：私人 Drive 資料夾「群友報告」`1jAs8B7c3nbQlUbbBisnzZw_X4aHm8lGO`（子資料夾 行動卡_群友／個股研究報告_群友／核實報告_群友），用用戶 Google OAuth token（`userToken()`）讀；簽到表（分頁「個股 research list」欄 C 代號、欄 E 負責人）決定負責人。**簽到只代表認領者，未必係實際製作者**；未簽到歸「未簽到」；全數字代號按數值正規化（66＝00066）。
- **實際製作者補充**：群友報告資料夾根目錄 `負責人補充.txt`（每行 `代號=名字`，`#` 後係備註）由 `peerActual()` 讀，有列嘅股票蓋過簽到表；`/api/peers` 每份檔帶 `ownerSrc`（`actual`／`sign`）同 `signOwner`，前端標「（實際製作）」或「（簽到）」。名字只放 Drive，唔入 repo。用戶話邊個實際做邊隻，就加入呢個檔。簽到表名字同補充檔名字只係大細楷唔同就當同一人（用補充檔寫法）。
- `peers.js`：寬鬆解析行動卡文字（代號、日期、評等、分數＋制式、收市價、成交量、SMA、今日動作摘要）＋`verifyCard()` 對行情核對（容差同 `tools/stockreport/peers.py`）。本體報告／核對附錄只記檔案資訊。改解析規則要升 `PV`。
- API 全部需 `ADMIN_PASSWORD`（內含群友名）：`GET /api/peers`、`POST /api/peers/refresh`、`GET /api/peers/pdf?id=`（只准該資料夾內嘅檔案）。結果存 `/data/peers.json`，每 6 小時自動更新，size 無變嘅卡唔重讀；行情用 `fetchOhlcv`／`mergeOhlcv`（`/data/ohlcv`）。前端 PDF 用 fetch＋blob 開（要帶密碼 header）。
- 每隻股票頂部兩行（取自 `/api/signals` 嘅 `historyAll`）：「Gemini 舊卡（網站最新）」＝最新一張 `gen≠v2` 嘅卡；「V2.0 重算」＝最新一張 `gen=v2`。同名同日檔被 V2.0 取代嘅日子冇 Gemini 舊卡，就顯示前一日嘅 Gemini 舊卡，照實列日期。群友卡旁標「同日比較：…」或「日期唔同（群友 10/16 vs Gemini 舊卡 10/21）」，日期唔同唔可直接比。
- 核對只比對行情數字，唔代表分析對錯。
- **三種卡唔好撈亂**（用戶 2026-10-24 強調）：①群友報告＝群組成員自己做（「群友報告」資料夾，2026-10-24 朝早用戶再加咗 10/22–10/23 嗰批）；②Gemini 舊卡＝之前本站用 Google Gemini 出、放正式資料夾嘅非 V2.0 卡；③V2.0＝本站生成器。群友報告**唔係** Gemini 舊卡，Gemini 嘅抽查數字（`Gemini舊卡抽查報告_2026-10-24.txt`）唔適用於群友報告；群友報告嘅抽查係另一份 `抽查報告_行動卡_2026-10-23.txt`。

## 約定
- 報告檔名：`YYYY-MM-DD_TICKER_類型.pdf`；程式亦兼容 `TICKER-report-YYYY-MM-DD-繁體版`、`TICKER_JLaw_MYT_…_YYYYMMDD` 等格式，日期同股票代號由檔名解析。類型主要由 Drive 資料夾決定。
- 只提交 `server.js`、`index.html`、`data.js`、`peers.js`、`package.json`、`railway.json`、`docs/`、`CLAUDE.md`，同 `tools/stockreport/`（個股報告生成器，只放通用框架；每隻股票嘅分析內容唔提交）。測試用檔案放 scratchpad，唔好入 repo。
- 改動前端後，先用 Playwright（`/opt/pw-browsers/chromium`）以 390px 手機闊度測試。
- 管理功能（上傳／隱藏／刪除／覆蓋檢查／重新分析訊號）需 `ADMIN_PASSWORD`（買賣訊號頁本身公開）；Drive 刪除需用戶 Google 授權（service account 唔可以刪用戶個人 Drive 嘅檔案）。

## 參考資料
- `docs/open-card.md`：**開盤睇盤流程卡 V1.0**（點樣用每日三份報告：行動卡／本體報告／核對附錄、盤前三分鐘盤中零閱讀收市後十分鐘、三道閘、常見錯誤）。原檔 `docs/open-card-V1.0-PANW-2026-10-06.pdf`。用戶會就呢份資料跟進，處理相關問題前請先讀。
- `docs/jw-market-analysis-prompt.md`：**JW 大盤分析指令｜群組共用補充版 V1.0**（每日大盤＋板塊分析嘅完整指令：資料核實規則、SPY／QQQ／IWM、成交量、廣度／VIX、板塊輪動、催化劑、情境、報告格式）。截圖喺 Drive 資料夾 `1M8hNhlePL5MHD-_SvGZlQ02srBHFq_rl`（按日期分子資料夾，檔名 `NN_TICKER_Daily.png`）。用戶要求做大盤分析時按呢份指令執行。
  - **讀截圖要睇圖像，唔好靠 Drive `read_file_content` 嘅文字辨識**（部分圖會回傳空白，亦可能讀錯）。方法：資料夾係連結分享，免登入，用 `curl -sL -o x.png "https://drive.google.com/uc?export=download&id=<fileId>"` 下載到 scratchpad，再用 Read 工具睇（圖約 3806px，Read 會自動縮細）。fileId 用 Drive `search_files`（`parentId = '<日期資料夾id>'`，每頁只回傳約 5 至 15 個，要跟 `nextPageToken`）攞。
  - 圖面右下角嘅 UTC 鐘係**截圖時間，唔係 K 線時間**（10/16 批其實係 10/17 星期六重新截，K 線係星期五最終數據）。DXY、US10Y、GC1! 嘅日線喺截圖時通常未收（有倒數計時）。
  - S&P 500 廣度（S5FI、S5TH）有資料停滯跡象：10/19 圖上兩條線同 10/16 完全相同。引用前要核對。
- **J Law 觀點（私人）**：Drive 資料夾 `1FDeIf6L0B4ZgVeqAl6cWQEcBo5Gu18jQ`（「J Law 觀點（私人）」，唔開連結分享；檔名 `YYYY-MM-DD_JLaw_Update.pdf`＝發布日期）。用戶 send 嚟嘅 J Law Update 用 `drive.py jlaw-upload` 放入去（`/api/upload?cat=jlaw`，唔開分享、唔入公開 /pdf 白名單）；排程大盤報告用 `drive.py jlaw-list／jlaw-get` 讀（借用 `/api/upload?op=jlaw-*`，因為排程 session 只有呢條路徑自動帶管理員密碼），寫入報告「J Law 觀點對照及逐項核實」一節（見 `WORKER_MARKET.md`）。J Law 材料唔好提交入 repo。
- `docs/jlaw-myt-stock-prompt-v2.md`：**JLaw × MYT 股票分析終極指令 V2.0**（個股分析：每隻股出一頁行動卡（固定七格）／10 頁本體報告／核對附錄；分析紀律十條；交易計劃層 R1–R4＋三項落地欄位；每日跨股總表；朗讀稿規範）。「一頁行動卡」嘅版面即係 `signals.js` 解析嘅對象，指令改版時要檢查解析規則（見上面「買賣訊號」），有改動記得升 `VERSION`。用戶要求個股分析時按呢份指令執行。
- `docs/jlaw-method-notes.md`：**J Law 技術分析／交易方法筆記**（由用戶上傳嘅 51 頁 MYT 文件整理：VCP、拉回買入、swing trade、M.E.T.A. 九大優勢、S&R、趨勢線／通道、移動平均線、見頂四訊號、見底八訊號、套牢處理、選股流程）。用戶會就呢份資料跟進，處理相關問題前請先讀。
- `tools/stockreport/`：**V2.0 個股報告生成器**（行動卡／本體報告 9 頁／核對附錄／每日跨股總表），版面照群組 HPE 本體報告範本；九構面＝趨勢、成交量、圖形、Momentum、基本面、市場配合、機構支持、Pullback、Breakout，分數＝星數÷45×100；均量不含當日；雜訊被掃率＝60 日、5 日窗口。用法、spec 欄位、同 `signals.js` 對版嘅行動卡格式約定見該目錄 `README.md`。上載：`POST /api/upload?name=<檔名>.pdf&cat=auto`（檔名含「行動卡／核對附錄／股票分析／每日跨股總表」自動分類）。
