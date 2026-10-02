const http = require("http"), fs = require("fs"), path = require("path");
const types = {".html":"text/html; charset=utf-8",".js":"text/javascript; charset=utf-8"};
const files = ["index.html","data.js"];
http.createServer((req, res) => {
  let f = req.url.split("?")[0].replace(/^\//, "") || "index.html";
  if (!files.includes(f)) { res.writeHead(404); return res.end("Not found"); }
  res.writeHead(200, {"Content-Type": types[path.extname(f)], "Cache-Control": "no-cache"});
  fs.createReadStream(path.join(__dirname, f)).pipe(res);
}).listen(process.env.PORT || 3000, "0.0.0.0");
