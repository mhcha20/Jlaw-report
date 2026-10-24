#!/usr/bin/env python3
"""audit_cards.py — 行動卡「聲稱 vs 日線重算」抽查工具（通用，唔含任何卡文字／人名）。

  audit_cards.py batch   <manifest.json> [--from YYYY-MM-DD --to YYYY-MM-DD]
        manifest：[{txt, name, id, up}]（txt＝pdftotext 輸出路徑；name＝檔名 YYYY-MM-DD_TICKER_…）
        → 每份卡抽聲稱（peers.extract 數字＋評等／分數／技術描述），標記 gen（V2.0 生成器卡）
          同 dup（同股同交易日非最新上傳）。輸出 JSON 陣列。
  audit_cards.py verify  <claims.json> [--cache DIR] [--otc T1,T2]
        → 逐份：數字核對（peers.verify 容差）、技術描述核對、客觀技術分、當日指標。
  audit_cards.py summary <results.json> [--ref v2results.json] [--maxgap N]
        → 匯總：數字 OK 率、落後一日（按日期）、技術描述不符率（逐類）、
          卡分數 vs 客觀技術分（Spearman、分組、平均差）、vs V2.0 卡分數（同日或 N 個交易日內）。

技術描述核對（只核對陳述今日狀態嘅句子；條件句／警報觸發句排除）：
  four_bull「四線多頭／多頭排列」：收市 > MA10/20/50/200，且 MA10>MA20>MA50>MA200，且 MA50（對 10 日前）同 MA200（對 20 日前）向上。
  above_all「站穩所有均線」：收市 > MA10/20/50/200。
  vol_up「放量」：當日量 ÷ 50 日均量（不含當日）> 100%；vol_down「縮量」：< 100%。
  new_high「創新高」：歷史／52 週／年內＝當日高 ≥ 過去 252 日最高；近期／波段＝當日高 ≥ 過去 60 日最高；
            唔符合但近 5 日內有創＝「近 5 日曾創」（另計）。
  ma_above「守穩／站穩／收復 NNMA、年線」：收市 > MA_N；ma_below「受制／失守／跌破 NNMA」：收市 < MA_N。
客觀技術分（0–100，簡單透明，唔等同九構面）：
  收市高過 MA10/20/50/200 各 10（40）；MA50 向上 10、MA200 向上 10（20）；
  距 52 週高 ≤5% 15／≤10% 10／≤20% 5（15）；量價：升＋量比≥100% 10、跌＋量比<100% 7、升＋縮量 5、跌＋放量 0（10）；
  20 日動量 ≥10% 15／≥5% 11／≥0 7／≥−5% 3（15）。日線不足 200 根時 MA200 相關項按比例縮放（標 partial）。
"""
import json, os, re, sys, math
from datetime import date, timedelta

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)
import peers  # noqa: E402

DEC = peers.DEC
GEN_MARK = re.compile(r'三個警報價（可入\s*TradingView）|三個警報價（可入')


def trading_date(d):
    if not d:
        return d
    t = date.fromisoformat(d)
    if t.weekday() == 5:
        t -= timedelta(days=1)
    elif t.weekday() == 6:
        t -= timedelta(days=2)
    return t.isoformat()


def _flat(text):
    return re.sub(r'\s+', ' ', re.sub(r'[⺀-⿟豈-﫿]', lambda m: __import__('unicodedata').normalize('NFKC', m.group(0)), text))


COND = re.compile(r'若|如果|如|一旦|需|須|要|待|等|才|→|否則|直至|警報|觸發|繼續打開|週線')


def _ctx(t, s, e, before=10, after=10):
    return t[max(0, s - before):s], t[e:e + after]


def tech_claims(t):
    """回傳 [{type, n?, pos}]；pos＝字元位置（只作去重同抽樣用）。"""
    out = []
    seen = set()

    def add(typ, pos, **kw):
        key = (typ, kw.get('n'))
        if key in seen:
            return
        seen.add(key)
        out.append(dict(type=typ, pos=pos, **kw))

    for m in re.finditer(r'四線多頭|均線多頭排列|多頭排列', t):
        b, a = _ctx(t, m.start(), m.end(), 6, 6)
        if re.search(r'非|不是|未|唔係|破壞|瓦解|失守|告破|轉空|結束|不再|已破|崩|空頭|待|若|恢復|重建', b + a[:4]):
            continue
        add('four_bull', m.start())
    for m in re.finditer(r'站(?:穩|上|回)(?:所有|全部|四條|四線|全數)均線|(?:所有|全部|四條)均線(?:之)?上', t):
        b, a = _ctx(t, m.start(), m.end(), 8, 4)
        if re.search(r'若|如|需|待|才|未|重新|→', b):
            continue
        add('above_all', m.start())
    for m in re.finditer(r'放量', t):
        b, a = _ctx(t, m.start(), m.end(), 8, 10)
        if COND.search(b) or re.search(r'繼續打開|站穩\s*→|→', a) or re.search(r'週線', b[-3:]):
            continue
        add('vol_up', m.start())
    for m in re.finditer(r'縮量|量縮', t):
        b, a = _ctx(t, m.start(), m.end(), 8, 6)
        if COND.search(b):
            continue
        add('vol_down', m.start())
    for m in re.finditer(r'(?:創|刷|續刷|連刷|連創)(?:兩日)?(歷史|52\s*週|年內|近期|波段|階段)?新高|(歷史)新高(?!點)', t):
        b, a = _ctx(t, m.start(), m.end(), 6, 2)
        if re.search(r'逼近|接近|挑戰|距|未|待|若|如|需|才|重返', b[-4:]):
            continue
        k = m.group(1) or m.group(2) or ''
        add('new_high', m.start(), scope='60' if k in ('近期', '波段', '階段') else '252')
    verbs_up = r'守穩|站穩|站上|收復|重返|重上|企穩|高於|遠高於|突破|守住'
    verbs_dn = r'受制|承壓|失守|跌破|摜破|摜穿|跌穿|擊穿|低於|仍處|於'
    for m in re.finditer(r'(' + verbs_up + '|' + verbs_dn + r')\s*(10|20|50|150|200)\s*MA|(' + verbs_up + '|' + verbs_dn + r')\s*(年線)', t):
        verb = m.group(1) or m.group(3)
        n = int(m.group(2)) if m.group(2) else 200
        b, a = _ctx(t, m.start(), m.end(), 8, 8)
        if COND.search(b[-6:]) or re.search(r'^\s*→', a):
            continue
        if verb in ('仍處', '於'):
            if not re.match(r'\s*(?:之)?(?:下|下方)', a):
                continue
            typ = 'ma_below'
        else:
            typ = 'ma_above' if re.fullmatch(verbs_up, verb) else 'ma_below'
        add(typ, m.start(), n=n)
    return out


def extract(text, name):
    c = peers.extract(text, name)
    m = re.match(r'(\d{4}-\d\d-\d\d)_([A-Z0-9.]+)_', name)
    if m:
        c['ticker'] = m.group(2)
        c['date_file'] = m.group(1)
        c['date'] = c.get('date_text') or m.group(1)
    c['tdate'] = trading_date(c['date']) if c.get('date') else None
    c['gen'] = bool(GEN_MARK.search(_flat(text)))
    if c.get('text_len', 0) < 50:
        c['tech'] = []
        return c
    t = _flat(text)
    # 評等／星數
    RT = r'(★[★☆]{0,4})\s*([一-鿿]{2,6}(?:[/／][一-鿿]{2,4})?)'
    # 「1 評等」格嘅「今日 ★★★ 觀察｜60／100」優先（頁首可能先引用上一份評等）
    today = re.search(r'今日\s*' + RT + r'\s*[｜|]\s*(\d{1,3})\s*[／/]\s*100', t)
    r = today or re.search(RT, t)
    c['stars'] = r.group(1).count('★') if r else None
    c['rating'] = r.group(2) if r else None
    s = None if today else (re.search(r'評分\s*(\d{1,3})\s*分', t) or re.search(r'(?<![\d.])(\d{1,3})\s*[／/]\s*100', t))
    c['score'] = int(today.group(3)) if today else int(s.group(1)) if s else c.get('score')
    # 「收市價 ₩1,277,000（+0.39%）」「收報 ¥6,382（+1.79%）」：收市＋升跌一齊出現，容許整數價同非美元貨幣符號，優先採用
    cp = re.search(r'(?:收市價|收報)\s*(?:[（(][A-Z]{3}[）)])?\s*[$＄₩¥￥€£]?\s*(?:[A-Z]{1,3}\$?\s*)?(\d[\d,]*(?:\.\d+)?)\s*[（(]\s*([+\-−＋－▲▼])\s*(\d+(?:\.\d+)?)\s*%', t)
    if cp:
        c['close'] = peers._f(cp.group(1))
        c['pct'] = float(cp.group(3)) * (-1 if cp.group(2) in '-−－▼' else 1)
    # 升跌%：只認「收 X（±p%）」同「±p% 收 X」兩種寫法（表格入面 ▲▼ 多數係價位距離，唔用）
    if not cp:
        c['pct'] = None
    if c.get('close') is not None and c.get('pct') is None:
        for mm in re.finditer(r'收\s*[$＄₩¥￥€£]?\s*' + DEC + r'\s*[（(]\s*([+\-−＋－▲▼])\s*(\d+(?:\.\d+)?)\s*%', t):
            if abs(peers._f(mm.group(1)) - c['close']) < 1e-6:
                c['pct'] = float(mm.group(3)) * (-1 if mm.group(2) in '-−－▼' else 1)
                break
    if c.get('close') is not None and c.get('pct') is None:   # 「+6.20% 收 $92.66」
        for mm in re.finditer(r'([+\-−＋－▲▼])\s*(\d+(?:\.\d+)?)\s*%\s*收\s*[$＄₩¥￥€£]?\s*' + DEC, t):
            if abs(peers._f(mm.group(3)) - c['close']) < 1e-6:
                c['pct'] = float(mm.group(2)) * (-1 if mm.group(1) in '-−－▼' else 1)
                break
    # 均線數值：「50MA $226.03」「SMA10／20／50／200 ＝ a／b／c／d」
    sma = {int(k): v for k, v in (c.get('sma') or {}).items()}
    ml = re.search(r'SMA\s*((?:\d{2,3}\s*[／/]\s*){1,4}\d{2,3})\s*[=＝]\s*((?:[\d,.]+|--|—|N/?A)(?:\s*[／/]\s*(?:[\d,.]+|--|—|N/?A)){1,4})', t)
    if ml:
        ks = [int(x) for x in re.split(r'\s*[／/]\s*', ml.group(1))]
        vs = re.split(r'\s*[／/]\s*', ml.group(2))
        for k, v in zip(ks, vs):
            if re.match(r'\d', v) and k in (10, 20, 50, 150, 200):
                sma.setdefault(k, peers._f(v))
    for mm in re.finditer(r'(?<![\d.])(10|20|50|150|200)\s*MA\s*(?:[（(])?\s*\$?\s*' + DEC, t):
        n = int(mm.group(1))
        pre = t[max(0, mm.start() - 30):mm.start()]
        if peers.INDEX_NEAR.search(pre) or re.search(r'週線|周線', pre[-8:]):
            continue
        sma.setdefault(n, peers._f(mm.group(2)))
    c['sma'] = sma
    c['tech'] = tech_claims(t)
    return c


def batch(manifest, dfrom=None, dto=None):
    out = []
    for e in manifest:
        txt = open(e['txt'], encoding='utf-8', errors='replace').read()
        c = extract(txt, e['name'])
        c['id'] = e.get('id')
        c['up'] = e.get('up', '')
        out.append(c)
    if dfrom or dto:
        out = [c for c in out if c.get('tdate') and (not dfrom or c['tdate'] >= dfrom) and (not dto or c['tdate'] <= dto)]
    best = {}
    for c in out:
        k = (c['gen'], c.get('ticker'), c.get('tdate'))
        if k not in best or c['up'] > best[k]['up']:
            best[k] = c
    for c in out:
        c['dup'] = best[(c['gen'], c.get('ticker'), c.get('tdate'))] is not c
    return out


# ───────────── 指標同核對 ─────────────
def _sma(C, i, n):
    return sum(C[i - n + 1:i + 1]) / n if i + 1 >= n else float('nan')


def metrics_at(rows, i):
    C = [r['c'] for r in rows]; H = [r['h'] for r in rows]; V = [r['v'] for r in rows]
    m = {'d': rows[i]['d'], 'close': C[i], 'prev': C[i - 1] if i else None, 'bars': i + 1}
    for n in (10, 20, 50, 150, 200):
        m['ma%d' % n] = _sma(C, i, n)
    m['ma50_10'] = _sma(C, i - 10, 50) if i >= 59 else float('nan')
    m['ma200_20'] = _sma(C, i - 20, 200) if i >= 219 else float('nan')
    m['volr50'] = V[i] / (sum(V[i - 50:i]) / 50) * 100 if i >= 50 and sum(V[i - 50:i]) else float('nan')
    w = H[max(0, i - 251):i + 1]
    m['hi52'] = max(w)
    m['hi52_full'] = i >= 251
    m['dist52'] = (C[i] / m['hi52'] - 1) * 100
    m['newhi252'] = H[i] >= max(H[max(0, i - 251):i]) if i else False
    m['newhi60'] = H[i] >= max(H[max(0, i - 59):i]) if i else False
    m['newhi252_5d'] = any(H[j] >= max(H[max(0, j - 251):j]) for j in range(max(1, i - 4), i + 1))
    m['newhi60_5d'] = any(H[j] >= max(H[max(0, j - 59):j]) for j in range(max(1, i - 4), i + 1))
    m['ret20'] = (C[i] / C[i - 20] - 1) * 100 if i >= 20 else float('nan')
    m['chg'] = (C[i] / C[i - 1] - 1) * 100 if i else 0.0
    return m


def nan(x):
    return x is None or (isinstance(x, float) and math.isnan(x))


def objective_score(m):
    pts, mx = 0.0, 0.0
    for n in (10, 20, 50, 200):
        if not nan(m['ma%d' % n]):
            mx += 10; pts += 10 if m['close'] > m['ma%d' % n] else 0
    if not nan(m['ma50_10']):
        mx += 10; pts += 10 if m['ma50'] > m['ma50_10'] else 0
    if not nan(m['ma200_20']):
        mx += 10; pts += 10 if m['ma200'] > m['ma200_20'] else 0
    mx += 15; d = m['dist52']
    pts += 15 if d >= -5 else 10 if d >= -10 else 5 if d >= -20 else 0
    if not nan(m['volr50']):
        mx += 10; up = m['chg'] >= 0; hv = m['volr50'] >= 100
        pts += 10 if up and hv else 7 if not up and not hv else 5 if up else 0
    if not nan(m['ret20']):
        mx += 15; r = m['ret20']
        pts += 15 if r >= 10 else 11 if r >= 5 else 7 if r >= 0 else 3 if r >= -5 else 0
    return round(pts / mx * 100, 1), mx < 100


def check_tech(cl, m):
    t = cl['type']; res = {'type': t}
    if cl.get('n'):
        res['n'] = cl['n']
    mas = [m['ma10'], m['ma20'], m['ma50'], m['ma200']]
    if t in ('four_bull', 'above_all'):
        if any(nan(x) for x in mas):
            res['status'] = '未能核對'; res['note'] = '日線不足 200 根'
            return res
        above = all(m['close'] > x for x in mas)
        res['above'] = above
        if t == 'above_all':
            res['status'] = '符合' if above else '不符'
        else:
            stack = mas[0] > mas[1] > mas[2] > mas[3]
            rise = (nan(m['ma50_10']) or m['ma50'] > m['ma50_10']) and (nan(m['ma200_20']) or m['ma200'] > m['ma200_20'])
            res.update(stack=stack, rise=rise)
            res['status'] = '符合' if above and stack and rise else '不符'
        res['below'] = [n for n, x in zip((10, 20, 50, 200), mas) if m['close'] <= x]
    elif t in ('vol_up', 'vol_down'):
        if nan(m['volr50']):
            res['status'] = '未能核對'
        else:
            ok = m['volr50'] > 100 if t == 'vol_up' else m['volr50'] < 100
            res['status'] = '符合' if ok else '不符'
            res['volr50'] = round(m['volr50'], 1)
    elif t == 'new_high':
        sc = cl.get('scope', '252')
        if sc == '252' and not m['hi52_full']:
            res['status'] = '未能核對'; res['note'] = '日線不足 252 根'
        elif m['newhi' + sc]:
            res['status'] = '符合'
        elif m['newhi%s_5d' % sc]:
            res['status'] = '近5日曾創'
        else:
            res['status'] = '不符'
        res['dist52'] = round(m['dist52'], 2)
    elif t in ('ma_above', 'ma_below'):
        x = m['ma%d' % cl['n']]
        if nan(x):
            res['status'] = '未能核對'
        else:
            ok = m['close'] > x if t == 'ma_above' else m['close'] < x
            res['status'] = '符合' if ok else '不符'
            res['ma'] = round(x, 4)
    return res


def verify(c, cache_dir=None, otc=()):
    vc = dict(c)
    vc['date'] = c.get('tdate') or c.get('date')
    out = peers.verify(vc, cache_dir, otc)
    for k in ('id', 'up', 'gen', 'dup', 'stars', 'rating', 'score', 'tdate'):
        out[k] = c.get(k)
    out['tech'] = []
    rows = peers.fetch_rows(c['ticker'], cache_dir) if c.get('ticker') else None
    if not rows or not vc.get('date'):
        return out
    idx = [i for i, r in enumerate(rows) if r['d'] <= vc['date']]
    if not idx or idx[-1] < 21:
        return out
    m = metrics_at(rows, idx[-1])
    i = idx[-1]
    for it in out['items']:   # 升跌% 錯：睇吓係咪等於前一交易日嘅升跌（落後一日）；收市錯：記偏離幅度
        if it['item'] == '升跌%' and it['status'] == '錯誤' and i >= 2:
            p1 = (rows[i - 1]['c'] / rows[i - 2]['c'] - 1) * 100
            if abs(it['claim'] - p1) <= 0.05:
                it['note'] = (it['note'] + '；' if it['note'] else '') + '等於前一交易日升跌（落後一日）'
        if it['item'] == '收市價' and it['actual']:
            it['dev_pct'] = round((it['claim'] / it['actual'] - 1) * 100, 3)
    out['m'] = {k: (round(v, 4) if isinstance(v, float) and not math.isnan(v) else (None if isinstance(v, float) else v)) for k, v in m.items()}
    out['obj'], out['obj_partial'] = objective_score(m)
    out['tech'] = [check_tech(t, m) for t in c.get('tech') or []]
    return out


# ───────────── 匯總 ─────────────
def _rank(xs):
    o = sorted(range(len(xs)), key=lambda i: xs[i]); r = [0.0] * len(xs); i = 0
    while i < len(o):
        j = i
        while j + 1 < len(o) and xs[o[j + 1]] == xs[o[i]]:
            j += 1
        for k in range(i, j + 1):
            r[o[k]] = (i + j) / 2 + 1
        i = j + 1
    return r


def spearman(a, b):
    if len(a) < 3:
        return None
    ra, rb = _rank(a), _rank(b)
    ma, mb = sum(ra) / len(ra), sum(rb) / len(rb)
    cov = sum((x - ma) * (y - mb) for x, y in zip(ra, rb))
    va = math.sqrt(sum((x - ma) ** 2 for x in ra)); vb = math.sqrt(sum((y - mb) ** 2 for y in rb))
    return round(cov / (va * vb), 3) if va and vb else None


def _stats(xs):
    if not xs:
        return None
    s = sorted(xs); n = len(s)
    q = lambda p: s[min(n - 1, max(0, int(round(p * (n - 1)))))]
    return {'n': n, 'mean': round(sum(s) / n, 2), 'median': q(.5), 'p10': q(.1), 'p90': q(.9), 'min': s[0], 'max': s[-1]}


def summary(res, ref=None, maxgap=1):
    use = [r for r in res if not r.get('dup') and not r.get('gen')]
    S = {'cards': len(use), 'verifiable': sum(1 for r in use if r.get('verifiable'))}
    items = [it for r in use for it in r['items']]
    by = {}
    for it in items:
        b = by.setdefault(it['item'], {'n': 0, 'OK': 0, '來源差異': 0, '錯誤': 0})
        b['n'] += 1; b[it['status']] = b.get(it['status'], 0) + 1
    S['items'] = {'n': len(items), 'OK': sum(it['status'] == 'OK' for it in items), 'src': sum(it['status'] == '來源差異' for it in items),
                  'err': sum(it['status'] == '錯誤' for it in items), 'by_item': by}
    S['cards_all_ok'] = sum(1 for r in use if r['items'] and all(it['status'] != '錯誤' for it in r['items']))
    close_n = [r for r in use if any(it['item'] == '收市價' for it in r['items'])]
    S['close_checked'] = len(close_n)
    S['lag'] = sum(1 for r in use if r.get('lag'))
    devs = [abs(it['dev_pct']) for r in use for it in r['items'] if it['item'] == '收市價' and it['status'] == '錯誤' and 'dev_pct' in it and not r.get('lag')]
    S['close_err_nonlag'] = {'n': len(devs), '≤1%': sum(d <= 1 for d in devs), '1–10%': sum(1 < d <= 10 for d in devs), '>10%': sum(d > 10 for d in devs)}
    sd = [abs(it['claim'] / it['actual'] - 1) * 100 for r in use for it in r['items'] if it['item'].startswith('SMA') and it['status'] == '錯誤' and it['actual']]
    S['sma_err'] = {'n': len(sd), '≤1%': sum(d <= 1 for d in sd), '1–5%': sum(1 < d <= 5 for d in sd), '>5%': sum(d > 5 for d in sd),
                    'lag': sum(1 for r in use for it in r['items'] if it['item'].startswith('SMA') and '落後一日' in it.get('note', ''))}
    vd = [it['claim'] / it['actual'] for r in use for it in r['items'] if it['item'] == '成交量' and it['status'] == '錯誤' and it['actual']]
    S['vol_err'] = {'n': len(vd), '0.8–1.25x': sum(0.8 <= d <= 1.25 for d in vd), '其他': sum(not (0.8 <= d <= 1.25) for d in vd)}
    S['pct_lag'] = sum(1 for r in use for it in r['items'] if it['item'] == '升跌%' and '落後一日' in it.get('note', ''))
    dates = {}
    for r in use:
        d = dates.setdefault(r.get('tdate') or '?', {'cards': 0, 'close_checked': 0, 'close_ok': 0, 'lag': 0, 'items': 0, 'items_ok': 0, 'tech': 0, 'tech_bad': 0, 'score': [], 'obj': []})
        d['cards'] += 1
        for it in r['items']:
            d['items'] += 1; d['items_ok'] += it['status'] == 'OK'
            if it['item'] == '收市價':
                d['close_checked'] += 1; d['close_ok'] += it['status'] == 'OK'
        d['lag'] += bool(r.get('lag'))
        for t in r['tech']:
            if t['status'] in ('符合', '不符'):
                d['tech'] += 1; d['tech_bad'] += t['status'] == '不符'
        if r.get('score') is not None and r.get('obj') is not None:
            d['score'].append(r['score']); d['obj'].append(r['obj'])
    for d in dates.values():
        d['score_mean'] = round(sum(d['score']) / len(d['score']), 1) if d['score'] else None
        d['obj_mean'] = round(sum(d['obj']) / len(d['obj']), 1) if d['obj'] else None
        del d['score'], d['obj']
    S['by_date'] = dict(sorted(dates.items()))
    tech = {}
    for r in use:
        for t in r['tech']:
            b = tech.setdefault(t['type'], {'cards': 0, '符合': 0, '不符': 0, '近5日曾創': 0, '未能核對': 0})
            b['cards'] += 1; b[t['status']] = b.get(t['status'], 0) + 1
            if t['type'] == 'four_bull' and t['status'] == '不符':
                b['fail_above'] = b.get('fail_above', 0) + (not t.get('above'))
                b['fail_stack'] = b.get('fail_stack', 0) + (not t.get('stack'))
                b['fail_rise'] = b.get('fail_rise', 0) + (not t.get('rise'))
    S['tech'] = tech
    pairs = [r for r in use if r.get('score') is not None and r.get('obj') is not None]
    S['score_vs_obj'] = {'n': len(pairs), 'spearman': spearman([r['score'] for r in pairs], [r['obj'] for r in pairs]),
                         'diff': _stats([round(r['score'] - r['obj'], 1) for r in pairs]),
                         'score': _stats([r['score'] for r in pairs]), 'obj': _stats([r['obj'] for r in pairs])}
    bins = [(0, 40), (40, 60), (60, 80), (80, 101)]
    S['buckets'] = []
    for lo, hi in bins:
        g = [r for r in pairs if lo <= r['obj'] < hi]
        S['buckets'].append({'obj': '%d–%d' % (lo, min(hi, 100)), 'n': len(g),
                             'score_mean': round(sum(r['score'] for r in g) / len(g), 1) if g else None,
                             'buy_pct': round(sum(1 for r in g if r.get('rating') and r['rating'].endswith('買入')) / len(g) * 100, 1) if g else None,
                             'stars4p_pct': round(sum(1 for r in g if (r.get('stars') or 0) >= 4) / len(g) * 100, 1) if g else None})
    if ref:
        rv = [r for r in ref if r.get('gen') and not r.get('dup') and r.get('score') is not None]
        cmp_ = []
        for r in pairs:
            best = None
            for v in rv:
                if v['ticker'] != r['ticker'] or not v.get('tdate') or v['tdate'] < r['tdate']:
                    continue
                gap = _bdays(r['tdate'], v['tdate'])
                if gap <= maxgap and (best is None or gap < best[0]):
                    best = (gap, v)
            if best:
                v = best[1]
                cmp_.append({'ticker': r['ticker'], 'main_date': r['tdate'], 'v2_date': v['tdate'], 'gap': best[0], 'main': r['score'], 'v2': v['score'],
                             'diff': r['score'] - v['score'], 'main_obj': r['obj'], 'v2_obj': v.get('obj'), 'main_stars': r.get('stars'), 'v2_stars': v.get('stars')})
        S['vs_v2'] = {'pairs': cmp_, 'diff': _stats([x['diff'] for x in cmp_]),
                      'stars_diff': _stats([x['main_stars'] - x['v2_stars'] for x in cmp_ if x['main_stars'] is not None and x['v2_stars'] is not None]),
                      'spearman_v2_obj': spearman([x['v2'] for x in cmp_ if x['v2_obj'] is not None], [x['v2_obj'] for x in cmp_ if x['v2_obj'] is not None])}
        allv2 = [v for v in rv if v.get('obj') is not None]
        S['v2_score_vs_obj'] = {'n': len(allv2), 'spearman': spearman([v['score'] for v in allv2], [v['obj'] for v in allv2]),
                                'diff': _stats([round(v['score'] - v['obj'], 1) for v in allv2])}
    return S


def _bdays(a, b):
    d0, d1 = date.fromisoformat(a), date.fromisoformat(b); n = 0
    while d0 < d1:
        d0 += timedelta(days=1)
        if d0.weekday() < 5:
            n += 1
    return n


def main():
    a = sys.argv[1:]
    if not a:
        print(__doc__); return
    opt = lambda k, d=None: a[a.index(k) + 1] if k in a else d
    if a[0] == 'batch':
        print(json.dumps(batch(json.load(open(a[1], encoding='utf-8')), opt('--from'), opt('--to')), ensure_ascii=False, indent=1))
    elif a[0] == 'verify':
        otc = tuple(opt('--otc', '').split(',')) if opt('--otc') else ()
        cl = json.load(open(a[1], encoding='utf-8'))
        print(json.dumps([verify(c, opt('--cache'), otc) for c in cl], ensure_ascii=False, indent=1))
    elif a[0] == 'summary':
        ref = json.load(open(opt('--ref'), encoding='utf-8')) if opt('--ref') else None
        print(json.dumps(summary(json.load(open(a[1], encoding='utf-8')), ref, int(opt('--maxgap', 1))), ensure_ascii=False, indent=1))
    else:
        print(__doc__)


if __name__ == '__main__':
    main()
