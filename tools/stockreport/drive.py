#!/usr/bin/env python3
"""drive.py — 唔使 Drive 連接器：經 jlaw-report 網站 API 做 Drive 查詢／下載／放入垃圾桶／上載。
  drive.py ls <folderId>                      列出資料夾子項（id,name,mimeType）
  drive.py datefolder <tickerFolderId> "22 oct 2026"   搵日期子資料夾 id
  drive.py shots <dateFolderId> <outDir>      數截圖（要 01–17 齊）並全部下載到 outDir；齊先印 OK
  drive.py tickerfolder <ticker>              喺個股截圖根資料夾搵 ticker 子資料夾 id
  drive.py reports <TICKER> <YYYY-MM-DD>      網站已有嘅該股該日報告（cat,id,name）
  drive.py latest <ticker> [beforeDate]       最近一份行動卡／本體報告（可下載 PDF 到 --out）
  drive.py market                             最近一份大盤報告 id／名
  drive.py market-shots <YYYY-MM-DD> [outDir] 大盤截圖：喺大盤截圖根資料夾搵「DD mon YYYY」子資料夾，列出 NN_TICKER_Daily.png，核對 19 張（IWM VIX SPY QQQ SOX 11 板塊 DXY GC1! US10Y）齊唔齊，並下載到 outDir（默認 /tmp/market-<DATE>；唔齊都會下載已有嘅，但印 INCOMPLETE）
  drive.py pdf <id> <out.pdf>                 下載網站報告 PDF
  drive.py trash <id> [<id>…]                 放入 Drive 垃圾桶（要 ADMIN；環境 proxy 自動帶密碼 header）
  drive.py upload <file.pdf>                  上載（檔名要符合 YYYY-MM-DD_TICKER_類型.pdf；cat=auto；replace=1＝上載後自動將同資料夾同名舊檔放入垃圾桶）
"""
import json, os, re, sys, urllib.parse, urllib.request
SITE = os.environ.get('JLAW_SITE', 'https://jlaw-report-a74806.up.railway.app')
ROOT = '1xkPBlGhK0SEn2dGIzAINQNIFL33m0hG_'   # 個股截圖根資料夾
MROOT = '1M8hNhlePL5MHD-_SvGZlQ02srBHFq_rl'  # 大盤截圖根資料夾（按日期分子資料夾）
MSHOTS = ['IWM', 'VIX', 'SPY', 'QQQ', 'SOX', 'XLK', 'XLF', 'XLE', 'XLV', 'XLY', 'XLB', 'XLC', 'XLI', 'XLP', 'XLU', 'XLRE', 'DXY', 'GC1!', 'US10Y']
def get(path):
    with urllib.request.urlopen(SITE + path, timeout=120) as r: return json.load(r)
def post(path, data, ctype='application/json'):
    req = urllib.request.Request(SITE + path, data=data, method='POST', headers={'Content-Type': ctype})
    with urllib.request.urlopen(req, timeout=300) as r: return json.load(r)
def ls(fid): return get(f'/api/drive/ls?folder={fid}')['files']
def main():
    a = sys.argv[1:]; c = a[0] if a else ''
    if c == 'ls': print(json.dumps(ls(a[1]), ensure_ascii=False, indent=1))
    elif c == 'datefolder':
        f = [x for x in ls(a[1]) if x['name'] == a[2]]; print(f[0]['id'] if f else '')
    elif c == 'tickerfolder':
        f = [x for x in ls(ROOT) if x['name'] == a[1]]; print(f[0]['id'] if f else '')
    elif c == 'shots':
        fs = [x for x in ls(a[1]) if x['name'].endswith('.png')]
        nums = sorted(int(x['name'][:2]) for x in fs if re.match(r'\d\d_', x['name']))
        etf = any('Fund_' in x['name'] for x in fs)   # ETF 版面：01–05 技術圖＋06–12 Fund_*（共 12 張）
        asia = '--asia' in a   # 港股／日股／韓股個股：冇內部人（15），部分冇預測／估值（16、17）→ 只要求 01–14
        need = list(range(1, 13)) if etf else list(range(1, 15)) if asia else list(range(1, 18))
        ok = all(n in nums for n in need) if asia and not etf else nums == need
        print(('OK' if ok else 'INCOMPLETE') + (' (ETF 12 張版面)' if etf and ok else '') + (' (亞洲個股版面)' if asia and ok and not etf else ''), len(fs), '張；缺：', sorted(set(range(1, 18)) - set(nums)) if asia and not etf else sorted(set(need) - set(nums)))
        if ok and len(a) > 2 and not a[2].startswith('--'):
            os.makedirs(a[2], exist_ok=True)
            for x in fs:
                with urllib.request.urlopen(f'https://drive.google.com/uc?export=download&id={x["id"]}', timeout=120) as r: open(f'{a[2]}/{x["name"]}', 'wb').write(r.read())
            print('downloaded →', a[2])
    elif c == 'reports':
        if len(a) < 3: sys.exit('用法：drive.py reports <TICKER> <YYYY-MM-DD>')
        for r in get('/api/sync')['rows']:
            if r[2].startswith(f'{a[2]}_{a[1]}_'): print(r[0], r[1], r[2], r[3])
    elif c == 'latest':
        rows = [r for r in get('/api/sync')['rows'] if re.match(rf'^\d{{4}}-\d\d-\d\d_{re.escape(a[1])}_', r[2]) and (len(a) < 3 or r[2][:10] < a[2])]
        for r in sorted(rows, key=lambda r: r[2], reverse=True)[:6]: print(r[0], r[1], r[2])
    elif c == 'market':
        rows = sorted([r for r in get('/api/sync')['rows'] if r[0] == 'market'], key=lambda r: r[2], reverse=True)[:3]
        for r in rows: print(r[0], r[1], r[2])
    elif c == 'market-shots':
        if len(a) < 2 or not re.fullmatch(r'\d{4}-\d\d-\d\d', a[1]): sys.exit('用法：drive.py market-shots <YYYY-MM-DD> [outDir]')
        y, mo, d = a[1].split('-'); fname = f'{int(d):02d} {"jan feb mar apr may jun jul aug sep oct nov dec".split()[int(mo)-1]} {y}'
        f = [x for x in ls(MROOT) if x['name'].lower() == fname]
        if not f: print('INCOMPLETE 搵唔到日期資料夾', repr(fname), '（截圖未上載？）'); sys.exit(1)
        fs = [x for x in ls(f[0]['id']) if x['name'].lower().endswith('.png')]
        got = {}
        for x in fs:
            mt = re.match(r'(\d\d)_(.+)_Daily\.png$', x['name'])
            if mt: got[mt.group(2)] = x
        miss = [t for t in MSHOTS if t not in got]; extra = [t for t in got if t not in MSHOTS]
        print(('OK' if not miss else 'INCOMPLETE') + f' {fname}（資料夾 {f[0]["id"]}）：{len(fs)} 張；缺：{miss}；多出：{extra}')
        out = a[2] if len(a) > 2 else f'/tmp/market-{a[1]}'; os.makedirs(out, exist_ok=True)
        for x in fs:
            with urllib.request.urlopen(f'https://drive.google.com/uc?export=download&id={x["id"]}', timeout=120) as r: open(f'{out}/{x["name"]}', 'wb').write(r.read())
        print('downloaded →', out, '（用 Read 逐張睇圖，唔好用文字辨識）')
        if miss: sys.exit(1)
    elif c == 'pdf':
        with urllib.request.urlopen(f'{SITE}/pdf/{a[1]}', timeout=120) as r: open(a[2], 'wb').write(r.read()); print('saved', a[2])
    elif c == 'trash': print(json.dumps(post('/api/delete', json.dumps({'ids': a[1:]}).encode()), ensure_ascii=False)[:400])
    elif c == 'upload':
        f = a[1]; print(json.dumps(post('/api/upload?name=' + urllib.parse.quote(os.path.basename(f)) + '&cat=auto&replace=1', open(f, 'rb').read(), 'application/pdf'), ensure_ascii=False))
    else: print(__doc__)
if __name__ == '__main__': main()
