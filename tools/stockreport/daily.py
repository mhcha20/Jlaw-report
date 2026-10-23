#!/usr/bin/env python3
"""daily.py — 每日跨股總表自動化（V2.0 第八節）

  python3 daily.py DATE [--market US|ASIA|ALL] [--upload] [--out DIR] [--strict]

資料來源（全部公開唯讀，唔寫 server）：
  /api/sync     當日有咩「股票分析終極報告」（＝當日已出 V2.0 個股報告嘅股票），同行動卡／本體報告 id
  /api/signals  rows／history：每隻當日行動卡解析出嘅評等、分數、今日動作分類、收市、買入觸發／止損（有就用 rows 嘅三條價位）
  行動卡 PDF    （pdftotext）補 API 冇嘅欄位：減倉價、各價位距離％、第 6 格「唔做嘅代價」R 值
  本體報告 PDF  （pdftotext）雜訊被掃率（R4 第四項，回踩路徑）
冇嘅欄位一律標「缺項」，唔估、唔編造。輸出 out/<DATE>_每日跨股總表.pdf（A4 直向（同 gen2.build_daily 版面一致）、≤3 頁）。
--upload 用 drive.py upload（replace=1 取代同名舊檔）；唔加就只出檔。
"""
import argparse, datetime, json, os, re, subprocess, sys, tempfile, urllib.request

HERE = os.path.dirname(os.path.abspath(__file__)); sys.path.insert(0, HERE)
from lib import page, table, sg, FONTS            # noqa: E402
from gen import market_of, MARKETS                # noqa: E402

SITE = os.environ.get('JLAW_SITE', 'https://jlaw-report-a74806.up.railway.app')
MK_ORDER = ['US', 'HK', 'JP', 'KR']
MK_NAME = {'US': '美股', 'HK': '港股', 'JP': '日股', 'KR': '韓股'}
MISSING = '<span class="miss">缺項</span>'


# ---------------------------------------------------------------- 取數
def fetch(path, binary=False, tries=3):
    err = None
    for _ in range(tries):
        try:
            with urllib.request.urlopen(SITE + path, timeout=120) as r:
                d = r.read()
                return d if binary else json.loads(d)
        except Exception as e:                        # noqa: BLE001
            err = e
    raise SystemExit(f'攞唔到 {path}：{err}')


def pdf_text(pid, cache):
    f = os.path.join(cache, pid + '.pdf')
    if not os.path.exists(f):
        open(f, 'wb').write(fetch('/pdf/' + pid, binary=True))
    out = subprocess.run(['pdftotext', '-layout', f, '-'], capture_output=True, text=True, check=True).stdout
    return re.sub(r'\s+', '', out)                    # 去晒空白：版面換行唔影響 regex


def num(s): return float(s.replace(',', ''))


def seg(x, a, b):
    i = x.find(a)
    if i < 0: return ''
    j = x.find(b, i + len(a))
    return x[i:j] if j > 0 else x[i:]


def parse_card_text(x):
    """由行動卡全文（已去空白）抽 API 冇嘅欄位；抽唔到就唔出該 key"""
    o = {}
    s3 = seg(x, '三條價位', '同上一份最大')
    for k, lab in (('buy', '買入觸發'), ('trim', '減倉'), ('stop', '離場')):
        m = re.search(lab + r'([\d,\.]+)([▲▼])([\d\.]+)%', s3)
        if m: o[k] = dict(price=num(m.group(1)), dir='up' if m.group(2) == '▲' else 'down', pct=float(m.group(3)))
    s6 = seg(x, '唔做嘅代價', '今日更正')
    m = re.search(r'止損([\d,\.]+)入咗', s6)
    if m: o['c6_stop'] = num(m.group(1))
    m = re.search(r'到主目標([\d,\.]+)有([\d\.]+)R', s6)
    if m: o['c6_main'] = (num(m.group(1)), float(m.group(2)))
    m = re.search(r'到(?!主)([\d,\.]+)只[有得]([\d\.]+)R', s6)
    if m: o['c6_first'] = (num(m.group(1)), float(m.group(2)))
    m = re.search(r'(?:回踩|回測)區入場（(?:主目標)?([\d\.]+)R）', s6)
    if m: o['R_pb'] = float(m.group(1))
    o['no_cmp'] = bool(re.search(r'計法不同|唔作升降|重新起算', x[:6000]))
    o['v2'] = '唔做嘅代價' in x and '三條價位' in x
    return o


def parse_sweep(x):
    m = re.search(r'被掃率<30%[^（]{0,4}（回踩(\d+)／(\d+)＝(\d+)%', x)
    return (int(m.group(1)), int(m.group(2))) if m else None


# ---------------------------------------------------------------- 收集當日資料
def collect(date, markets, cache):
    sig = fetch('/api/signals'); sync = fetch('/api/sync')['rows']
    note = []
    if sig.get('running'): note.append('伺服器訊號分析仍在背景執行（running），個別股票可能未有解析結果')
    stock = {}
    for r in sync:
        m = re.match(rf'^{date}_(.+)_股票分析終極報告$', r[2])
        if m: stock[m.group(1)] = r
    cards = {}
    for r in sync:
        m = re.match(rf'^{date}_(.+)_行動卡$', r[2])
        if m and (m.group(1) not in cards or r[3] > cards[m.group(1)][3]): cards[m.group(1)] = r
    reps = {}
    for t, r in stock.items(): reps[t] = r
    rows = {r['ticker']: r for r in sig['rows'] if r['date'] == date}
    items, skipped, nodata = [], [], []
    for t in sorted(stock):
        if market_of(t) not in markets: continue
        api = rows.get(t); src = 'rows'
        if api is None:
            h = [e for e in sig['history'].get(t, []) if e['date'] == date]
            if h: api = h[-1]; src = 'history'
        if t not in cards:                            # 只有舊版報告、冇行動卡
            skipped.append(t); continue
        if api is None:
            nodata.append(t); continue
        buy = api['levels'].get('buy') if src == 'rows' else (dict(price=api['buy']) if api.get('buy') is not None else None)
        stop = api['levels'].get('stop') if src == 'rows' else (dict(price=api['stop']) if api.get('stop') is not None else None)
        if not buy or not stop:                       # 舊版（非 V2.0 七格）行動卡：冇三條價位
            skipped.append(t); continue
        card_id = cards[t][1]
        if api['id'] != card_id: note.append(f'{t} 行動卡 id 同 /api/signals 唔同（sync {card_id[:8]}… vs signals {api["id"][:8]}…），以 sync 最新上傳為準，請核對')
        ct = parse_card_text(pdf_text(card_id, cache))
        if not ct['v2']: skipped.append(t); continue
        it = dict(t=t, mk=market_of(t), src=src, api=api, ct=ct, card_id=card_id)
        # 價位：rows 有三條就用 rows；否則 buy／stop 用 API、減倉同距離用 PDF
        lv = {}
        for k in ('buy', 'trim', 'stop'):
            a = api['levels'].get(k) if src == 'rows' else None
            if a: lv[k] = dict(price=a['price'], dir=a['dir'], pct=a['pct'], from_='api')
            elif k in ct: lv[k] = dict(ct[k], from_='card')
        for k, v in (('buy', buy), ('stop', stop)):
            if src == 'history' and k in lv and abs(lv[k]['price'] - v['price']) > 1e-9:
                note.append(f'QA {t} {k} API {v["price"]} ≠ 行動卡 PDF {lv[k]["price"]}')
        if src == 'history':
            for k in ('buy', 'stop'):
                if k in lv: lv[k]['price'] = (buy if k == 'buy' else stop)['price']
        it['lv'] = lv
        # QA：rows 價位 vs PDF
        if src == 'rows':
            for k in ('buy', 'trim', 'stop'):
                if k in ct and k in lv and (abs(ct[k]['price'] - lv[k]['price']) > 1e-9 or abs(ct[k]['pct'] - lv[k]['pct']) > 1e-9):
                    note.append(f'QA {t} {k} /api/signals {lv[k]["price"]}／{lv[k]["pct"]}% ≠ 行動卡 PDF {ct[k]["price"]}／{ct[k]["pct"]}%')
        rep = reps[t]
        it['sweep'] = parse_sweep(pdf_text(rep[1], cache))
        items.append(it)
    return items, skipped, nodata, note, sig


# ---------------------------------------------------------------- 版面
def fp(mk, x):
    if x is None: return MISSING
    if mk in ('US', 'HK'): return f'{x:,.2f}'
    return f'{x:,.2f}'.rstrip('0').rstrip('.')


def prev_score(it):
    a = it['api']
    if it['src'] == 'rows': return a.get('prevScore')
    for c in a.get('changes', []):
        if c['k'] == 'score':
            m = re.search(r'分數 (\d+) → (\d+)', c['text'])
            if m: return int(m.group(1))
    return None


def lab(a, k):
    if 'cls' in a: return a['cls'][k]['label']
    return a[k]['label']


def build_row(it):
    t, mk, a, lv, ct = it['t'], it['mk'], it['api'], it['lv'], it['ct']
    ccy = MARKETS[mk]['ccy']
    stars = '★' * a['stars']
    sc = a['score']; pv = prev_score(it)
    if pv is None: sc_h = f'{sc}'
    elif ct['no_cmp']: sc_h = f'{sc}<br><span class="sm">新起算<br>上一份 {pv}</span>'
    else: sc_h = f'{sc} {sg(sc - pv, 0, "")}<br><span class="sm">上一份 {pv}</span>'
    act = f'未持倉：<b>{lab(a, "flat")}</b><br>已持倉：<b>{lab(a, "held")}</b>'
    close = a['close']
    stock_c = f'<b>{t}</b><br><span class="sm">收 {ccy} {fp(mk, close)}</span>'
    # 最近觸發位：三條價位入面離現價最近嗰條
    names = {'buy': '買入觸發', 'trim': '減倉', 'stop': '離場'}
    sem = {'buy': '收市高過＋量 ≥ 50 日均量 → 順勢路徑啟動', 'trim': '收市跌穿 → 減倉', 'stop': '收市跌穿 → 離場'}
    have = {k: v for k, v in lv.items() if v.get('pct') is not None}
    if have:
        nk = min(have, key=lambda k: have[k]['pct'])
        n = have[nk]
        near = f'{names[nk]}<br><b>{ccy} {fp(mk, n["price"])}</b>'
        dist = sg(n['pct'] if n['dir'] == 'up' else -n['pct'])
        others = '；'.join(f'{names[k]} {sg(v["pct"] if v["dir"] == "up" else -v["pct"])}' for k, v in lv.items() if k != nk and v.get('pct') is not None)
        key = f'{sem[nk]}<br><span class="sm">另：{others}</span>' if others else sem[nk]
    else:
        nk = None; near = MISSING; dist = MISSING; key = MISSING
    # R 值：行動卡第 6 格原文
    rp = f'{ct["R_pb"]:.2f}R' if 'R_pb' in ct else MISSING
    rt = f'{ct["c6_main"][1]:.2f}R' if 'c6_main' in ct else MISSING
    sw = it['sweep']
    sw_h = f'{sw[0]}／{sw[1]}＝{sw[0]/sw[1]*100:.0f}%' if sw else MISSING
    rcell = f'回踩入場 <b>{rp}</b><br>今日入場 {rt}<br><span class="sm">被掃率 {sw_h}</span>'
    return (stock_c, f'{stars}<br>{a["rating"]}', sc_h, act, near, dist, rcell, key), (nk if nk else '', have[nk]['pct'] if nk else 999)


CSS = '''<style>
html{font-size:8pt}
.miss{color:#9a6b00;font-weight:700}
.sm{font-size:6.8pt;color:#555;font-weight:400}
table.dt td{padding:3px 5px;line-height:1.35}table.dt td:nth-child(4){white-space:nowrap}table.dt th{font-size:7.6pt}
tr.grp td{background:#eef2f7;font-weight:700;color:#1f3a5f;border-top:1.2pt solid #1f3a5f}
</style>'''


def build_html(date, items, skipped, nodata, note, markets_arg, markets, sig_total):
    d = datetime.date.fromisoformat(date); wd = '一二三四五六日'[d.weekday()]
    mk_label = {'US': '美股場次', 'ASIA': '亞洲場次', 'ALL': '全部（美股＋亞洲）'}[markets_arg]
    hdr = (f'<div class="hdr"><h1>每日跨股總表｜{date}（{wd}）</h1><div class="info">V2.0 第八節｜{mk_label}｜自動版</div></div><div class="bar"></div>')
    cnt = {k: sum(1 for i in items if i['mk'] == k) for k in MK_ORDER}
    stats = '<div class="stats">' + f'<div><b>{len(items)}</b><span>V2.0 報告股票</span></div>' + ''.join(
        f'<div><b>{cnt[k]}</b><span>{MK_NAME[k]}（{MARKETS[k]["ccy"]}）</span></div>' for k in MK_ORDER if k in markets) + \
        f'<div><b>{sum(1 for i in items if "R_pb" in i["ct"])}／{len(items)}</b><span>卡面有 R 值</span></div>' + \
        f'<div><b>{sum(1 for i in items if i["sweep"])}／{len(items)}</b><span>有被掃率</span></div></div>'
    rows = []
    for mk in MK_ORDER:
        grp = [(build_row(i), i) for i in items if i['mk'] == mk]
        if not grp: continue
        grp.sort(key=lambda x: (x[0][1][1], x[1]['t']))
        rows.append((f'<td colspan="8">{MK_NAME[mk]}｜幣別 {MARKETS[mk]["ccy"]}｜{len(grp)} 隻（按距離％由近至遠）</td>', 'grp'))
        rows += [g[0][0] for g in grp]
    # table() 唔支援 colspan，直接寫
    th = ['股票', '評等', '分數（＋自身箭嘴）', '今日動作', '最近觸發位', '距離％', 'R 值', '最關鍵嗰條線']
    w = ['8%', '8%', '10%', '13%', '12%', '8%', '15%', '26%']
    body = ''
    for r in rows:
        if isinstance(r, tuple) and len(r) == 2 and r[1] == 'grp': body += f'<tr class="grp">{r[0]}</tr>'
        else: body += '<tr>' + ''.join(f'<td>{c}</td>' for c in r) + '</tr>'
    tb = ('<table class="dt"><colgroup>' + ''.join(f'<col style="width:{x}">' for x in w) + '</colgroup><thead><tr>' +
          ''.join(f'<th>{x}</th>' for x in th) + f'</tr></thead><tbody>{body}</tbody></table>')
    ex = []
    if skipped: ex.append(f'當日有終極報告但冇 V2.0 行動卡（舊版：冇行動卡，或行動卡冇三條價位／唔做嘅代價），未納入：{"、".join(skipped)}')
    if nodata: ex.append(f'當日有終極報告但 /api/signals 暫未有行動卡解析結果，未納入：{"、".join(nodata)}')
    ex += [f'<b>核對提示：</b>{n}' for n in note]
    cav = ('<div class="box hi"><b>口徑聲明（V2.0 第八節）：</b><ul class="facts">'
           '<li>分數唔可以跨股比較 —— 每隻只同自己嘅歷史比。「自身箭嘴」只喺行動卡冇聲明「計法不同」時先標 ▲▼；否則只列「新起算」同上一份分數，不作升降（上一份分數計法唔同）。</li>'
           '<li>距觸發位％、R 值、雜訊被掃率、今日動作　可以跨股比較 → 揀邊隻睇、揀邊隻做，睇呢四欄，唔好睇分數。</li>'
           '<li>距離％ ÷ 現價（當日收市）；「最近觸發位」＝買入觸發／減倉／離場三條價位入面離現價最近嗰條，價位前標幣別；「最關鍵嗰條線」＝該價位被觸發後嘅動作，另列其餘兩條距離。</li>'
           '<li>R 值<b>直接取自行動卡第 6 格原文</b>（回踩入場＝回踩區入場到主目標；今日入場＝今日收市價入場到主目標，止損同回踩路徑），唔係本表自行推算、亦唔係近似；各股主目標定義見各自行動卡，跨股比較時要留意。雜訊被掃率取自本體報告 R4 第四項（回踩路徑，60 日、5 日窗口，被掃日數／樣本日數）。行動卡／本體報告冇列嘅標「缺項」。</li>'
           '<li>數據來源：/api/sync（當日終極報告清單）、/api/signals（評等、分數、今日動作分類、收市、價位）、行動卡及本體報告 PDF 文字。今日動作係按行動卡文字機械歸類，唔係獨立買賣判斷。分數不是勝率；R 值為計劃值，非實現值。</li>'
           + ''.join(f'<li>{e}</li>' for e in ex) + '</ul></div>')
    return hdr + stats + tb + cav


def main():
    ap = argparse.ArgumentParser(description='每日跨股總表自動化')
    ap.add_argument('date'); ap.add_argument('--market', default='ALL', choices=['US', 'ASIA', 'ALL'])
    ap.add_argument('--upload', action='store_true'); ap.add_argument('--out', default=os.path.join(HERE, 'out'))
    ap.add_argument('--strict', action='store_true', help='QA 有不一致就非零退出')
    a = ap.parse_args()
    datetime.date.fromisoformat(a.date)
    markets = {'US': ['US'], 'ASIA': ['HK', 'JP', 'KR'], 'ALL': MK_ORDER}[a.market]
    os.makedirs(a.out, exist_ok=True)
    cache = tempfile.mkdtemp(prefix='daily_')
    items, skipped, nodata, note, sig = collect(a.date, markets, cache)
    if not items: sys.exit(f'{a.date} 搵唔到任何 V2.0 報告（{a.market}），唔出表')
    body = build_html(a.date, items, skipped, nodata, note, a.market, markets, sig.get('total'))
    h = page(f'每日跨股總表 {a.date}', CSS + body)
    h = h.replace('href="node_modules/', f'href="file://{HERE}/node_modules/').replace('href="style.css"', f'href="file://{HERE}/style.css"')
    html = os.path.join(cache, f'{a.date}_每日跨股總表.html'); open(html, 'w').write(h)
    pdf = os.path.join(a.out, f'{a.date}_每日跨股總表.pdf')
    jobs = [dict(html=html, pdf=pdf, footer=f'每日跨股總表 · {a.date}')]
    jf = os.path.join(cache, 'jobs.json'); json.dump(jobs, open(jf, 'w'))
    subprocess.check_call(['node', os.path.join(HERE, 'render.js'), jf], cwd=HERE)
    info = subprocess.run(['pdfinfo', pdf], capture_output=True, text=True).stdout
    pages = int([l for l in info.splitlines() if l.startswith('Pages')][0].split()[1])
    qa = [n for n in note if n.startswith('QA')]
    print(json.dumps(dict(date=a.date, market=a.market, pdf=pdf, pages=pages, stocks=[i['t'] for i in items], skipped=skipped, nodata=nodata, notes=note), ensure_ascii=False, indent=1))
    assert pages <= 3, f'每日跨股總表 {pages} 頁，超過 3 頁上限'
    if a.strict and qa: sys.exit('QA 不一致：' + '；'.join(qa))
    if a.upload:
        subprocess.check_call([sys.executable, os.path.join(HERE, 'drive.py'), 'upload', pdf])


if __name__ == '__main__':
    main()
