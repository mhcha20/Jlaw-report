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
const detectCat = n => /每日跨股總表/.test(n) ? "daily" : /行動卡/.test(n) ? "card" : /核對附錄|核實/.test(n) ? "verify" : /股票分析|個股/.test(n) ? "stock" : /大盤/.test(n) ? "market" : "";
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
  json(res, 200, {row: [cat, f.id, f.name.replace(/\.pdf$/i, ""), f.createdTime, Number(f.size) || buf.length]});
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
