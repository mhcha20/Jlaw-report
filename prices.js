// 每日行情（開市價／收市價）：Yahoo Finance 日線為主，Stooq 為後備。只作模擬回測用。
const UA = {"User-Agent": "Mozilla/5.0 (compatible; jlaw-report/1.0)", "Accept": "application/json,text/csv,*/*"};

function parseYahoo(j) {
  const r = j && j.chart && j.chart.result && j.chart.result[0];
  if (!r || !r.timestamp || !r.indicators || !r.indicators.quote || !r.indicators.quote[0]) return null;
  const q = r.indicators.quote[0], out = [];
  r.timestamp.forEach((ts, i) => {
    if (q.open[i] == null || q.close[i] == null) return;
    out.push({d: new Date(ts * 1000).toISOString().slice(0, 10), o: q.open[i], h: q.high[i], l: q.low[i], c: q.close[i]});   // 日線時間戳係該市場開市時間（美股 UTC 13:30／14:30、港股 01:30、日韓 00:00），UTC 日期＝交易日
  });
  return out.length ? out : null;
}
// 完整日線（含成交量），供個股報告生成器用：range=2y；回傳 {d,o,h,l,c,v}（v 單位：股）
function parseYahooFull(j) {
  const r = j && j.chart && j.chart.result && j.chart.result[0];
  if (!r || !r.timestamp || !r.indicators || !r.indicators.quote || !r.indicators.quote[0]) return null;
  const q = r.indicators.quote[0], out = [];
  r.timestamp.forEach((ts, i) => {
    if (q.open[i] == null || q.close[i] == null || q.volume[i] == null) return;
    out.push({d: new Date(ts * 1000).toISOString().slice(0, 10), o: q.open[i], h: q.high[i], l: q.low[i], c: q.close[i], v: q.volume[i]});
  });
  return out.length ? out : null;
}
function parseStooq(t) {
  const out = [];
  for (const line of String(t).trim().split(/\r?\n/).slice(1)) {
    const [d, o, h, l, c] = line.split(",");
    if (/^\d{4}-\d{2}-\d{2}$/.test(d) && o && c && !isNaN(+o) && !isNaN(+c)) out.push({d, o: +o, h: +h, l: +l, c: +c});
  }
  return out.length ? out : null;
}
// 行動卡檔名代號 → 行情代號。美股字母；5 位數字＝港股（00066→0066.HK）；6 位數字＝韓股（000660→000660.KS）；4 位數字：0 開頭＝港股，否則日股（7203→7203.T）
// 英文字母代號但唔係美股：手動指定行情代號（歐洲、加拿大等）
const OVERRIDE = {NESN: "NESN.SW", SCHN: "SCHN.SW", ATD: "ATD.TO", MC: "MC.PA"};
function symbols(t) {
  if (OVERRIDE[t]) return {yahoo: OVERRIDE[t], stooq: ""};
  if (/^\d{5}$/.test(t)) { const h = String(+t).padStart(4, "0"); return {yahoo: h + ".HK", stooq: h + ".hk"}; }
  if (/^\d{6}$/.test(t)) return {yahoo: t + ".KS", stooq: ""};
  if (/^0\d{3}$/.test(t)) return {yahoo: t + ".HK", stooq: t + ".hk"};
  if (/^\d{4}$/.test(t)) return {yahoo: t + ".T", stooq: t + ".jp"};
  return {yahoo: t, stooq: t.toLowerCase() + ".us"};
}
async function fetchBars(ticker) {
  const errs = [], sym = symbols(ticker);
  for (const host of ["query1", "query2"]) {   // query1 失敗就試 query2
    try {
      const r = await fetch(`https://${host}.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(sym.yahoo)}?range=6mo&interval=1d&includePrePost=false`, {headers: UA});
      if (!r.ok) throw new Error(`yahoo(${host}) ${sym.yahoo} ${r.status}`);
      const p = parseYahoo(await r.json()); if (p) return {rows: p, src: "yahoo"}; errs.push(`yahoo ${sym.yahoo} empty`); break;
    } catch (e) { errs.push(e.message); }
  }
  if (sym.stooq) try {
    const r = await fetch(`https://stooq.com/q/d/l/?s=${encodeURIComponent(sym.stooq)}&i=d`, {headers: UA});
    if (!r.ok) throw new Error("stooq " + r.status);
    const p = parseStooq(await r.text()); if (p) return {rows: p, src: "stooq"}; errs.push("stooq empty");
  } catch (e) { errs.push(e.message); }
  throw new Error(errs.join("; "));
}
async function fetchOhlcv(ticker, range = "2y") {
  const sym = symbols(ticker), errs = [];
  for (const host of ["query1", "query2"]) {
    try {
      const r = await fetch(`https://${host}.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(sym.yahoo)}?range=${range}&interval=1d&includePrePost=false`, {headers: UA});
      if (!r.ok) throw new Error(`yahoo(${host}) ${sym.yahoo} ${r.status}`);
      const p = parseYahooFull(await r.json()); if (p) return {symbol: sym.yahoo, rows: p}; errs.push(`yahoo ${sym.yahoo} empty`); break;
    } catch (e) { errs.push(e.message); }
  }
  throw new Error(errs.join("; "));
}
module.exports = {symbols, fetchBars, fetchOhlcv, parseYahoo, parseStooq};
