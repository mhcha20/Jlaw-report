const http = require("http"), fs = require("fs"), path = require("path");
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
      fields: "nextPageToken,files(id,name,mimeType,createdTime)", ...(token && {pageToken: token}),
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
    else if (f.mimeType === "application/pdf") rows.push([catOf(f.name, cat), f.id, f.name.replace(/\.pdf$/i, ""), f.createdTime]);
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

http.createServer(async (req, res) => {
  const p = req.url.split("?")[0];
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
