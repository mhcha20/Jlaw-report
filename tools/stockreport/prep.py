#!/usr/bin/env python3
"""prep.py — 個股報告前置：行情 → data/<TICKER>.json；截圖 → 裁切／拼接圖。
用法：
  python3 prep.py data NVDA 2026-10-21           # 由 jlaw-report 網站 /api/ohlcv 攞日線，只取 ≤ 報告日嘅完整交易日
  python3 prep.py images NVDA <folder_with_pngs>  # 將 Futubull 截圖裁切（_c.png）同拼接表格（_t.png：標籤欄＋最近 6 季）
行情來源同網站回測一致（Yahoo Finance 日線，不復權）；成交量為綜合量（股），輸出 bars 內單位為千股。
"""
import json, os, sys, urllib.request
HERE = os.path.dirname(os.path.abspath(__file__))
SITE = os.environ.get('JLAW_SITE', 'https://jlaw-report-a74806.up.railway.app')

def data(ticker, date):
    with urllib.request.urlopen(f'{SITE}/api/ohlcv?t={ticker}&range=2y', timeout=60) as r:
        j = json.load(r)
    rows = [x for x in j['rows'] if x['d'] <= date]
    assert rows and rows[-1]['d'] == date, f'最後一根 K 線 {rows[-1]["d"] if rows else None} ≠ 報告日 {date}（行情未更新？）'
    assert len(rows) >= 260, f'日線只有 {len(rows)} 根'
    rows = rows[-319:] if len(rows) > 319 else rows
    bars = [[x['d'][5:], x['o'], x['h'], x['l'], x['c'], round(x['v'] / 1000)] for x in rows[-135:]]
    out = {'closes': [x['c'] for x in rows], 'bars': bars, 'symbol': j['symbol']}
    os.makedirs(f'{HERE}/data', exist_ok=True)
    json.dump(out, open(f'{HERE}/data/{ticker}.json', 'w'))
    print(f'{ticker} {j["symbol"]}: {len(rows)} 根，最後 {rows[-1]["d"]} 收 {rows[-1]["c"]} 量 {rows[-1]["v"]:,}')

def images(ticker, folder):
    from PIL import Image
    import glob
    for f in sorted(glob.glob(f'{folder}/*Futubull*.png')):
        im = Image.open(f); w, h = im.size
        c = im.crop((int(w*0.108), int(h*0.045), int(w*0.888), int(h*0.965)))
        c.save(f.replace('.png', '_c.png'))
        base = os.path.basename(f)[:2]
        if base in ('06', '07', '08', '09'):
            cw, ch = c.size
            a = c.crop((0, 150, 560, ch)); b = c.crop((cw-1330, 150, cw, ch))
            o = Image.new('RGB', (a.width+b.width, a.height)); o.paste(a, (0, 0)); o.paste(b, (a.width, 0))
            o.save(f.replace('.png', '_t.png'))
    print('done', ticker)

if __name__ == '__main__':
    cmd = sys.argv[1]
    if cmd == 'data': data(sys.argv[2], sys.argv[3])
    elif cmd == 'images': images(sys.argv[2], sys.argv[3])
    else: print(__doc__)
