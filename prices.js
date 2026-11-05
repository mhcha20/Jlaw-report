// 每日行情（開市價／收市價）：Yahoo Finance 日線為主，Stooq 為後備。只作模擬回測用。
const UA = {"User-Agent": "Mozilla/5.0 (compatible; jlaw-report/1.0)", "Accept": "application/json,text/csv,*/*"};

function parseYahoo(j) {
  const r = j && j.chart && j.chart.result && j.chart.result[0];
  if (!r || !r.timestamp || !r.indicators || !r.indicators.quote || !r.indicators.quote[0]) return null;
  const q = r.indicators.quote[0], out = [];
  fillMissingClose(r, q);
  r.timestamp.forEach((ts, i) => {
    if (q.open[i] == null || q.close[i] == null) return;
    out.push({d: new Date(ts * 1000).toISOString().slice(0, 10), o: q.open[i], h: q.high[i], l: q.low[i], c: q.close[i]});   // 日線時間戳係該市場開市時間（美股 UTC 13:30／14:30、港股 01:30、日韓 00:00），UTC 日期＝交易日
  });
  return out.length ? out : null;
}
// 完整日線（含成交量），供個股報告生成器用：range=2y；回傳 {d,o,h,l,c,v}（v 單位：股）
// Yahoo 有時（亞洲股多見）當日日線 bar 有開高低同成交量但 close 係 null（例：0066.HK 2026-11-05），咁 bar 會被略過、行情「停喺」前一日。
// 補救：最後一根 close 缺、而 meta.regularMarketTime 喺 bar 開市時間 6.4 個鐘之後（港／日／韓／美正常時段都係 6.5 個鐘）＝已收市，
// 就用 meta.regularMarketPrice 做收市價（高低按佢擴闊）。未收市（盤中）唔補，避免用盤中價當收市。
function fillMissingClose(r, q, nowSec = Date.now() / 1000) {
  const n = r.timestamp.length - 1, m = r.meta || {};
  if (n < 0 || q.close[n] != null) return;
  // 全日冇成交（極少成交股，例：0077.HK 2026-11-05）：成個 bar 都係 null。已過收市就照 Yahoo 自己做法補一根平盤、成交 0 嘅 bar（用上一個收市價）
  if (q.open[n] == null && q.high[n] == null && q.low[n] == null && q.volume[n] == null) {
    const prev = q.close.slice(0, n).reverse().find(x => x != null);
    const age = nowSec - r.timestamp[n];
    if (prev != null && age >= 6.6 * 3600 && age <= 30 * 3600 && !(typeof m.regularMarketTime === "number" && m.regularMarketTime > r.timestamp[n])) {
      q.open[n] = q.high[n] = q.low[n] = q.close[n] = prev; q.volume[n] = 0;
    }
    return;
  }
  if (q.open[n] == null || q.volume[n] == null) return;
  const px = m.regularMarketPrice, at = m.regularMarketTime;
  if (typeof px !== "number" || typeof at !== "number" || at - r.timestamp[n] < 6.4 * 3600 || at - r.timestamp[n] > 20 * 3600) return;
  q.close[n] = px; q.high[n] = Math.max(q.high[n] ?? px, px); q.low[n] = Math.min(q.low[n] ?? px, px);
}
function parseYahooFull(j) {
  const r = j && j.chart && j.chart.result && j.chart.result[0];
  if (!r || !r.timestamp || !r.indicators || !r.indicators.quote || !r.indicators.quote[0]) return null;
  const q = r.indicators.quote[0], out = [];
  fillMissingClose(r, q);
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
module.exports = {symbols, fetchBars, fetchOhlcv, parseYahoo, parseStooq, OVERRIDE};
