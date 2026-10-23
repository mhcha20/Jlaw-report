#!/usr/bin/env python3
"""scan.py <DATE> [--max N] — 掃描全部股票，列出當日有「變化」、值得升級做完整報告嘅 ticker。
來源：網站 /api/signals（行動卡逐日解析＋價位）＋ /api/ohlcv（日線）。唔使讀圖，幾乎零 token。
觸發（任一）：① 當日升跌 ≥4%；② 成交量 ≥2×50 日均量（不含當日）；③ 收市創 252 日新高／新低；④ 收市穿越 SMA50／SMA200；
⑤ 收市穿越最近一份行動卡嘅買入觸發／減倉／止損價；⑥ 網站 feed 有 buy／sell 標籤（行動卡評等／動作轉變）；⑦ 10 日內有財報（需另查，唔喺呢度）。
輸出 JSON：[{ticker, reasons[], score, lastCard:{date,rating,score}}]，按 score 由高至低；--max 限制數量（預設 8）。
"""
import json, os, re, sys, urllib.request, concurrent.futures as cf
SITE = os.environ.get('JLAW_SITE', 'https://jlaw-report-a74806.up.railway.app')
ASIA = re.compile(r'^\d{4,6}$')
def get(path):
    with urllib.request.urlopen(SITE + path, timeout=90) as r: return json.load(r)
def scan_one(row, date):
    t = row['ticker']
    try: j = get(f'/api/ohlcv?t={t}&range=2y')
    except Exception as e: return t, None, f'ohlcv failed: {e}'
    rs = [x for x in j['rows'] if x['d'] <= date]
    if len(rs) < 60 or rs[-1]['d'] != date: return t, None, f'last bar {rs[-1]["d"] if rs else None} != {date}'
    C = [x['c'] for x in rs]; V = [x['v'] for x in rs]; H = [x['h'] for x in rs]; L = [x['l'] for x in rs]
    why = []; sc = 0
    chg = (C[-1] / C[-2] - 1) * 100
    if abs(chg) >= 4: why.append(f'升跌 {chg:+.2f}%'); sc += 3
    vr = V[-1] / (sum(V[-51:-1]) / 50) if len(V) > 51 else 0
    if vr >= 2: why.append(f'量 {vr:.1f}×50 日'); sc += 2
    if len(C) > 252:
        if C[-1] >= max(H[-253:-1]): why.append('收市創 52 週新高'); sc += 3
        if C[-1] <= min(L[-253:-1]): why.append('收市創 52 週新低'); sc += 3
    for k in (50, 200):
        if len(C) > k + 1:
            m1 = sum(C[-k:]) / k; m0 = sum(C[-k-1:-1]) / k
            if (C[-2] - m0) * (C[-1] - m1) < 0: why.append(f'穿越 SMA{k}（{"上" if C[-1] > m1 else "下"}）'); sc += 3
    lv = row.get('levels') or {}
    for key, nm in (('buy', '買入觸發'), ('trim', '減倉價'), ('stop', '止損價')):
        p = (lv.get(key) or {}).get('price')
        if p and (C[-2] - p) * (C[-1] - p) < 0 and row.get('date', '') < date: why.append(f'穿越卡內{nm} {p}'); sc += 4
    return t, (why, sc), None
def main():
    date = sys.argv[1]; mx = int(sys.argv[sys.argv.index('--max') + 1]) if '--max' in sys.argv else 8
    d = get('/api/signals'); rows = {r['ticker']: r for r in d['rows']}
    feed = {f['ticker']: f for f in d['feed'] if f['date'] == date}
    out = []; errs = []
    with cf.ThreadPoolExecutor(4) as ex:
        futs = [ex.submit(scan_one, r, date) for t, r in rows.items() if not ASIA.match(t)]
        for f in cf.as_completed(futs):
            t, res, err = f.result()
            if err: errs.append((t, err)); continue
            why, sc = res; r = rows[t]
            if t in feed: why.append(f'網站 feed：{feed[t]["tag"]}（{"；".join(c["text"] for c in feed[t]["changes"])}）'); sc += 4
            if why: out.append({'ticker': t, 'reasons': why, 'score': sc, 'lastCard': {'date': r['date'], 'rating': r.get('rating'), 'score': r.get('score')}})
    out.sort(key=lambda x: -x['score'])
    print(json.dumps({'date': date, 'candidates': out[:mx], 'total_flagged': len(out), 'errors': errs[:10], 'n_errors': len(errs)}, ensure_ascii=False, indent=1))
if __name__ == '__main__': main()
