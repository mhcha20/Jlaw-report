#!/usr/bin/env python3
"""lbcheck.py — Longbridge 日線核實／補 bar（Longbridge 只可由有 mcp__Longbridge__* 嘅 session 呼叫，腳本只處理已存低嘅 JSON）。
流程：session 呼叫 history_candlesticks_by_offset(symbol, count=3, trade_sessions="intraday", forward_adjust=false)，
把回傳 JSON 存成檔（例如 scratchpad/AAPL_lb.json），再：
  python3 lbcheck.py verify AAPL 2026-10-30 AAPL_lb.json   # 同 data/AAPL_2026-10-30.json 最後一根比對（收市差 ≤0.02 或 ≤0.05% 當一致）
  python3 lbcheck.py extra  AAPL 2026-10-30 AAPL_lb.json   # 印出可傳畀 prep.py data --extra 嘅 JSON（只含 DATE 當日 bar，v 單位股）
  python3 lbcheck.py calendar AAPL.US cal.json             # finance_calendar 結果（_jq 過濾後）→ 下次業績日一句
日期由 timestamp 自動換算（美股、港股、日韓都啱）；--shift=N 只係後備手動調整。唔會寫入任何網站檔案。

【直連模式】用 3 個金鑰直接連 Longbridge OpenAPI（唔使 MCP；排程 session 都用得）。金鑰只由環境變數讀：
  LONGBRIDGE_APP_KEY, LONGBRIDGE_APP_SECRET, LONGBRIDGE_ACCESS_TOKEN（需要 `pip install longport`）
  python3 lbcheck.py check [NVDA.US]                   # 金鑰＋網絡自檢（攞報價）；失敗 exit 2
  python3 lbcheck.py live-verify AAPL 2026-10-30       # 直接攞日線，同 data/AAPL_2026-10-30.json 比對（同 verify）
  python3 lbcheck.py live-extra  AAPL 2026-10-30       # 直接攞日線，印 --extra JSON（同 extra）
  python3 lbcheck.py live-earnings AAPL 2026-10-30     # 由 DATE 起 45 日內下次業績日一句（同 calendar）
代號自動轉換：字母→XXX.US、5 位數字→去前導零.HK（00700→700.HK）；其他市場（日韓）未驗證，會 exit 3，照舊用 Yahoo＋截圖。
直連失敗（缺金鑰、網絡、權限）exit 2＝「今次冇 Longbridge 核實」，**唔好當成數據不一致**；數據不一致係 exit 1。
"""
import json, sys, os
from datetime import date, datetime, timedelta, timezone
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

def _cal_line(sym, rows):
    hit = [r for r in rows if r.get('symbol') == sym]
    if not hit: print(f'{sym} 查唔到 → 標「未公布」'); return
    for r in hit: print(f'{sym} 下次業績日 {r.get("date")}（{r.get("date_type", "")}；來源 Longbridge 財經日曆，以公司公告為準）')

def calendar(sym, p):
    rows = json.load(open(p)); rows = rows if isinstance(rows, list) else rows.get('list', [])
    _cal_line(sym, rows)

# ---------- 直連模式（longport SDK） ----------
def lbsym(t):
    """本地代號 → Longbridge 代號；未驗證嘅市場 exit 3。"""
    if '.' in t: return t
    if t.isalpha(): return f'{t}.US'
    if t.isdigit() and len(t) == 5: return f'{int(t)}.HK'
    print(f'{t}：Longbridge 直連只支援美股／港股（日韓未驗證）→ 照舊用 Yahoo＋截圖', file=sys.stderr)
    sys.exit(3)

def _fail(msg):
    print(f'Longbridge 直連失敗：{msg} → 今次冇 Longbridge 核實（唔係數據不一致）', file=sys.stderr)
    sys.exit(2)

def _config():
    from longport.openapi import Config
    ks = ('LONGBRIDGE_APP_KEY', 'LONGBRIDGE_APP_SECRET', 'LONGBRIDGE_ACCESS_TOKEN')
    miss = [k for k in ks if not os.environ.get(k)]
    if miss: _fail('缺少環境變數 ' + ', '.join(miss))
    return Config.from_apikey(*(os.environ[k] for k in ks))

def live_rows(sym, count=5):
    """攞最近 count 根日線（不復權、正常時段）→ 同 MCP JSON 一樣嘅 rows（timestamp 當 UTC）。"""
    try:
        from longport.openapi import AdjustType, Period, QuoteContext, TradeSessions
        cs = QuoteContext(_config()).candlesticks(sym, Period.Day, count, AdjustType.NoAdjust, TradeSessions.Intraday)
    except SystemExit: raise
    except Exception as e: _fail(f'{type(e).__name__}: {e}')
    if not cs: _fail(f'{sym} 冇回傳日線（代號或權限）')
    rows = []
    for c in cs:
        ts = c.timestamp if c.timestamp.tzinfo else c.timestamp.replace(tzinfo=timezone.utc)
        rows.append(dict(timestamp=ts.astimezone(timezone.utc).isoformat(), open=str(c.open), high=str(c.high),
                         low=str(c.low), close=str(c.close), volume=str(c.volume)))
    return rows

def live_earnings(sym, d, days=45):
    """SDK 用日期範圍只會返第一日 → 逐日（平日）查，搵到就停。"""
    import time
    try:
        from longport.openapi import CalendarCategory, CalendarContext
        cal, mkt, day = CalendarContext(_config()), sym.rsplit('.', 1)[-1], date.fromisoformat(d)
        for _ in range(days + 1):
            if day.weekday() < 5:
                for g in cal.finance_calendar(CalendarCategory.Report, day.isoformat(), day.isoformat(), mkt).list:
                    for i in g.infos:
                        if i.symbol == sym: return [dict(symbol=i.symbol, date=str(g.date), date_type=i.date_type)]
                time.sleep(0.2)
            day += timedelta(days=1)
    except SystemExit: raise
    except Exception as e: _fail(f'{type(e).__name__}: {e}')
    return []

def check(sym='NVDA.US'):
    try:
        from longport.openapi import QuoteContext
        q = QuoteContext(_config()).quote([sym])[0]
    except SystemExit: raise
    except Exception as e: _fail(f'{type(e).__name__}: {e}')
    print(f'OK {q.symbol} last={q.last_done} ts={q.timestamp}')

def _tmp_json(rows):
    import tempfile
    f = tempfile.NamedTemporaryFile('w', suffix='_lb.json', delete=False); json.dump(rows, f); f.close(); return f.name

if __name__ == '__main__':
    a = [x for x in sys.argv[1:] if not x.startswith('--shift')]
    s = next((int(x.split('=')[1]) for x in sys.argv if x.startswith('--shift=')), 0)
    if len(a) >= 4 and a[0] == 'verify': sys.exit(0 if verify(a[1], a[2], a[3], s) else 1)
    elif len(a) >= 4 and a[0] == 'extra': extra(a[1], a[2], a[3], s)
    elif len(a) >= 3 and a[0] == 'calendar': calendar(a[1], a[2])
    elif a and a[0] == 'check': check(a[1] if len(a) > 1 else 'NVDA.US')
    elif len(a) >= 3 and a[0] in ('live-verify', 'live-extra'):
        p = _tmp_json(live_rows(lbsym(a[1])))
        try:
            if a[0] == 'live-verify': sys.exit(0 if verify(a[1], a[2], p, s) else 1)
            else: extra(a[1], a[2], p, s)
        finally: os.unlink(p)
    elif len(a) >= 3 and a[0] == 'live-earnings':
        sym = lbsym(a[1]); _cal_line(sym, live_earnings(sym, a[2]))
    else: print(__doc__)
