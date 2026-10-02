const http = require("http"), fs = require("fs"), path = require("path");
const types = {".html":"text/html; charset=utf-8",".js":"text/javascript; charset=utf-8"};
const files = ["index.html","data.js"];
const ids = () => new Set([...fs.readFileSync(path.join(__dirname,"data.js"),"utf8").matchAll(/\["\w+","([\w-]+)"/g)].map(m => m[1]));

// 只轉接 data.js 清單內嘅 Drive 公開 PDF，其他檔案一律唔會經呢度攞
async function pdf(id, res) {
  if (!ids().has(id)) { res.writeHead(404); return res.end("Not found"); }
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

http.createServer((req, res) => {
  const p = req.url.split("?")[0];
  const m = p.match(/^\/pdf\/([\w-]+)$/);
  if (m) return pdf(m[1], res);
  const f = p.replace(/^\//, "") || "index.html";
  if (!files.includes(f)) { res.writeHead(404); return res.end("Not found"); }
  res.writeHead(200, {"Content-Type": types[path.extname(f)], "Cache-Control": "no-cache"});
  fs.createReadStream(path.join(__dirname, f)).pipe(res);
}).listen(process.env.PORT || 3000, "0.0.0.0");
