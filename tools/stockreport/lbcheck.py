#!/usr/bin/env python3
"""lbcheck.py — Longbridge 日線核實／補 bar（Longbridge 只可由有 mcp__Longbridge__* 嘅 session 呼叫，腳本只處理已存低嘅 JSON）。
流程：session 呼叫 history_candlesticks_by_offset(symbol, count=3, trade_sessions="intraday", forward_adjust=false)，
把回傳 JSON 存成檔（例如 scratchpad/AAPL_lb.json），再：
  python3 lbcheck.py verify AAPL 2026-10-30 AAPL_lb.json   # 同 data/AAPL_2026-10-30.json 最後一根比對（收市差 ≤0.02 或 ≤0.05% 當一致）
  python3 lbcheck.py extra  AAPL 2026-10-30 AAPL_lb.json   # 印出可傳畀 prep.py data --extra 嘅 JSON（只含 DATE 當日 bar，v 單位股）
  python3 lbcheck.py calendar AAPL.US cal.json             # finance_calendar 結果（_jq 過濾後）→ 下次業績日一句
日期由 timestamp 自動換算（美股、港股、日韓都啱）；--shift=N 只係後備手動調整。唔會寫入任何網站檔案。
"""
import json, sys, os
from datetime import date, datetime, timedelta
HERE = os.path.dirname(os.path.abspath(__file__))

def load(p):
    j = json.load(open(p))
    return j.get('candlesticks', j) if isinstance(j, dict) else j

def bars(rows, shift=0):
    # Longbridge 日線 timestamp 係當地午夜（UTC）：美股 04:00Z／05:00Z＝同日，港股 16:00Z、日韓 15:00Z＝下一日；
    # 加 12 小時再取日期就三個市場都啱（2026-10-29 用 AAPL.US、3690.HK 實測）
    out = {}
    for r in rows:
        t = datetime.fromisoformat(r['timestamp'].replace('Z', '+00:00')) + timedelta(hours=12)
        d = (t.date() + timedelta(days=shift)).isoformat()
        out[d] = dict(d=d, o=float(r['open']), h=float(r['high']), l=float(r['low']), c=float(r['close']), v=float(r['volume']))
    return out

def verify(t, d, p, shift=0):
    lb = bars(load(p), shift)
    if d not in lb: raise SystemExit(f'Longbridge 冇 {d} 嗰根（有：{sorted(lb)}）→ 日期／時區（試 --shift）或未收市')
    mine = json.load(open(f'{HERE}/data/{t}_{d}.json'))['bars'][-1]   # [MM-DD,o,h,l,c,v千股]
    assert mine[0] == d[5:], f'data 最後一根係 {mine[0]}，唔係 {d[5:]}'
    x, ok = lb[d], True
    for k, i, name in (('o', 1, '開'), ('h', 2, '高'), ('l', 3, '低'), ('c', 4, '收')):
        diff = abs(x[k] - mine[i]); good = diff <= 0.02 or diff <= 0.0005 * x[k]; ok &= good
        print(f'{name} Longbridge {x[k]:g} vs 本地 {mine[i]:g} 差 {diff:.4f} {"✓" if good else "✗"}')
    vr = x['v'] / 1000 / mine[5] if mine[5] else float('nan')
    print(f'量 Longbridge {x["v"]/1000:,.0f}K vs 本地 {mine[5]:,}K（比 {vr:.3f}；口徑可能唔同，並列唔平均）')
    print('結論：' + ('收市一致' if ok else '不一致 → 查日期／復權，附錄第三節並列'))
    return ok

def extra(t, d, p, shift=0):
    lb = bars(load(p), shift)
    if d not in lb: raise SystemExit(f'Longbridge 冇 {d}')
    print(json.dumps([lb[d]]))

def calendar(sym, p):
    rows = json.load(open(p)); rows = rows if isinstance(rows, list) else rows.get('list', [])
    hit = [r for r in rows if r.get('symbol') == sym]
    if not hit: print(f'{sym} 查唔到 → 標「未公布」'); return
    for r in hit: print(f'{sym} 下次業績日 {r.get("date")}（{r.get("date_type", "")}；來源 Longbridge 財經日曆，以公司公告為準）')

if __name__ == '__main__':
    a = [x for x in sys.argv[1:] if not x.startswith('--shift')]
    s = next((int(x.split('=')[1]) for x in sys.argv if x.startswith('--shift=')), 0)
    if len(a) >= 4 and a[0] == 'verify': sys.exit(0 if verify(a[1], a[2], a[3], s) else 1)
    elif len(a) >= 4 and a[0] == 'extra': extra(a[1], a[2], a[3], s)
    elif len(a) >= 3 and a[0] == 'calendar': calendar(a[1], a[2])
    else: print(__doc__)
