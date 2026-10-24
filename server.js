const http = require("http"), fs = require("fs"), path = require("path"), crypto = require("crypto");
const types = {".html":"text/html; charset=utf-8",".js":"text/javascript; charset=utf-8"};
const files = ["index.html","data.js"];

// ---- Drive 同步 ----
const KEY = process.env.DRIVE_API_KEY;
const ROOTS = [
  {id:"1AeIL4vlhY5dqij_wtIF9paB0-cadqowE", cat:"other"},   // 根目錄 PDF：每日跨股總表以外歸「其他」
  {id:"18yWn2hUykKaKru44HavWutfUST9Dux6_", cat:"market"},
];
const SUBFOLDER_CAT = {"行動卡":"card", "個股研究報告":"stock", "核實報告":"verify"};
const catOf = (name, fallback) => /每日跨股總表/.test(name) ? "daily" : fallback;

const seed = () => [...fs.readFileSync(path.join(__dirname,"data.js"),"utf8").matchAll(/\["(\w+)","([\w-]+)"/g)].map(m => m[2]);
let known = new Set(seed());
let cache = null; // {at, rows}

async function list(folderId) {
  const out = []; let token = "";
  do {
    const u = new URL("https://www.googleapis.com/drive/v3/files");
    u.search = new URLSearchParams({
      q: `'${folderId}' in parents and trashed=false`, key: KEY, pageSize: "1000",
      fields: "nextPageToken,files(id,name,mimeType,createdTime,size)", ...(token && {pageToken: token}),
    });
    const r = await fetch(u);
    if (!r.ok) throw new Error("Drive API " + r.status + " " + (await r.text()).slice(0, 200));
    const j = await r.json(); out.push(...j.files); token = j.nextPageToken || "";
  } while (token);
  return out;
}
async function walk(folderId, cat, rows) {
  for (const f of await list(folderId)) {
    if (f.mimeType === "application/vnd.google-apps.folder") await walk(f.id, SUBFOLDER_CAT[f.name] || "other", rows);
    else if (f.mimeType === "application/pdf") rows.push([catOf(f.name, cat), f.id, f.name.replace(/\.pdf$/i, ""), f.createdTime, Number(f.size) || 0]);
  }
}
async function sync(force) {
  if (!KEY) { const e = new Error("DRIVE_API_KEY not set"); e.code = 503; throw e; }
  if (!force && cache && Date.now() - cache.at < 30000) return cache.rows;
  const rows = [];
  for (const r of ROOTS) await walk(r.id, r.cat, rows);
  // 同名檔案（重複上載）只留最新一份
  const byName = new Map();
  for (const r of rows) { const o = byName.get(r[2] + "|" + r[0]); if (!o || r[3] > o[3]) byName.set(r[2] + "|" + r[0], r); }
  const uniq = [...byName.values()];
  if (!uniq.length) throw new Error("Drive 回傳 0 份報告，保留現有清單");
  cache = {at: Date.now(), rows: uniq};
  uniq.forEach(r => known.add(r[1]));
  return uniq;
}

// 只轉接已知清單內嘅 Drive 公開 PDF
async function pdf(id, res) {
  if (!known.has(id)) { try { await sync(); } catch (e) {} }
  if (!known.has(id)) { res.writeHead(404); return res.end("Not found"); }
  try {
    const r = await fetch(`https://drive.usercontent.google.com/download?id=${encodeURIComponent(id)}&export=download&confirm=t`);
    const buf = Buffer.from(await r.arrayBuffer());
    if (!r.ok || buf.slice(0,4).toString() !== "%PDF") throw new Error("drive " + r.status);
    res.writeHead(200, {"Content-Type":"application/pdf","Content-Length":buf.length,"Cache-Control":"public, max-age=300"});
    res.end(buf);
  } catch (e) {
    console.error("pdf fetch failed", id, e.message);
    res.writeHead(502); res.end("Drive fetch failed");
  }
}

const json = (res, code, body) => { res.writeHead(code, {"Content-Type":"application/json; charset=utf-8","Cache-Control":"no-store"}); res.end(JSON.stringify(body)); };


// ---- 管理：隱藏 / 刪除（需 ADMIN_PASSWORD）----
const ADMIN = process.env.ADMIN_PASSWORD || "";
const DATA_DIR = process.env.DATA_DIR || (fs.existsSync("/data") ? "/data" : __dirname);
const STATE_FILE = path.join(DATA_DIR, "state.json");
const vis = {hidden: new Set(), deleted: new Set()};
try { const j = JSON.parse(fs.readFileSync(STATE_FILE, "utf8")); vis.hidden = new Set(j.hidden || []); vis.deleted = new Set(j.deleted || []); } catch (e) {}
function saveVis() {
  const tmp = STATE_FILE + ".tmp";
  fs.writeFileSync(tmp, JSON.stringify({hidden: [...vis.hidden], deleted: [...vis.deleted]}));
  fs.renameSync(tmp, STATE_FILE);
}
const fails = new Map(); // ip -> [timestamps]
function authed(req) {
  const ip = (req.headers["x-forwarded-for"] || req.socket.remoteAddress || "").split(",")[0].trim();
  const now = Date.now(), recent = (fails.get(ip) || []).filter(t => now - t < 600000);
  if (recent.length >= 5) return 429;
  const given = Buffer.from(String(req.headers["x-admin-password"] || ""));
  const want = Buffer.from(ADMIN);
  const ok = ADMIN && given.length === want.length && crypto.timingSafeEqual(given, want);
  if (!ok) { recent.push(now); fails.set(ip, recent); return 401; }
  return 200;
}
function body(req) {
  return new Promise((resolve, reject) => {
    let n = 0; const chunks = [];
    req.on("data", c => { n += c.length; if (n > 65536) { reject(new Error("too large")); req.destroy(); } else chunks.push(c); });
    req.on("end", () => { try { resolve(JSON.parse(Buffer.concat(chunks).toString() || "{}")); } catch (e) { reject(e); } });
  });
}
// Service account（GOOGLE_SA_JSON）用嚟將檔案移到 Drive 垃圾桶
let saTok = null;
async function saToken() {
  if (saTok && saTok.exp > Date.now() + 60000) return saTok.v;
  const raw = process.env.GOOGLE_SA_JSON;
  if (!raw) { const e = new Error("未連接 Google，無法刪除（請喺管理模式撳「連接 Google」）"); e.code = 503; throw e; }
  const sa = JSON.parse(raw.trim().startsWith("{") ? raw : Buffer.from(raw, "base64").toString());
  const b64 = o => Buffer.from(JSON.stringify(o)).toString("base64url");
  const now = Math.floor(Date.now() / 1000);
  const unsigned = b64({alg: "RS256", typ: "JWT"}) + "." + b64({iss: sa.client_email, scope: "https://www.googleapis.com/auth/drive", aud: "https://oauth2.googleapis.com/token", iat: now, exp: now + 3600});
  const sig = crypto.createSign("RSA-SHA256").update(unsigned).sign(sa.private_key, "base64url");
  const r = await fetch("https://oauth2.googleapis.com/token", {method: "POST", headers: {"Content-Type": "application/x-www-form-urlencoded"},
    body: new URLSearchParams({grant_type: "urn:ietf:params:oauth:grant-type:jwt-bearer", assertion: unsigned + "." + sig})});
  const j = await r.json();
  if (!r.ok) throw new Error("Google 授權失敗：" + (j.error_description || j.error));
  saTok = {v: j.access_token, exp: Date.now() + j.expires_in * 1000};
  return saTok.v;
}
async function trash(id) {
  const r = await fetch(`https://www.googleapis.com/drive/v3/files/${encodeURIComponent(id)}?supportsAllDrives=true&fields=id,trashed`, {
    method: "PATCH", headers: {Authorization: "Bearer " + await bearer(), "Content-Type": "application/json"}, body: JSON.stringify({trashed: true})});
  if (!r.ok) throw new Error("Drive " + r.status + " " + (await r.text()).slice(0, 160));
}
const visJson = () => ({hidden: [...vis.hidden], deleted: [...vis.deleted]});

// ---- Google 授權（你本人帳戶）：上傳 + 刪除 ----
const G_ID = process.env.GOOGLE_CLIENT_ID || "", G_SECRET = process.env.GOOGLE_CLIENT_SECRET || "";
const TOKEN_FILE = path.join(DATA_DIR, "google-token.json");
let refreshToken = process.env.GOOGLE_REFRESH_TOKEN || (() => { try { return JSON.parse(fs.readFileSync(TOKEN_FILE, "utf8")).refresh_token || ""; } catch (e) { return ""; } })();
let userTok = null;
const oauthStates = new Map(); // state -> expiry
const googleConnected = () => !!(G_ID && G_SECRET && refreshToken);
async function userToken() {
  if (userTok && userTok.exp > Date.now() + 60000) return userTok.v;
  const r = await fetch("https://oauth2.googleapis.com/token", {method: "POST", headers: {"Content-Type": "application/x-www-form-urlencoded"},
    body: new URLSearchParams({grant_type: "refresh_token", refresh_token: refreshToken, client_id: G_ID, client_secret: G_SECRET})});
  const j = await r.json();
  if (!r.ok) { userTok = null; throw new Error("Google 授權失敗：" + (j.error_description || j.error) + "（請重新連接 Google）"); }
  userTok = {v: j.access_token, exp: Date.now() + j.expires_in * 1000};
  return userTok.v;
}
const bearer = async () => googleConnected() ? userToken() : saToken();
const redirectUri = req => `${(req.headers["x-forwarded-proto"] || "http").split(",")[0]}://${(req.headers["x-forwarded-host"] || req.headers.host).split(",")[0]}/oauth/callback`;

const FOLDER_BY_CAT = {
  card: "1k0bxCss7lazu5Ozq6FX1oKUt-qbv5ZtU", stock: "1kIGilWMZYxBvfBpKbxOTVE8kJ4a_MnEb", verify: "1uVDlxdVLhrA6PWB-EsR5wRcPPskXTAog",
  market: "18yWn2hUykKaKru44HavWutfUST9Dux6_", daily: "1AeIL4vlhY5dqij_wtIF9paB0-cadqowE",
};
const detectCat = n => /每日跨股總表/.test(n) ? "daily" : /大盤/.test(n) ? "market" : /行動卡/.test(n) ? "card" : /核對附錄|核實/.test(n) ? "verify" : /股票分析|個股/.test(n) ? "stock" : /大盤/.test(n) ? "market" : "";
function rawBody(req, max) {
  return new Promise((resolve, reject) => {
    let n = 0; const chunks = [];
    req.on("data", c => { n += c.length; if (n > max) { reject(Object.assign(new Error("檔案太大（上限 " + (max >> 20) + "MB）"), {code: 413})); req.destroy(); } else chunks.push(c); });
    req.on("end", () => resolve(Buffer.concat(chunks))); req.on("error", reject);
  });
}
async function upload(req, res, url) {
  if (!googleConnected()) return json(res, 503, {error: "未連接 Google（上傳需要你嘅 Google 授權）"});
  const name = (url.searchParams.get("name") || "").replace(/[\\/\r\n]/g, "_").trim();
  if (!/\.pdf$/i.test(name)) return json(res, 400, {error: "只可以上傳 PDF"});
  let cat = url.searchParams.get("cat") || "auto"; if (cat === "auto") cat = detectCat(name);
  if (!FOLDER_BY_CAT[cat]) return json(res, 400, {error: "無法判斷類型，請手動揀選類型"});
  let buf; try { buf = await rawBody(req, 30 << 20); } catch (e) { return json(res, e.code || 400, {error: e.message}); }
  if (buf.slice(0, 4).toString() !== "%PDF") return json(res, 400, {error: "唔係有效嘅 PDF 檔案"});
  const tok = await userToken(), boundary = "jl" + crypto.randomBytes(8).toString("hex");
  const meta = JSON.stringify({name, parents: [FOLDER_BY_CAT[cat]]});
  const payload = Buffer.concat([Buffer.from(`--${boundary}\r\nContent-Type: application/json; charset=UTF-8\r\n\r\n${meta}\r\n--${boundary}\r\nContent-Type: application/pdf\r\n\r\n`), buf, Buffer.from(`\r\n--${boundary}--`)]);
  const r = await fetch("https://www.googleapis.com/upload/drive/v3/files?uploadType=multipart&supportsAllDrives=true&fields=id,name,createdTime,size", {
    method: "POST", headers: {Authorization: "Bearer " + tok, "Content-Type": "multipart/related; boundary=" + boundary}, body: payload});
  if (!r.ok) return json(res, 502, {error: "Drive " + r.status + " " + (await r.text()).slice(0, 160)});
  const f = await r.json();
  // 令 PDF 可經連結查看（與現有報告一致），失敗唔影響上傳
  try { await fetch(`https://www.googleapis.com/drive/v3/files/${f.id}/permissions?supportsAllDrives=true`, {method: "POST", headers: {Authorization: "Bearer " + tok, "Content-Type": "application/json"}, body: JSON.stringify({role: "reader", type: "anyone"})}); } catch (e) {}
  known.add(f.id); cache = null;
  // replace=1：上載成功後，將同一資料夾內同名嘅舊檔放入垃圾桶（排程 worker 冇 Drive 連接器／管理員 header 只喺上載路徑生效，所以喺呢度做；垃圾桶可還原）
  const replaced = [];
  if (url.searchParams.get("replace") === "1") {
    try {
      const q = new URLSearchParams({q: `name = '${name.replace(/\\/g, "\\\\").replace(/'/g, "\\'")}' and '${FOLDER_BY_CAT[cat]}' in parents and trashed = false`, fields: "files(id)", supportsAllDrives: "true", includeItemsFromAllDrives: "true"});
      const lr = await fetch("https://www.googleapis.com/drive/v3/files?" + q, {headers: {Authorization: "Bearer " + tok}});
      if (lr.ok) for (const o of (await lr.json()).files || []) if (o.id !== f.id) { try { await trash(o.id); vis.deleted.add(o.id); known.delete(o.id); replaced.push(o.id); } catch (e) { console.error("replace trash failed", o.id, e.message); } }
      if (replaced.length) saveVis();
    } catch (e) { console.error("replace failed", e.message); }
  }
  json(res, 200, {row: [cat, f.id, f.name.replace(/\.pdf$/i, ""), f.createdTime, Number(f.size) || buf.length], replaced});
}
async function oauth(req, res, p, url) {
  if (p === "/api/oauth/url") {
    if (req.method !== "POST") return json(res, 405, {error: "method"});
    if (!ADMIN) return json(res, 503, {error: "未設定 ADMIN_PASSWORD"});
    const a = authed(req); if (a !== 200) return json(res, a, {error: a === 429 ? "嘗試太多次，請稍後再試" : "密碼錯誤"});
    if (!G_ID || !G_SECRET) return json(res, 503, {error: "未設定 GOOGLE_CLIENT_ID / GOOGLE_CLIENT_SECRET"});
    const state = crypto.randomBytes(16).toString("hex"); oauthStates.set(state, Date.now() + 600000);
    const u = new URL("https://accounts.google.com/o/oauth2/v2/auth");
    u.search = new URLSearchParams({client_id: G_ID, redirect_uri: redirectUri(req), response_type: "code", scope: "https://www.googleapis.com/auth/drive", access_type: "offline", prompt: "consent", state});
    return json(res, 200, {url: u.toString(), redirectUri: redirectUri(req)});
  }
  // /oauth/callback
  const state = url.searchParams.get("state"), code = url.searchParams.get("code");
  const exp = oauthStates.get(state); oauthStates.delete(state);
  const page = (msg, ok) => { res.writeHead(ok ? 302 : 400, ok ? {Location: "/?google=ok"} : {"Content-Type": "text/plain; charset=utf-8"}); res.end(ok ? "" : msg); };
  if (!exp || exp < Date.now() || !code) return page("授權已過期或無效，請返回網頁重新撳「連接 Google」。", false);
  const r = await fetch("https://oauth2.googleapis.com/token", {method: "POST", headers: {"Content-Type": "application/x-www-form-urlencoded"},
    body: new URLSearchParams({grant_type: "authorization_code", code, client_id: G_ID, client_secret: G_SECRET, redirect_uri: redirectUri(req)})});
  const j = await r.json();
  if (!r.ok || !j.refresh_token) return page("Google 授權失敗：" + (j.error_description || j.error || "沒有取得 refresh token（請移除舊授權後重試）"), false);
  refreshToken = j.refresh_token; userTok = null;
  fs.writeFileSync(TOKEN_FILE, JSON.stringify({refresh_token: refreshToken}), {mode: 0o600});
  page("", true);
}

// ---- 覆蓋檢查：讀取你嘅 Google Sheet（第一個分頁）----
const SHEET_ID = process.env.SHEET_ID || "1da207nad2cL2hN4vRLNtsOt2UXwgVTzMvoXS3VF98Fw";
let sheetCache = null;
async function sheetCsv(req, res) {
  if (!ADMIN) return json(res, 503, {error: "未設定 ADMIN_PASSWORD"});
  const a = authed(req); if (a !== 200) return json(res, a, {error: a === 429 ? "嘗試太多次，請稍後再試" : "密碼錯誤"});
  if (!googleConnected()) return json(res, 503, {error: "未連接 Google（請喺管理模式撳「連接 Google」）"});
  if (sheetCache && Date.now() - sheetCache.at < 60000) return json(res, 200, {csv: sheetCache.csv, at: sheetCache.at});
  const r = await fetch(`https://www.googleapis.com/drive/v3/files/${SHEET_ID}/export?mimeType=text/csv`, {headers: {Authorization: "Bearer " + await userToken()}});
  if (!r.ok) return json(res, 502, {error: "讀取表格失敗：Drive " + r.status + " " + (await r.text()).slice(0, 160)});
  sheetCache = {at: Date.now(), csv: await r.text()};
  json(res, 200, {csv: sheetCache.csv, at: sheetCache.at});
}

// ---- 買賣訊號：由「行動卡」PDF 自動抽取（背景處理，結果存 /data/signals.json）----
const signals = require("./signals.js");
const SIG_FILE = path.join(DATA_DIR, "signals.json");
let sig = {cards: {}, fail: {}};
try { sig = {cards: {}, fail: {}, ...JSON.parse(fs.readFileSync(SIG_FILE, "utf8"))}; } catch (e) {}
const sigState = {running: false, pending: 0, done: 0, err: "", lastRun: 0};
const nameDate = n => { const m = n.match(/\d{4}-\d{2}-\d{2}/) || n.match(/(?<!\d)20\d{6}(?!\d)/); return m ? (m[0].includes("-") ? m[0] : m[0].replace(/^(\d{4})(\d{2})(\d{2})$/, "$1-$2-$3")) : ""; };
const nameTicker = n => n.replace(/\d{4}-\d{2}-\d{2}|(?<!\d)20\d{6}(?!\d)/, " ").split(/[_\s\-()\[\]]+/).find(t => /^(?:[A-Z]{1,5}|\d{4,6})$/.test(t)) || "";
async function driveBuffer(id) {
  const r = await fetch(`https://drive.usercontent.google.com/download?id=${encodeURIComponent(id)}&export=download&confirm=t`);
  const buf = Buffer.from(await r.arrayBuffer());
  if (!r.ok || buf.slice(0, 4).toString() !== "%PDF") throw new Error("drive " + r.status);
  return buf;
}
function saveSig() { const tmp = SIG_FILE + ".tmp"; fs.writeFileSync(tmp, JSON.stringify(sig)); fs.renameSync(tmp, SIG_FILE); }
function allCards(rows) {   // 所有行動卡（新→舊）；同一股票同一日只取最新上傳
  const seen = new Map();
  for (const r of rows.filter(x => x[0] === "card")) {
    const date = nameDate(r[2]), ticker = nameTicker(r[2]); if (!date || !ticker) continue;
    const k = ticker + "|" + date, o = seen.get(k);
    if (!o || r[3] > o.up) seen.set(k, {id: r[1], name: r[2], up: r[3], size: r[4], date, ticker});
  }
  return [...seen.values()].sort((a, b) => b.date.localeCompare(a.date) || b.up.localeCompare(a.up));
}
function latestCards(rows) {
  const by = new Map();
  for (const r of rows.filter(x => x[0] === "card")) {
    const date = nameDate(r[2]), ticker = nameTicker(r[2]);
    if (!date || !ticker) continue;
    (by.get(ticker) || by.set(ticker, []).get(ticker)).push({id: r[1], name: r[2], up: r[3], size: r[4], date, ticker});
  }
  return [...by.entries()].map(([t, l]) => ({ticker: t, cards: l.sort((a, b) => b.date.localeCompare(a.date) || b.up.localeCompare(a.up)).slice(0, 2)}));
}
// ---- 行情（開市價／收市價）：用嚟模擬「訊號後下一個交易日開市價成交」----
const priceLib = require("./prices.js");
const PX_FILE = path.join(DATA_DIR, "prices.json");
const ohlcvCache = new Map();
const OHLC_DIR = path.join(DATA_DIR, "ohlcv");
// Yahoo 有時過咗 UTC 午夜就唔再回傳前一日嘅日線 → 本地保存已見過嘅日線（按日期合併，新值覆蓋舊值），每根記 fa＝最後一次攞到嗰刻
function mergeOhlcv(t, rows) {
  try { fs.mkdirSync(OHLC_DIR, {recursive: true}); } catch {}
  const f = path.join(OHLC_DIR, t + ".json"), now = new Date().toISOString(); let old = [];
  try { old = JSON.parse(fs.readFileSync(f, "utf8")); } catch {}
  const m = new Map(old.map(r => [r.d, r])); for (const r of rows) m.set(r.d, {...r, fa: now});
  const out = [...m.values()].sort((a, b) => a.d < b.d ? -1 : 1).slice(-800);
  try { fs.writeFileSync(f, JSON.stringify(out)); } catch (e) { console.error("ohlcv save failed", e.message); }
  return out;
}
let px = {t: {}};
try { px = {t: {}, ...JSON.parse(fs.readFileSync(PX_FILE, "utf8"))}; } catch (e) {}
const pxState = {running: false};
function savePx() { const tmp = PX_FILE + ".tmp"; fs.writeFileSync(tmp, JSON.stringify(px)); fs.renameSync(tmp, PX_FILE); }
async function pxRefresh() {
  if (pxState.running) return;
  pxState.running = true;
  try {
    const tickers = [...new Set(Object.values(sig.cards).map(c => c.ticker).filter(Boolean))];
    for (const t of tickers) {
      const e = px.t[t];
      if (e && Date.now() - e.at < 3 * 3600e3) continue;
      try { const r = await priceLib.fetchBars(t); px.t[t] = {at: Date.now(), src: r.src, rows: r.rows.map(b => [b.d, b.o, b.c])}; }
      catch (err) { console.error("price fetch failed", t, err.message); px.t[t] = {rows: [], ...(e || {}), at: Date.now() - 170 * 60e3, err: err.message}; }   // 失敗 10 分鐘後再試
      await new Promise(r => setTimeout(r, 300));
    }
    savePx();
  } catch (e) { console.error("pxRefresh failed", e.message); }
  finally { pxState.running = false; }
}
const barsOf = t => ((px.t[t] && px.t[t].rows) || []).map(r => ({d: r[0], o: r[1], c: r[2]}));

async function sigIndex() {
  if (sigState.running) return;
  sigState.running = true; sigState.err = ""; sigState.done = 0;
  try {
    const rows = await sync(false);
    const todo = allCards(rows).filter(c => (!sig.cards[c.id] || sig.cards[c.id].pv !== signals.VERSION || (c.size && sig.cards[c.id].size && String(sig.cards[c.id].size) !== String(c.size))) && !(sig.fail[c.id] && Date.now() - sig.fail[c.id].at < 3600e3));   // 解析規則升版後會重讀舊卡
    sigState.pending = todo.length;
    let next = 0;
    const worker = async () => {
      while (next < todo.length) {
        const c = todo[next++];
        try {
          const text = await signals.pdfText(await driveBuffer(c.id));
          const p = signals.parseCard(text, c.date);
          if (!p.date && !p.rating) throw new Error("讀唔到行動卡內容");
          sig.cards[c.id] = {id: c.id, name: c.name, ticker: c.ticker, fileDate: c.date, up: c.up, size: c.size, ...p, cls: signals.classify(p), pv: signals.VERSION, at: Date.now()};
          delete sig.fail[c.id];
        } catch (e) { console.error("signal parse failed", c.name, e.message); sig.fail[c.id] = {at: Date.now(), error: e.message}; }
        sigState.done++; sigState.pending = todo.length - sigState.done;
        if (sigState.done % 5 === 0) saveSig();
      }
    };
    await Promise.all([worker(), worker(), worker()]);
    saveSig();
  } catch (e) { sigState.err = e.code === 503 ? "未設定 DRIVE_API_KEY" : e.message; console.error("signal index failed", e.message); }
  finally { sigState.running = false; sigState.pending = 0; sigState.lastRun = Date.now(); pxRefresh(); }
}
function sigPayload() {
  // 以已解析（永久保存）嘅卡為準：Drive 檔案日後被刪，歷史都仍然喺度
  const history = signals.buildHistory(Object.values(sig.cards));
  const rows = [], feed = [];
  for (const [ticker, list] of Object.entries(history)) {
    const last = list[list.length - 1], rec = sig.cards[last.id], cls = signals.classify(rec);
    const prevScore = rec.prevScore ?? (list.length > 1 ? list[list.length - 2].score : undefined);
    const lastTag = k => { for (let i = list.length - 1; i >= 0; i--) if (list[i].tag === k || list[i].tag === "mixed") return list[i].date; return ""; };
    rows.push({ticker, id: rec.id, name: rec.name, date: last.date, up: rec.up, stars: rec.stars, rating: rec.rating, score: rec.score, prevScore, market: rec.market, cap: rec.cap,
      headline: rec.headline, flat: rec.flat, held: rec.held, gates: rec.gates, close: rec.close, levels: rec.levels, alerts: (rec.alerts || []).slice(0, 8), cls,
      lastBuy: lastTag("buy"), lastSell: lastTag("sell"), days: list.length});
    list.forEach(e => { if (e.tag) feed.push({ticker, date: e.date, tag: e.tag, id: e.id, changes: e.changes.filter(c => c.k !== "level" && c.k !== "market").slice(0, 3)}); });
  }
  feed.sort((a, b) => b.date.localeCompare(a.date) || a.ticker.localeCompare(b.ticker));
  const files = cache ? new Set(allCards(cache.rows).map(c => c.ticker)).size : rows.length;
  const failedIds = Object.keys(sig.fail).filter(i => !sig.cards[i]).length;
  const bt = {};
  for (const [t, l] of Object.entries(history)) { bt[t] = signals.backtest(l, barsOf(t)); if (!bt[t].hasPrices && px.t[t] && px.t[t].err) bt[t].pxErr = px.t[t].err; }
  return {rows, history, bt, feed: feed.slice(0, 40), total: Math.max(files, rows.length), failed: failedIds, pending: sigState.pending, running: sigState.running, err: sigState.err, lastRun: sigState.lastRun,
    px: {have: Object.values(px.t).filter(e => e.rows && e.rows.length).length, failed: Object.values(px.t).filter(e => !(e.rows && e.rows.length)).length,
      src: [...new Set(Object.values(px.t).map(e => e.src).filter(Boolean))].join("/"), lastErr: (Object.values(px.t).find(e => e.err && !(e.rows && e.rows.length)) || {}).err || ""}};
}
if (KEY) { setTimeout(() => sigIndex(), 20000); setInterval(() => sigIndex(), 30 * 60 * 1000); }
async function sigApi(req, res) {
  // 公開唯讀；「重新分析」(refresh=1) 只限管理員，避免被人不斷觸發
  const force = new URL(req.url, "http://x").searchParams.get("refresh") === "1";
  if (force) {
    if (!ADMIN) return json(res, 503, {error: "未設定 ADMIN_PASSWORD"});
    const a = authed(req); if (a !== 200) return json(res, a, {error: a === 429 ? "嘗試太多次，請稍後再試" : "密碼錯誤"});
    Object.values(px.t).forEach(e => { e.at = 0; });
    sig.fail = {};   // 重新分析：失敗過嘅卡即刻再試
  }
  if (!sigState.running && (force || Date.now() - sigState.lastRun > 60000)) { await Promise.race([sigIndex(), new Promise(r => setTimeout(r, 4000))]); }
  json(res, 200, sigPayload());
}

// ---- 群友對照（私人 Drive 資料夾，需 ADMIN_PASSWORD；唔入買賣訊號／回測）----
const peersLib = require("./peers.js");
const PEERS_FILE = path.join(DATA_DIR, "peers.json");
const PEER_ROOT = "1jAs8B7c3nbQlUbbBisnzZw_X4aHm8lGO";
const PEER_FOLDER_KIND = {"1Pr3L2BsRNphAr3Z5IhA41Tuk7bBji-KW": "card", "11kdZ_vCO3luCVBRENlVVMqWkKVK23VaO": "stock", "11pwIinVx2EdbYYEAfqwcwceM89TDctrh": "verify"};
const peerKindOfFolder = (id, name) => PEER_FOLDER_KIND[id] || (/行動卡/.test(name) ? "card" : /核實|核對/.test(name) ? "verify" : /個股|本體|研究/.test(name) ? "stock" : "");
let peers = {files: {}, owners: {}, ownersAt: 0, ownersErr: "", fail: {}};
try { peers = {...peers, ...JSON.parse(fs.readFileSync(PEERS_FILE, "utf8"))}; } catch (e) {}
const peerState = {running: false, pending: 0, done: 0, err: "", lastRun: 0};
function savePeers() { const tmp = PEERS_FILE + ".tmp"; fs.writeFileSync(tmp, JSON.stringify(peers)); fs.renameSync(tmp, PEERS_FILE); }
function csvRows(t) {
  const rows = []; let row = [], f = "", q = false;
  for (let i = 0; i < t.length; i++) {
    const c = t[i];
    if (q) { if (c === '"') { if (t[i + 1] === '"') { f += '"'; i++; } else q = false; } else f += c; }
    else if (c === '"') q = true; else if (c === ",") { row.push(f); f = ""; }
    else if (c === "\n") { row.push(f); rows.push(row); row = []; f = ""; } else if (c !== "\r") f += c;
  }
  if (f || row.length) { row.push(f); rows.push(row); }
  return rows;
}
const driveErr = async (what, r) => { const t = (await r.text()).slice(0, 160); return new Error(what + "：Drive " + r.status + (r.status === 401 || r.status === 403 || r.status === 404 ? "（授權過期、未授權或資料夾唔存在，請喺管理模式重新連接 Google）" : "") + " " + t); };
async function peerList(folderId, tok) {
  const out = []; let pt = "";
  do {
    const q = new URLSearchParams({q: `'${folderId}' in parents and trashed=false`, pageSize: "1000", supportsAllDrives: "true", includeItemsFromAllDrives: "true", fields: "nextPageToken,files(id,name,mimeType,createdTime,modifiedTime,size)", ...(pt && {pageToken: pt})});
    const r = await fetch("https://www.googleapis.com/drive/v3/files?" + q, {headers: {Authorization: "Bearer " + tok}});
    if (!r.ok) throw await driveErr("讀取群友報告資料夾失敗", r);
    const j = await r.json(); out.push(...(j.files || [])); pt = j.nextPageToken || "";
  } while (pt);
  return out;
}
async function peerScan(tok) {
  const out = [], seen = new Set();
  const walk = async (fid, kind, depth) => {
    if (seen.has(fid) || depth > 3) return; seen.add(fid);
    for (const f of await peerList(fid, tok)) {
      if (f.mimeType === "application/vnd.google-apps.folder") await walk(f.id, peerKindOfFolder(f.id, f.name) || kind, depth + 1);
      else if (f.mimeType === "application/pdf" || /\.pdf$/i.test(f.name)) out.push({...f, kind: kind || peersLib.typeFromName(f.name) || "other"});
    }
  };
  await walk(PEER_ROOT, "", 0);
  return out;
}
async function peerDownload(id, tok) {
  const r = await fetch(`https://www.googleapis.com/drive/v3/files/${encodeURIComponent(id)}?alt=media&supportsAllDrives=true`, {headers: {Authorization: "Bearer " + tok}});
  if (!r.ok) throw await driveErr("下載失敗", r);
  const buf = Buffer.from(await r.arrayBuffer());
  if (buf.slice(0, 4).toString() !== "%PDF") throw new Error("唔係 PDF");
  return buf;
}
// 簽到表：欄 A 主題、C 代號、E 負責人（只係認領者）
async function peerOwners(tok) {
  let text;
  if (sheetCache && Date.now() - sheetCache.at < 60000) text = sheetCache.csv;
  else {
    const r = await fetch(`https://www.googleapis.com/drive/v3/files/${SHEET_ID}/export?mimeType=text/csv`, {headers: {Authorization: "Bearer " + tok}});
    if (!r.ok) throw await driveErr("讀取簽到表失敗", r);
    text = await r.text(); sheetCache = {at: Date.now(), csv: text};
  }
  const o = {};
  for (const c of csvRows(text).slice(1)) {
    const tk = (c[2] || "").trim().toUpperCase(); if (!tk || tk === "大盤分析" || tk === "TICKER SYMBOL") continue;
    const k = peersLib.normTicker(tk); if (!o[k]) o[k] = {owner: (c[4] || "").trim(), theme: (c[0] || "").trim()};
  }
  return o;
}
// 行情代號：全數字代號喺表內可能缺前導零，按表內主題補返（港 5 位／韓 6 位／日 4 位）
function peerFetchSym(raw, key) {
  if (!/^\d+$/.test(raw)) return raw;
  const th = ((peers.owners[key] || {}).theme) || "";
  return /港股/.test(th) ? raw.padStart(5, "0") : /韓股/.test(th) ? raw.padStart(6, "0") : /日股/.test(th) ? raw.padStart(4, "0") : raw.length >= 4 ? raw : "";
}
const peerRowsCache = new Map();
async function peerRows(sym, needDate) {
  const c = peerRowsCache.get(sym); if (c && c.need >= needDate) return c.rows;
  const f = path.join(OHLC_DIR, sym + ".json"); let rows = [], age = Infinity;
  try { rows = JSON.parse(fs.readFileSync(f, "utf8")); age = Date.now() - fs.statSync(f).mtimeMs; } catch {}
  const last = rows.length ? rows[rows.length - 1].d : "";
  if (!rows.length || (last < needDate && age > 30 * 60e3) || age > 24 * 3600e3) {
    try { const v = await priceLib.fetchOhlcv(sym, "2y"); rows = mergeOhlcv(sym, v.rows); await new Promise(r => setTimeout(r, 300)); }
    catch (e) { console.error("peers ohlcv failed", sym, e.message); }
  }
  peerRowsCache.set(sym, {need: needDate, rows});
  return rows;
}
async function peersRefresh() {
  if (peerState.running) return;
  peerState.running = true; peerState.err = ""; peerState.done = 0; peerState.pending = 0; peerRowsCache.clear();
  try {
    if (!googleConnected()) throw new Error("未連接 Google（請喺管理模式撳「連接 Google」），讀唔到群友報告資料夾");
    const tok = await userToken();
    try { peers.owners = await peerOwners(tok); peers.ownersAt = Date.now(); peers.ownersErr = ""; } catch (e) { peers.ownersErr = e.message; console.error("peers owners failed", e.message); }   // 簽到表讀唔到：沿用舊負責人
    const list = await peerScan(tok);
    if (!list.length && Object.keys(peers.files).length) throw new Error("群友報告資料夾回傳 0 份 PDF，保留現有清單");
    const next = {};
    for (const f of list) {
      const old = peers.files[f.id], fi = peersLib.fileInfo(f.name);
      next[f.id] = {id: f.id, name: f.name, kind: f.kind, size: Number(f.size) || 0, mt: f.modifiedTime || f.createdTime || "", ticker: fi.ticker, fileDate: fi.date, ...(old && old.err && !old.pv ? {err: old.err} : {}), ...(old && String(old.size) === String(Number(f.size) || 0) && old.pv === peersLib.PV ? {claim: old.claim, textDate: old.textDate, image: old.image, err: old.err, pv: old.pv, at: old.at, titleTicker: old.titleTicker} : {})};
    }
    peers.files = next; peers.fail = Object.fromEntries(Object.entries(peers.fail || {}).filter(([id]) => next[id]));
    const todo = Object.values(next).filter(r => r.kind === "card" && r.pv !== peersLib.PV && !(peers.fail[r.id] && Date.now() - peers.fail[r.id] < 3600e3));
    peerState.pending = todo.length; let n = 0;
    const worker = async () => {
      while (n < todo.length) {
        const r = todo[n++];
        try {
          const p = await peersLib.parseCard(await peerDownload(r.id, tok), r.fileDate);
          r.pv = peersLib.PV; r.at = Date.now(); r.image = !!p.image; r.textDate = p.date || ""; r.titleTicker = p.titleTicker || "";
          r.claim = p.image ? null : Object.fromEntries(Object.entries(p).filter(([k]) => !["date", "textLen", "titleTicker", "image"].includes(k)));
          delete r.err; delete peers.fail[r.id];
        } catch (e) { console.error("peer parse failed", r.name, e.message); peers.fail[r.id] = Date.now(); r.err = e.message; }
        peerState.done++; peerState.pending = todo.length - peerState.done;
        if (peerState.done % 5 === 0) savePeers();
      }
    };
    await Promise.all([worker(), worker(), worker()]);
    // 核對（每次都重算：行情會更新）
    for (const r of Object.values(next)) {
      if (r.kind !== "card") continue;
      r.ticker = r.ticker || r.titleTicker || ""; r.date = r.fileDate || r.textDate || "";
      if (!r.claim || !r.ticker || !r.date) { delete r.v; continue; }
      const key = peersLib.normTicker(r.ticker), sym = peerFetchSym(r.ticker, key);
      try { r.v = peersLib.verifyCard({...r.claim, adjHint: r.claim.adjHint}, sym ? await peerRows(sym, r.date) : [], r.date); if (!sym) r.v.note = "未能核對（短數字代號，表內冇對應市場）"; }
      catch (e) { r.v = {close: {st: "unk"}, sma: {st: "na", items: []}, vol: {st: "na"}, lag: false, verdict: "unk", note: "核對出錯：" + e.message}; }
    }
    for (const r of Object.values(next)) if (r.kind !== "card") { r.ticker = r.ticker || ""; r.date = r.fileDate || ""; }
    savePeers();
  } catch (e) { peerState.err = e.message; console.error("peers refresh failed", e.message); }
  finally { peerState.running = false; peerState.pending = 0; peerState.lastRun = Date.now(); }
}
const peersGate = (req, res) => {
  if (!ADMIN) { json(res, 503, {error: "未設定 ADMIN_PASSWORD"}); return false; }
  const a = authed(req); if (a !== 200) { json(res, a, {error: a === 429 ? "嘗試太多次，請稍後再試" : "密碼錯誤"}); return false; }
  return true;
};
if (process.env.PEERS_AUTO !== "0") { setTimeout(() => { if (googleConnected()) peersRefresh(); }, 45000); setInterval(() => { if (googleConnected()) peersRefresh(); }, 6 * 3600e3); }
async function peersApi(req, res, p, url) {
  if (!peersGate(req, res)) return;
  if (p === "/api/peers/refresh") {
    if (req.method !== "POST") return json(res, 405, {error: "method"});
    if (!peerState.running) peersRefresh();
    return json(res, 202, {state: {...peerState}});
  }
  if (p === "/api/peers/pdf") {
    const id = url.searchParams.get("id") || "";
    if (!/^[\w-]{10,80}$/.test(id) || !peers.files[id]) return json(res, 404, {error: "唔係群友報告資料夾內嘅檔案"});
    if (!googleConnected()) return json(res, 503, {error: "未連接 Google"});
    const r = await fetch(`https://www.googleapis.com/drive/v3/files/${encodeURIComponent(id)}?alt=media&supportsAllDrives=true`, {headers: {Authorization: "Bearer " + await userToken()}});
    if (!r.ok || !r.body) throw await driveErr("下載失敗", r);
    res.writeHead(200, {"Content-Type": "application/pdf", "Cache-Control": "private, no-store", ...(r.headers.get("content-length") && {"Content-Length": r.headers.get("content-length")})});
    return require("stream").Readable.fromWeb(r.body).on("error", () => res.destroy()).pipe(res);
  }
  if (req.method !== "GET") return json(res, 405, {error: "method"});
  if (!peerState.running && !peerState.lastRun && googleConnected()) peersRefresh();   // 重啟後第一次打開：自動掃描
  const files = Object.values(peers.files).map(r => ({id: r.id, name: r.name, kind: r.kind, size: r.size, mt: r.mt, ticker: r.ticker, key: peersLib.normTicker(r.ticker), date: r.date || r.fileDate || "", textDate: r.textDate || "",
    owner: (peers.owners[peersLib.normTicker(r.ticker)] || {}).owner || "", signed: !!(peers.owners[peersLib.normTicker(r.ticker)] || {}).owner,
    image: !!r.image, err: r.err || "", parsed: r.claim || null, v: r.v || null}));
  json(res, 200, {files, state: {...peerState}, ownersAt: peers.ownersAt, ownersErr: peers.ownersErr, googleConnected: googleConnected()});
}

async function admin(req, res, p) {
  if (p === "/api/hidden" && req.method === "GET") return json(res, 200, {...visJson(), adminEnabled: !!ADMIN, canDelete: googleConnected() || !!process.env.GOOGLE_SA_JSON, canUpload: googleConnected(), googleReady: !!(G_ID && G_SECRET), googleConnected: googleConnected()});
  if (req.method !== "POST") return json(res, 405, {error: "method"});
  if (!ADMIN) return json(res, 503, {error: "未設定 ADMIN_PASSWORD"});
  const a = authed(req); if (a !== 200) return json(res, a, {error: a === 429 ? "嘗試太多次，請稍後再試" : "密碼錯誤"});
  if (p === "/api/auth") return json(res, 200, {ok: true});
  let b; try { b = await body(req); } catch (e) { return json(res, 400, {error: "bad request"}); }
  const ids = [...new Set((b.ids || []).filter(i => typeof i === "string"))].filter(i => known.has(i));
  if (!ids.length) return json(res, 400, {error: "沒有有效嘅報告"});
  if (p === "/api/hide") {
    ids.forEach(i => b.hidden === false ? vis.hidden.delete(i) : vis.hidden.add(i));
    saveVis(); return json(res, 200, visJson());
  }
  if (p === "/api/delete") {
    const done = [], failed = [];
    for (const id of ids) {
      try { await trash(id); vis.deleted.add(id); vis.hidden.delete(id); known.delete(id); done.push(id); }
      catch (e) { failed.push({id, error: e.message}); if (e.code === 503) break; }
    }
    if (done.length) { cache = null; saveVis(); }
    return json(res, failed.length && !done.length ? (failed[0].error.includes("連接 Google") ? 503 : 502) : 200, {...visJson(), done, failed});
  }
  json(res, 404, {error: "not found"});
}

http.createServer(async (req, res) => {
  const p = req.url.split("?")[0];
  const url = new URL(req.url, "http://x");
  if (p === "/api/upload" && req.method === "POST") {
    if (!ADMIN) return json(res, 503, {error: "未設定 ADMIN_PASSWORD"});
    const a = authed(req); if (a !== 200) return json(res, a, {error: a === 429 ? "嘗試太多次，請稍後再試" : "密碼錯誤"});
    return upload(req, res, url).catch(e => { console.error("upload failed", e.message); json(res, 500, {error: e.message}); });
  }
  if (p === "/api/signals" && req.method === "GET") return sigApi(req, res).catch(e => { console.error("signals failed", e.message); json(res, 500, {error: e.message}); });
  if (p === "/api/ohlcv" && req.method === "GET") {   // 公開唯讀：日線（含成交量）；?t=NVDA&range=2y；30 分鐘快取
    const t = (url.searchParams.get("t") || "").toUpperCase(), range = /^(1y|2y|5y)$/.test(url.searchParams.get("range") || "") ? url.searchParams.get("range") : "2y";
    if (!/^[A-Z0-9]{1,8}$/.test(t)) return json(res, 400, {error: "bad ticker"});
    const k = t + "|" + range, hit = ohlcvCache.get(k);
    if (hit && Date.now() - hit.at < 30 * 60 * 1000) return json(res, 200, hit.v);
    return priceLib.fetchOhlcv(t, range).then(v => { const out = {ticker: t, symbol: v.symbol, rows: range === "2y" ? mergeOhlcv(t, v.rows) : v.rows, at: new Date().toISOString()}; ohlcvCache.set(k, {at: Date.now(), v: out}); json(res, 200, out); }).catch(e => json(res, 502, {error: e.message}));
  }
  if (p === "/api/drive/ls" && req.method === "GET") {   // 公開唯讀：列出連結分享資料夾嘅子項（用 DRIVE_API_KEY），俾排程 worker 唔使 Drive 連接器都可以數截圖
    const fid = url.searchParams.get("folder") || "";
    if (!KEY) return json(res, 503, {error: "DRIVE_API_KEY not set"});
    if (!/^[\w-]{10,60}$/.test(fid)) return json(res, 400, {error: "bad folder id"});
    return (async () => {
      const out = []; let tok = "";
      for (let i = 0; i < 20; i++) {
        const q = new URLSearchParams({q: `'${fid}' in parents and trashed=false`, fields: "nextPageToken,files(id,name,mimeType,createdTime,size)", pageSize: "1000", key: KEY, orderBy: "name"}); if (tok) q.set("pageToken", tok);
        const r = await fetch("https://www.googleapis.com/drive/v3/files?" + q), j = await r.json();
        if (!r.ok) throw new Error((j.error && j.error.message) || ("drive " + r.status));
        out.push(...(j.files || [])); tok = j.nextPageToken || ""; if (!tok) break;
      }
      json(res, 200, {folder: fid, files: out});
    })().catch(e => json(res, 502, {error: e.message}));
  }
  if (p === "/api/peers" || p === "/api/peers/refresh" || p === "/api/peers/pdf") return peersApi(req, res, p, url).catch(e => { console.error("peers failed", e.message); if (!res.headersSent) json(res, 502, {error: e.message}); else res.destroy(); });
  if (p === "/api/sheet" && req.method === "GET") return sheetCsv(req, res).catch(e => { console.error("sheet failed", e.message); json(res, 500, {error: e.message}); });
  if (p === "/api/oauth/url" || p === "/oauth/callback") return oauth(req, res, p, url).catch(e => { console.error("oauth failed", e.message); json(res, 500, {error: e.message}); });
  if (p === "/api/hidden" || p === "/api/auth" || p === "/api/hide" || p === "/api/delete") return admin(req, res, p).catch(e => { console.error("admin failed", e.message); json(res, 500, {error: e.message}); });
  if (p === "/api/sync") {
    try { json(res, 200, {rows: await sync(true)}); }
    catch (e) { console.error("sync failed", e.message); json(res, e.code || 502, {error: e.message}); }
    return;
  }
  const m = p.match(/^\/pdf\/([\w-]+)$/);
  if (m) return pdf(m[1], res);
  const f = p.replace(/^\//, "") || "index.html";
  if (!files.includes(f)) { res.writeHead(404); return res.end("Not found"); }
  res.writeHead(200, {"Content-Type": types[path.extname(f)], "Cache-Control": "no-cache"});
  fs.createReadStream(path.join(__dirname, f)).pipe(res);
}).listen(process.env.PORT || 3000, "0.0.0.0");
