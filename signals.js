// 由「一頁行動卡」PDF 抽取結構化訊號（評等、分數、三道閘、今日動作、價位、警報）。
// 訊號標籤只係按卡內文字機械歸類，唔係獨立判斷；以原文為準。

let pdfjs = null;
async function pdfText(buf) {
  pdfjs ||= await import("pdfjs-dist/legacy/build/pdf.mjs");
  const doc = await pdfjs.getDocument({data: new Uint8Array(buf), isEvalSupported: false, useSystemFonts: false, verbosity: 0}).promise;
  let out = "";
  try {
    for (let i = 1; i <= doc.numPages; i++) {
      const tc = await (await doc.getPage(i)).getTextContent();
      out += tc.items.map(x => x.str + (x.hasEOL ? "\n" : "")).join("") + "\n";
    }
  } finally { await doc.destroy(); }
  return out;
}

const num = s => Number(String(s).replace(/,/g, ""));
const between = (t, a, b) => { const i = t.search(a); if (i < 0) return ""; const rest = t.slice(i); const j = b ? rest.slice(1).search(b) : -1; return j < 0 ? rest : rest.slice(0, j + 1); };
const trim = (s, n) => { s = (s || "").replace(/\s+/g, " ").trim(); return s.length > n ? s.slice(0, n - 1) + "…" : s; };

function parseCard(raw) {
  const t = raw.replace(/[ \t]*\n[ \t]*/g, " ").replace(/\s{2,}/g, " ");
  const r = {};
  r.date = (t.match(/分析交易日\s*(\d{4}-\d{2}-\d{2})/) || [])[1] || "";
  const title = t.slice(0, 80);
  r.titleTicker = (title.match(/^\s*([A-Z]{1,5})\b/) || [])[1] || "";

  const s1 = between(t, /1\s*評等/, /2\s*今日動作/);
  const s2 = between(t, /2\s*今日動作/, /3\s*三條價位/);
  const s3 = between(t, /3\s*三條價位/, /4\s*(?:最大變化|同上一份)/);
  const sAl = between(t, /(?:警報\s*要升／跌幾多|5\s*三個警報價)/, /7\s*(?:明日|今日更正)/);

  // 評等同分數
  const rate = s1.match(/(★{1,5})\s*(買入|觀察|持有|減持|賣出|迴避|中立)/) || t.match(/(★{1,5})\s*(買入|觀察|持有|減持|賣出|迴避|中立)/);
  if (rate) { r.stars = rate[1].length; r.rating = rate[2]; }
  const sc = s1.match(/(\d{1,3})\s*[／/]\s*100/) || t.match(/(\d{1,3})\s*[／/]\s*100/);
  if (sc) r.score = num(sc[1]);
  const prev = s1.match(/上一份[^｜|]*[｜|]\s*(\d{1,3})\s*[／/]\s*100/) || t.match(/前\s*(\d{1,3})\s*[，,]/);
  if (prev) r.prevScore = num(prev[1]);
  const mk = s1.match(/市場(?:（[^）]*）)?\s*[：:]\s*([^（，。；\s]{2,16})/);
  if (mk) r.market = mk[1];
  const cap = s1.match(/倉位上限\s*([\d.]+%?\s*[–\-～至~]\s*[\d.]+%|[\d.]+%)/);
  if (cap) r.cap = cap[1].replace(/\s/g, "");

  // 今日動作
  const act = s2.replace(/^2\s*今日動作\s*/, "");
  const iu = act.search(/未持倉\s*[：:]/), ih = act.search(/已持倉\s*[：:]/);
  r.headline = iu > 0 ? trim(act.slice(0, iu), 90) : "";
  r.flat = iu >= 0 ? trim(act.slice(iu, ih > iu ? ih : undefined).replace(/^未持倉\s*[：:]\s*/, ""), 400) : "";
  r.held = ih >= 0 ? trim(act.slice(ih).replace(/^已持倉\s*[：:]\s*/, ""), 400) : "";
  if (iu < 0 && ih < 0) r.flat = trim(act, 300);

  // 三道閘
  const g = (re) => { const m = t.match(re); return m ? m[1] === "✔" : null; };
  const gates = {vol: g(/量能閘[^✔✘]{0,30}([✔✘])/), rr: g(/2\s*[:：]\s*1\s*閘[^✔✘]{0,40}([✔✘])/), atr: g(/1\s*ATR\s*閘[^✔✘]{0,30}([✔✘])/)};
  r.gates = Object.values(gates).some(v => v !== null) ? gates : null;

  // 價位
  const close = t.match(/收市(?:價)?\s*[$＄]?\s*([\d,]+\.\d+)/); if (close) r.close = num(close[1]);
  const lv = {};
  const re = /(買入觸發|追價上限|減倉|離場／止損|離場|止損)(?:（[^）]*）)?[：:\s]*[$＄]?([\d,]+(?:\.\d+)?)[：:\s]*([▲▼])\s*([\d.]+)%/g;
  let m;
  while ((m = re.exec(s3))) {
    const key = m[1] === "買入觸發" ? "buy" : m[1] === "追價上限" ? "chase" : m[1] === "減倉" ? "trim" : "stop";
    if (!lv[key]) lv[key] = {price: num(m[2]), dir: m[3] === "▲" ? "up" : "down", pct: num(m[4])};
  }
  r.levels = lv;

  // 警報價
  const alerts = [];
  const a1 = /(?:^|\s)[$＄]?([\d,]+\.\d{1,3})\s+要([升跌])\s*([\d.]+)%\s+(.*?)(?=\s[$＄]?[\d,]+\.\d{1,3}\s+要[升跌]|$)/g;
  while ((m = a1.exec(sAl))) alerts.push({price: num(m[1]), dir: m[2] === "升" ? "up" : "down", pct: num(m[3]), note: trim(m[4], 48)});
  if (!alerts.length) {
    const a2 = /[$＄]?([\d,]+(?:\.\d+)?)\s*[｜|]\s*(.*?)（要([升跌])\s*([\d.]+)%）/g;
    while ((m = a2.exec(sAl))) alerts.push({price: num(m[1]), dir: m[3] === "升" ? "up" : "down", pct: num(m[4]), note: trim(m[2], 48)});
  }
  r.alerts = alerts;
  return r;
}

// 按卡內文字歸類（機械規則，唔係判斷）
function classify(c) {
  const flat = c.flat || "", held = c.held || "", gates = c.gates;
  const noNew = /唔開新倉|零新倉|不開新倉|不建倉|唔建倉|不新增|唔買|不買|空倉觀望|不入場|唔入場/.test(flat);
  const wantBuy = /低吸|吸納|分批|建倉|買入|入場|開倉|加碼/.test(flat);
  const open = gates ? Object.values(gates).filter(v => v === true).length : null;
  const failed = gates ? Object.entries(gates).filter(([, v]) => v === false).map(([k]) => ({vol: "量能閘", rr: "2:1閘", atr: "1 ATR閘"}[k])) : [];
  let flatSignal;
  if (noNew) flatSignal = {key: "none", label: "零新倉"};
  else if (gates && open === 3) flatSignal = {key: "go", label: "三閘全過"};
  else if (wantBuy) flatSignal = {key: "cond", label: "條件式建倉"};
  else flatSignal = {key: "wait", label: "觀望"};
  let heldSignal;
  if (/全數離場|清倉|全部止損|立即離場|今日離場/.test(held)) heldSignal = {key: "exit", label: "離場"};
  else if (/減磅|減倉|減半|減持/.test(held)) heldSignal = {key: "trim", label: "減倉"};
  else if (/續抱|持有|守穩|堅守|嚴守/.test(held)) heldSignal = {key: "hold", label: "續抱"};
  else heldSignal = {key: "alert", label: "按警報"};
  return {flat: flatSignal, held: heldSignal, gatesOpen: open, gatesFailed: failed};
}


// ---- 每日變化比較 ----
const stateLabel = c => (c.stars ? "★".repeat(c.stars) + " " : "") + (c.rating || "–");
const fmt2 = n => typeof n === "number" ? n.toFixed(2) : n;
// 比較同一隻股票相鄰兩日嘅行動卡，回傳訊號標籤同逐項變化
function diffCards(p, c) {
  const pc = p.cls || classify(p), cc = c.cls || classify(c);
  const ch = []; let buy = false, sell = false;
  if (p.stars !== c.stars || p.rating !== c.rating) {
    const dir = (c.stars || 0) > (p.stars || 0) ? "up" : (c.stars || 0) < (p.stars || 0) ? "down" : "flat";
    ch.push({k: "rating", dir, text: "評等 " + stateLabel(p) + " → " + stateLabel(c)});
    if (c.rating === "買入" && p.rating !== "買入") buy = true;
    if (p.rating === "買入" && c.rating !== "買入") sell = true;
  }
  const buyKeys = ["go", "cond"];
  if (pc.flat.key !== cc.flat.key) {
    ch.push({k: "flat", dir: buyKeys.includes(cc.flat.key) && !buyKeys.includes(pc.flat.key) ? "up" : !buyKeys.includes(cc.flat.key) && buyKeys.includes(pc.flat.key) ? "down" : "flat", text: "未持倉 " + pc.flat.label + " → " + cc.flat.label});
    if (buyKeys.includes(cc.flat.key) && !buyKeys.includes(pc.flat.key)) buy = true;
  }
  if (pc.held.key !== cc.held.key) {
    const bad = ["exit", "trim"];
    ch.push({k: "held", dir: bad.includes(cc.held.key) && !bad.includes(pc.held.key) ? "down" : bad.includes(pc.held.key) && !bad.includes(cc.held.key) ? "up" : "flat", text: "已持倉 " + pc.held.label + " → " + cc.held.label});
    if (bad.includes(cc.held.key) && !bad.includes(pc.held.key)) sell = true;
  }
  if (p.gates && c.gates) {
    for (const [k, name] of [["vol", "量能閘"], ["rr", "2:1 閘"], ["atr", "1 ATR 閘"]]) {
      if (p.gates[k] !== c.gates[k] && c.gates[k] !== null) ch.push({k: "gate", dir: c.gates[k] ? "up" : "down", text: name + " " + (p.gates[k] ? "✔" : "✘") + " → " + (c.gates[k] ? "✔" : "✘")});
    }
    if (cc.gatesOpen === 3 && pc.gatesOpen !== 3) buy = true;
  }
  if (typeof p.score === "number" && typeof c.score === "number" && p.score !== c.score)
    ch.push({k: "score", dir: c.score > p.score ? "up" : "down", text: "分數 " + p.score + " → " + c.score + "（" + (c.score > p.score ? "▲" : "▼") + Math.abs(c.score - p.score) + "）"});
  for (const [k, name] of [["buy", "買入觸發"], ["stop", "止損"], ["trim", "減倉"]]) {
    const a = p.levels && p.levels[k], b = c.levels && c.levels[k];
    if (a && b && a.price !== b.price) ch.push({k: "level", dir: b.price > a.price ? "up" : "down", text: name + " " + fmt2(a.price) + " → " + fmt2(b.price)});
  }
  if (p.market && c.market && p.market !== c.market) ch.push({k: "market", dir: "flat", text: "大盤 " + p.market + " → " + c.market});
  return {tag: buy && sell ? "mixed" : buy ? "buy" : sell ? "sell" : null, changes: ch};
}

// 將所有已解析嘅卡按股票、日期整理成時間線
function buildHistory(cards) {
  const by = new Map();
  for (const c of cards) {
    const date = c.date || c.fileDate; if (!date || !c.ticker) continue;
    const l = by.get(c.ticker) || by.set(c.ticker, new Map()).get(c.ticker);
    const o = l.get(date); if (!o || (c.up || "") > (o.up || "")) l.set(date, c);   // 同日多份只留最新上傳
  }
  const out = {};
  for (const [t, m] of by) {
    const list = [...m.entries()].sort((a, b) => a[0].localeCompare(b[0])).map(e => ({...e[1], date: e[0], cls: classify(e[1])}));
    out[t] = list.map((c, i) => {
      const d = i ? diffCards(list[i - 1], c) : {tag: null, changes: []};
      return {date: c.date, id: c.id, stars: c.stars, rating: c.rating, score: c.score, flat: c.cls.flat, held: c.cls.held, gates: c.gates,
        close: typeof c.close === "number" ? c.close : null, buy: c.levels && c.levels.buy ? c.levels.buy.price : null, stop: c.levels && c.levels.stop ? c.levels.stop.price : null, market: c.market, first: i === 0, tag: d.tag, changes: d.changes};
    });
  }
  return out;
}


// ---- 模擬回測：每隻股票起始 $100，訊號出咗之後「下一個交易日開市價」成交，所得滾存 ----
// 訊號喺卡嘅日期收市後先出：買入訊號 → 下一個交易日開市價買入；賣出訊號 → 下一個交易日開市價全數賣出。
// prices：[{d:'YYYY-MM-DD', o, c}]（升序）。唔計手續費、滑點；可買碎股。
function backtest(list, prices = [], start = 100) {
  const P = prices.filter(b => b && typeof b.o === "number").sort((a, b) => a.d.localeCompare(b.d));
  const nextBar = d => P.find(b => b.d > d);
  const lastBar = P[P.length - 1];
  // 1) 由訊號產生訂單（按卡內標籤；同日買賣並存：持倉當賣、未持倉唔買）
  const orders = []; let st = "flat";
  for (const e of list) {
    const buyEv = e.tag === "buy" || (e.first && e.flat && (e.flat.key === "go" || e.flat.key === "cond"));
    const sellEv = e.tag === "sell" || e.tag === "mixed";
    if (st === "flat" && buyEv && e.tag !== "mixed") { orders.push({side: "buy", signalDate: e.date, why: e.first ? "起始日已係買入狀態" : (e.changes.find(c => c.dir === "up") || e.changes[0] || {text: "買入訊號"}).text}); st = "long"; }
    else if (st === "long" && sellEv) { orders.push({side: "sell", signalDate: e.date, why: (e.changes.find(c => c.dir === "down") || e.changes[0] || {text: "賣出訊號"}).text}); st = "flat"; }
  }
  // 2) 逐張訂單按下一個交易日開市價成交
  let cash = start, shares = 0, buy = null;
  const trades = [], pending = []; let noData = 0;
  for (const o of orders) {
    const bar = nextBar(o.signalDate);
    if (!bar) { if (P.length) pending.push({side: o.side, signalDate: o.signalDate, why: o.why}); else noData++; continue; }
    const fill = {signalDate: o.signalDate, fillDate: bar.d, price: bar.o, why: o.why};
    if (o.side === "buy") { shares = cash / bar.o; buy = fill; }
    else if (buy) { cash = shares * bar.o; trades.push({buy, sell: fill, ret: bar.o / buy.price - 1}); shares = 0; buy = null; }
  }
  const holding = !!buy;
  const now = lastBar ? lastBar.c : null;
  const open = holding && now != null ? {...buy, now, nowDate: lastBar.d, ret: now / buy.price - 1} : null;
  const final = holding && now != null ? shares * now : cash;
  const wins = trades.filter(t => t.ret > 0).length;
  const firstFill = list.length && nextBar(list[0].date);
  return {final, ret: final / start - 1, trades, open, pending, noData, wins, losses: trades.length - wins, days: list.length,
    traded: trades.length > 0 || holding, hasPrices: P.length > 0,
    bh: firstFill && lastBar && lastBar.d > firstFill.d ? lastBar.c / firstFill.o - 1 : null, from: list.length ? list[0].date : "", to: lastBar ? lastBar.d : ""};
}

module.exports = {pdfText, parseCard, classify, diffCards, buildHistory, backtest};
