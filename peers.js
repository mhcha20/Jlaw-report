// 群友對照：讀群友「行動卡」PDF 文字（寬鬆解析，讀到咩得咩）並對行情核對。
// 唔係買賣訊號，唔入 signals.js／回測。核對只比對行情數字，唔代表分析對錯。
const {pdfText} = require("./signals.js");

const PV = 1;   // 解析規則版本：改咗解析規則就加 1，伺服器會重讀所有舊卡

const num = s => Number(String(s).replace(/,/g, ""));
const trim = (s, n) => { s = (s || "").replace(/\s+/g, " ").trim(); return s.length > n ? s.slice(0, n - 1) + "…" : s; };

// ---- 檔名 ----
const STOP = new Set(["MYT", "PDF", "JW", "JLAW", "V"]);
function fileInfo(name) {
  const base = String(name || "").replace(/\.pdf$/i, "");
  let date = "", rest = base;
  const m = base.match(/(20\d\d)[-_.](\d{2})[-_.](\d{2})/) || base.match(/(?<!\d)(20\d\d)(\d{2})(\d{2})(?!\d)/);
  if (m && +m[2] >= 1 && +m[2] <= 12 && +m[3] >= 1 && +m[3] <= 31) { date = `${m[1]}-${m[2]}-${m[3]}`; rest = base.replace(m[0], " "); }
  const toks = [...rest.matchAll(/(?<![A-Za-z0-9])([A-Z]{1,5}|\d{4,6})(?![A-Za-z0-9])/g)].map(x => x[1]).filter(t => !STOP.has(t));
  return {ticker: toks[0] || "", date};
}
function typeFromName(name) {
  const n = String(name || "");
  return /每日跨股總表/.test(n) ? "daily" : /行動卡/.test(n) ? "card" : /核對附錄|核實/.test(n) ? "verify" : /本體|分析報告|股票分析|個股|研究/.test(n) ? "stock" : "";
}
// 港／日／韓股代號喺表內可能缺前導零：全數字按數值比對，去掉 .HK 等後綴
const normTicker = t => { t = String(t || "").trim().toUpperCase().replace(/\.(HK|T|KS|KQ|SS|SZ)$/, ""); return /^\d+$/.test(t) ? String(+t) : t; };

// ---- 行動卡文字 ----
const RATING = "(?:強烈)?買入|值得買入|觀察|觀望[/／]?中性|觀望|持有[/／]?觀望|持有|減持|賣出|迴避|中立|不建議|避免交易|轉弱[/／]?暫避|Strong Buy|Buy|Hold|Sell|Neutral|Watch";
const NUM = "(\\d[\\d,]*\\.\\d+|\\d[\\d,]*)";
const DEC = "(\\d[\\d,]*\\.\\d+)(?![\\d%])";
const INDEX_NEAR = /QQQ|SPY|IWM|SMH|SOX|DIA|XL[A-Z]{1,2}\b|大盤|門檻|指數/;
const PRE_BAD = /(QQQ|SPY|IWM|SMH|SOX|VIX|DXY|US10Y|IBIT|BTC|XL[A-Z]{1,2}|大盤|指數|\d{1,2}\/\d{1,2}\s*(?:日|報告|收|開|高|低)?|承襲|重算|上一份|前日|昨日|→|＞|>)\s*[(（:：]?\s*$/;
const okPre = (t, pos) => !PRE_BAD.test(t.slice(Math.max(0, pos - 14), pos));
const mode = vals => {
  if (!vals.length) return null;
  const cnt = new Map(); vals.forEach(v => cnt.set(Math.round(v * 1e4), (cnt.get(Math.round(v * 1e4)) || 0) + 1));
  const best = Math.max(...cnt.values());
  return vals.find(v => cnt.get(Math.round(v * 1e4)) === best);
};
const UNIT = {M: 1e6, "百萬": 1e6, "萬": 1e4, "億": 1e8, K: 1e3};

function parseCardText(raw, fallbackDate) {
  const r = {};
  const lines = String(raw || "").replace(/[⺀-⿟豈-﫿]/g, c => c.normalize("NFKC")).replace(/∕/g, "/").split("\n").map(l => l.replace(/[ \t]+/g, " ").trim());
  const t = lines.join(" ").replace(/\s{2,}/g, " ");
  r.textLen = t.replace(/\s/g, "").length;
  if (r.textLen < 50) { r.image = true; return r; }

  r.date = (t.match(/分析交易日\s*(\d{4}-\d{2}-\d{2})/) || [])[1] || "";
  if (!r.date) { const y = t.match(/交易日[：:]?\s*(\d{4})年(\d{1,2})月(\d{1,2})日/); if (y) r.date = `${y[1]}-${y[2].padStart(2, "0")}-${y[3].padStart(2, "0")}`; }
  if (!r.date) r.date = (t.slice(0, 300).match(/(20\d\d-\d{2}-\d{2})/) || [])[1] || fallbackDate || "";
  r.titleTicker = (t.slice(0, 80).match(/^\s*([A-Z]{1,5}|\d{4,6})\b/) || [])[1] || "";

  // 評等
  const rs = t.match(new RegExp("(★[★☆]{0,4})\\s*(" + RATING + ")")) || t.match(new RegExp("個股評級\\s*([★☆]{1,5})\\s*(" + RATING + ")"));
  if (rs) { r.stars = (rs[1].match(/★/g) || []).length; r.rating = rs[2]; }
  else {
    const m = t.match(new RegExp("(?:評等|評級|Rating)\\s*[:：]?\\s*(" + RATING + ")", "i")); if (m) r.rating = m[1];
    const st = t.match(/(★[★☆]{0,4})/); if (st) r.stars = (st[1].match(/★/g) || []).length;
  }
  // 分數：/100 優先；其他制式標明制式，唔換算
  let m = t.match(/(?<![\d.])(\d{1,3}(?:\.\d+)?)\s*[／/]\s*100(?!\d)/);
  if (m) { r.score = num(m[1]); r.scoreScale = "/100"; }
  else if ((m = t.match(/(?:分數|評分|總分|Score)\s*[:：]?\s*(\d{1,3}(?:\.\d+)?)\s*[／/]\s*(\d{1,3})(?!\d)/i))) { r.score = num(m[1]); r.scoreScale = "/" + m[2]; }

  // 收市價
  const cl = [...t.matchAll(new RegExp("(?<!前)(?:收市價?|今日收|收盤價?)\\s*[:：]?\\s*[$＄]?\\s*" + DEC, "g"))].filter(x => okPre(t, x.index)).map(x => num(x[1]));
  let close = mode(cl);
  if (close === null) {   // 表頭「收市價」下一行
    for (let i = 0; i < lines.length && close === null; i++) {
      if (/^收市價?$/.test(lines[i]) || /收市價\s*$/.test(lines[i])) {
        for (const nx of lines.slice(i + 1, i + 4)) { const mm = nx.match(new RegExp("^[$＄]?\\s*" + DEC)); if (mm) { close = num(mm[1]); break; } }
      }
    }
  }
  if (close === null) {   // 整數收市價（如港股 66）；排除日期
    const ci = [...t.matchAll(/(?<!前)(?:收市價?|今日收|收盤價?)\s*[:：]?\s*[$＄]?\s*(\d[\d,]*)(?![\d,.%\-\/年月日:])/g)].filter(x => okPre(t, x.index)).map(x => num(x[1]));
    close = mode(ci);
  }
  if (close === null) { const mm = t.match(new RegExp("現價\\s*[$＄]?\\s*" + DEC)); if (mm) close = num(mm[1]); }
  if (close !== null) r.close = close;

  // 成交量（股）
  const vp = [new RegExp("成交量?\\s*[:：]?\\s*" + NUM + "\\s*(M|百萬|萬|億|K)?", "g"), new RegExp("(?<![一-鿿])量\\s*" + NUM + "\\s*(M|百萬|萬|億)?", "g")];
  outer: for (const re of vp) for (const x of t.matchAll(re)) { const v = num(x[1]) * (UNIT[x[2]] || 1); if (v >= 10000) { r.volume = v; break outer; } }
  if (r.volume === undefined) {   // 表格：標題行有「成交量」，下一行數字
    for (let i = 0; i < lines.length && r.volume === undefined; i++) if (lines[i].includes("成交量")) {
      for (const nx of lines.slice(i + 1, i + 3)) { const mm = nx.match(new RegExp(NUM + "\\s*(M|百萬|萬|億)?")); if (mm) { const v = num(mm[1]) * (UNIT[mm[2]] || 1); if (v >= 10000) { r.volume = v; break; } } }
    }
  }

  // SMA（跳過大盤／指數嘅均線）
  const sma = {};
  for (const x of t.matchAll(new RegExp("(?:SMA|MA)\\s*(10|20|50|150|200)\\s*[:=]?\\s*[$＄]?\\s*" + DEC, "g"))) {
    const n = +x[1]; if (sma[n] !== undefined) continue;
    const pre = t.slice(Math.max(0, x.index - 45), x.index);
    if (INDEX_NEAR.test(pre) || /\d{1,2}\/\d{1,2}[^。；;]{0,20}$|重算|→|ChartExchange|承襲|上一份|報告/.test(pre.slice(-30))) continue;
    sma[n] = num(x[2]);
  }
  const ml = t.match(new RegExp("SMA\\s*10\\s*/\\s*20\\s*/\\s*50\\s*/\\s*150\\s*/\\s*200\\s*[=＝]\\s*" + [1, 2, 3, 4, 5].map(() => DEC).join("\\s*/\\s*")));
  if (ml) [10, 20, 50, 150, 200].forEach((n, i) => { if (sma[n] === undefined) sma[n] = num(ml[i + 1]); });
  if (Object.keys(sma).length) r.sma = sma;
  r.adjHint = /(?<!無)拆股|一拆[一二三四五六七八九十\d]|\d\s*拆\s*\d|前復權|reverse split|stock split/i.test(t);

  // 今日動作（原文摘要 ≤60 字）
  const i = t.search(/今日動作/);
  if (i >= 0) {
    let s = t.slice(i).replace(/^今日動作(?:一句[（(][^）)]*[）)])?\s*[:：]?\s*/, "");
    const j = s.search(/\s3\s*三條價位|\s4\s*(?:最大變化|同上一份)/); if (j > 0) s = s.slice(0, j);
    if (s.trim()) r.action = trim(s, 60);
  }
  return r;
}
async function parseCard(buf, fallbackDate) { return parseCardText(await pdfText(buf), fallbackDate); }

// ---- 核對（容差同 tools/stockreport/peers.py 一致）----
const priceOk = (c, a) => Math.abs(c - a) <= Math.max(0.02, Math.abs(a) * 0.0005);
const prevWeekday = d => { const t = new Date(d + "T00:00:00Z"), w = t.getUTCDay(); if (w === 6) t.setUTCDate(t.getUTCDate() - 1); else if (w === 0) t.setUTCDate(t.getUTCDate() - 2); return t.toISOString().slice(0, 10); };
const r4 = x => Math.round(x * 1e4) / 1e4;

// claim: parseCardText 結果；rows: [{d,o,h,l,c,v}] 按日期升序；date: 卡嘅日期。
// st：ok／warn／diff（來源差異）／unk（攞唔到行情）／na（卡內冇呢項）
function verifyCard(claim, rows, date) {
  const out = {close: {st: "na"}, sma: {st: "na", items: []}, vol: {st: "na"}, lag: false, note: "", verdict: "unk"};
  if (!claim || claim.image) return out;
  const has = claim.close !== undefined || claim.volume !== undefined || (claim.sma && Object.keys(claim.sma).length);
  if (!has) { out.note = "卡內抽唔到可核對數字"; return out; }
  const unk = note => { out.note = note; if (claim.close !== undefined) out.close = {st: "unk"}; if (claim.volume !== undefined) out.vol = {st: "unk"}; if (claim.sma) out.sma = {st: "unk", items: []}; return out; };
  if (!date) return unk("冇日期，未能核對");
  if (!rows || !rows.length) return unk("未能核對（攞唔到行情）");
  const want = prevWeekday(date);
  let idx = -1; for (let k = rows.length - 1; k >= 0; k--) if (rows[k].d <= date) { idx = k; break; }
  if (idx < 0) return unk("未能核對（行情冇該日期）");
  if (want > rows[rows.length - 1].d) return unk("未能核對（行情只到 " + rows[rows.length - 1].d + "）");
  const i = idx, r = rows[i], prev = i >= 1 ? rows[i - 1] : null;
  if (r.d !== date) out.note = (new Date(date + "T00:00:00Z").getUTCDay() % 6 === 0 ? "週末日期" : "聲稱日期非交易日") + "，用 " + r.d + " 核對";
  out.tdate = r.d;
  if (claim.close !== undefined) {
    const c = claim.close;
    if (priceOk(c, r.c)) out.close = {st: "ok", claim: c, actual: r4(r.c)};
    else if (prev && priceOk(c, prev.c)) { out.close = {st: "warn", claim: c, actual: r4(r.c), note: "落後一日（等於 " + prev.d + " 收市 " + r4(prev.c) + "）"}; out.lag = true; }
    else out.close = {st: "warn", claim: c, actual: r4(r.c), note: i + 1 < rows.length && priceOk(c, rows[i + 1].c) ? "等於次日收市（超前）" : ""};
  }
  if (claim.sma) {
    const items = [];
    for (const n of [10, 20, 50, 150, 200]) {
      const v = claim.sma[n]; if (v === undefined || i + 1 < n) continue;
      const a = rows.slice(i - n + 1, i + 1).reduce((s, x) => s + x.c, 0) / n, d = Math.abs(v - a) / a * 100;
      let st = d <= 0.05 ? "ok" : "warn", note = st === "ok" ? "" : "差 " + d.toFixed(3) + "%";
      if (st === "warn" && i >= n) { const a1 = rows.slice(i - n, i).reduce((s, x) => s + x.c, 0) / n; if (Math.abs(v - a1) / a1 * 100 <= 0.05) note += "；等於前一日 SMA（落後一日）"; }
      if (st === "warn" && claim.adjHint && d >= 1 && d <= 5) { st = "diff"; note += "；復權差異"; }
      items.push({n, claim: v, actual: r4(a), st, note});
    }
    out.sma = items.length ? {st: items.some(x => x.st === "warn") ? "warn" : items.some(x => x.st === "diff") ? "diff" : "ok", items} : {st: "na", items: []};
  }
  if (claim.volume !== undefined) {
    if (!r.v) out.vol = {st: "unk"};
    else { const d = Math.abs(claim.volume - r.v) / r.v * 100; out.vol = {st: d <= 0.5 ? "ok" : d <= 3 ? "diff" : "warn", claim: claim.volume, actual: r.v, note: "差 " + d.toFixed(2) + "%"}; }
  }
  const sts = [out.close.st, out.sma.st, out.vol.st];
  out.verdict = sts.includes("warn") ? "warn" : sts.some(s => s === "ok" || s === "diff") ? "ok" : "unk";
  return out;
}

module.exports = {PV, fileInfo, typeFromName, normTicker, parseCardText, parseCard, verifyCard};
