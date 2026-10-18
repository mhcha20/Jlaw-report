// 每日行情（開市價／收市價）：Yahoo Finance 日線為主，Stooq 為後備。只作模擬回測用。
const UA = {"User-Agent": "Mozilla/5.0 (compatible; jlaw-report/1.0)", "Accept": "application/json,text/csv,*/*"};

function parseYahoo(j) {
  const r = j && j.chart && j.chart.result && j.chart.result[0];
  if (!r || !r.timestamp || !r.indicators || !r.indicators.quote || !r.indicators.quote[0]) return null;
  const q = r.indicators.quote[0], out = [];
  r.timestamp.forEach((ts, i) => {
    if (q.open[i] == null || q.close[i] == null) return;
    out.push({d: new Date(ts * 1000).toISOString().slice(0, 10), o: q.open[i], h: q.high[i], l: q.low[i], c: q.close[i]});   // 美股日線時間戳係開市時間（UTC 13:30／14:30），UTC 日期＝交易日
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
async function fetchBars(ticker) {
  const errs = [];
  try {
    const r = await fetch(`https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(ticker)}?range=6mo&interval=1d&includePrePost=false`, {headers: UA});
    if (!r.ok) throw new Error("yahoo " + r.status);
    const p = parseYahoo(await r.json()); if (p) return {rows: p, src: "yahoo"}; errs.push("yahoo empty");
  } catch (e) { errs.push(e.message); }
  try {
    const r = await fetch(`https://stooq.com/q/d/l/?s=${encodeURIComponent(ticker.toLowerCase())}.us&i=d`, {headers: UA});
    if (!r.ok) throw new Error("stooq " + r.status);
    const p = parseStooq(await r.text()); if (p) return {rows: p, src: "stooq"}; errs.push("stooq empty");
  } catch (e) { errs.push(e.message); }
  throw new Error(errs.join("; "));
}
module.exports = {fetchBars, parseYahoo, parseStooq};
