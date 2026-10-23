#!/usr/bin/env python3
"""peers.py — 行動卡數據抽查工具（通用，唔含任何人名／簽到內容）。

  peers.py extract <卡文字.txt> <檔名.pdf>   由行動卡文字抽可核對聲稱（代號、日期、收市、前收、升跌%、OHLC、量、SMA、52週高低、分數）→ JSON
  peers.py verify  <claims.json> [--cache DIR] [--otc T1,T2] 對 jlaw-report 嘅 /api/ohlcv 行情重算並比對 → JSON（逐項 OK／來源差異／錯誤／未能核對）

claims.json 係聲稱物件陣列：{file, ticker, date, close, prev, pct, open, high, low, volume, sma:{10:…}, hi52, lo52, score, adj_hint}
抽唔到嘅欄位留 null，唔估。

容差：價 ≤0.02 或 ≤0.05%；均線 ≤0.05%；量 ≤0.5% OK、≤3% 來源差異、>3% 標「量差>3%」（算錯誤，但報表分開計）。
OTC／ADR 代號（--otc）：價差 ≤0.5% 當來源差異。
日期錯位：聲稱收市價等於前一交易日行情收市（而唔等於當日）＝「落後一日」。
行情 /api/ohlcv 已按拆股調整；若卡文提及復權／拆股而均線有差，標「復權差異」（算來源差異，唔算錯誤）。
"""
import json, os, re, sys, urllib.request

SITE = os.environ.get('JLAW_SITE', 'https://jlaw-report-a74806.up.railway.app')
NUM = r'(\d[\d,]*\.\d+|\d[\d,]*)'
DEC = r'(\d[\d,]*\.\d+)(?![\d%])'
INDEX_NEAR = re.compile(r'QQQ|SPY|IWM|SMH|SOX|DIA|XL[A-Z]{1,2}\b|大盤|門檻|指數')


def _f(s):
    return float(s.replace(',', ''))


PRE_BAD = re.compile(r'(QQQ|SPY|IWM|SMH|SOX|VIX|DXY|US10Y|IBIT|BTC|XL[A-Z]{1,2}|NVDA|大盤|指數|\d{1,2}/\d{1,2}\s*(?:日|報告|收|開|高|低)?|承襲|重算|上一份|前日|昨日|→|＞|>)\s*[\(（:：]?\s*$')


def _ok_prefix(text, pos, width=14):
    return not PRE_BAD.search(text[max(0, pos - width):pos])


def _first(rx, text, flags=0):
    m = re.search(rx, text, flags)
    return m


def _mode(vals):
    """最常見嘅值（四捨五入至 4 位），打和取最先出現者。"""
    if not vals:
        return None
    cnt = {}
    for v in vals:
        k = round(v, 4)
        cnt[k] = cnt.get(k, 0) + 1
    best = max(cnt.values())
    for v in vals:
        if cnt[round(v, 4)] == best:
            return v


def parse_date(name, text):
    """回傳 (內文日期, 檔名日期)。"""
    head = text[:600]
    m = re.search(r'分析交易日\s*(20\d\d-\d\d-\d\d)', head) or re.search(r'(20\d\d-\d\d-\d\d)', head)
    cdate = m.group(1) if m else None
    n = re.search(r'(20\d\d-\d\d-\d\d)', name)
    fdate = n.group(1) if n else None
    if not fdate:
        mon = {'jan': 1, 'feb': 2, 'mar': 3, 'apr': 4, 'may': 5, 'jun': 6, 'jul': 7, 'aug': 8, 'sep': 9, 'oct': 10, 'nov': 11, 'dec': 12}
        n = re.search(r'(\d{1,2})\s+([A-Za-z]{3})\w*\s+(20\d\d)', name)
        if n and n.group(2).lower() in mon:
            fdate = '%s-%02d-%02d' % (n.group(3), mon[n.group(2).lower()], int(n.group(1)))
    return cdate, fdate


def _vol(text):
    """成交量 → 股數；抽唔到回 None。"""
    pats = [
        r'成交量?\s*[:：]?\s*' + NUM + r'\s*(M|百萬|萬|億|K)?',
        r'(?<![一-鿿])量\s*' + NUM + r'\s*(M|百萬|萬|億)?',
    ]
    for p in pats:
        for m in re.finditer(p, text):
            v = _f(m.group(1)); u = m.group(2)
            if u == 'M' or u == '百萬':
                v *= 1e6
            elif u == '萬':
                v *= 1e4
            elif u == '億':
                v *= 1e8
            elif u == 'K':
                v *= 1e3
            if v >= 10000:
                return v
    # 表格：標題行有「成交量」，下一行第一個數
    lines = text.split('\n')
    for i, ln in enumerate(lines):
        if '成交量' in ln:
            col = ln.index('成交量')
            for nx in lines[i + 1:i + 3]:
                seg = nx[max(0, col - 6):col + 30]
                m = re.search(NUM + r'\s*(M|百萬|萬|億)?', seg)
                if m:
                    v = _f(m.group(1)); u = m.group(2)
                    v *= {'M': 1e6, '百萬': 1e6, '萬': 1e4, '億': 1e8}.get(u, 1)
                    if v >= 10000:
                        return v
    return None


def extract(text, name):
    t = re.sub(r'[ \t]+', ' ', text)
    m = re.match(r'([A-Z]{1,6})', name)
    ticker = m.group(1) if m else None
    cdate, fdate = parse_date(name, text)
    c = {'file': name, 'ticker': ticker, 'date': cdate or fdate, 'date_file': fdate, 'date_text': cdate,
         'close': None, 'prev': None, 'pct': None, 'open': None, 'high': None, 'low': None, 'volume': None,
         'sma': {}, 'hi52': None, 'lo52': None, 'score': None,
         'adj_hint': bool(re.search(r'(?<!無)拆股|一拆[一二三四五六七八九十\d]|\d\s*拆\s*\d|前復權|reverse split|stock split', text, re.I)), 'text_len': len(text.strip())}
    if c['text_len'] < 50:
        c['note'] = '無文字層（圖片 PDF）'
        return c
    # 收市
    cl = [_f(m.group(1)) for m in re.finditer(r'(?<!前)(?:收市價?|今日收|收)\s*[:：]?\s*\$?\s*' + DEC, t) if _ok_prefix(t, m.start())]
    close = _mode(cl)
    lines0 = text.split('\n')
    tbl = False
    for i, ln in enumerate(lines0[:60]):   # 表頭「收市(價)」開頭，數字喺之後幾行嘅第一欄
        if re.match(r'\s*收市價?(\s|$)', ln) and not re.match(r'\s*收市價?\s*\$?\d', ln):
            got = None
            for nx in [x for x in lines0[i + 1:i + 6] if x.strip()][:4]:
                mm = re.match(r'\s*\$?\s*(\d[\d,]*\.\d+)(?![\d%MK萬億x×–\-/（(])', nx)
                if mm:
                    got = _f(mm.group(1)); break
            if got is not None:
                close = got
                tbl = True
                break
    for i, ln in enumerate(lines0[:40]):   # 「結論 收市 …」表頭，數字喺下一行
        if not tbl and re.search(r'結論\s{3,}收市', ln) and i + 1 < len(lines0):
            mm = re.search(r'\$?\s*(\d[\d,]*\.\d{2,4})(?![\d%])', lines0[i + 1])
            if mm:
                close = _f(mm.group(1))
            break
    if close is None:   # 表格：標題「收市價」下一行
        lines = text.split('\n')
        for i, ln in enumerate(lines):
            if '收市價' in ln or re.match(r'\s*收市\s', ln):
                col = max(0, ln.find('收市') - 3)
                for nx in lines[i + 1:i + 4]:
                    mm = re.search(r'\$?' + DEC, nx[col:col + 40])
                    if mm:
                        close = _f(mm.group(1)); break
            if close is not None:
                break
    if close is None:   # 後備：「現價 $539.44」
        mm = re.search(r'現價\s*\$?\s*' + DEC, t)
        close = _f(mm.group(1)) if mm else None
    c['close'] = close
    # 前收
    pv = [_f(x) for x in re.findall(r'前收\s*[:：]?\s*\$?\s*' + DEC, t)]
    c['prev'] = pv[0] if pv else None
    # 升跌%
    if close is not None:
        for mm in re.finditer(r'\$?\s*' + DEC + r'\s*[（(]?\s*([▲▼])\s*[＋+]?\s*([\d.]+)%', t):
            if abs(_f(mm.group(1)) - close) < 1e-6:
                c['pct'] = float(mm.group(3)) * (1 if mm.group(2) == '▲' else -1)
                break
    # OHLC
    def pick(rx):
        for mm in re.finditer(rx, t):
            if _ok_prefix(t, mm.start()):
                return _f(mm.group(1))
        return None
    c['open'] = pick(r'(?<![\u4e00-\u9fff])開(?:市|盤)?\s*\$?\s*' + DEC)
    c['high'] = pick(r'(?:(?<![\u4e00-\u9fff])|今日最)高\s*\$?\s*' + DEC)
    c['low'] = pick(r'(?:(?<![\u4e00-\u9fff])|今日最)低\s*\$?\s*' + DEC)
    rg = re.search(r'日內[^\d$\n]{0,8}?\$?\s*' + DEC + r'\s*[/\-–—]\s*\$?\s*' + DEC, t) or \
        re.search(r'波幅\s*\n?\s*\$?\s*' + DEC + r'\s*[/\-–—]\s*\$?\s*' + DEC, t)
    if not rg:
        lines = text.split('\n')
        for i, ln in enumerate(lines):
            if '波幅' in ln or '日內區間' in ln or '日內低' in ln:
                for nx in lines[i + 1:i + 3]:
                    rg = re.search(r'\$?\s*' + DEC + r'\s*[/\-–—]\s*\$?\s*' + DEC, nx)
                    if rg:
                        break
                if rg:
                    break
    if rg:
        a, b = _f(rg.group(1)), _f(rg.group(2))
        if '低/高' in t[max(0, rg.start() - 2):rg.start() + 12]:
            lo, hi = a, b
        else:
            lo, hi = min(a, b), max(a, b)
        c['low'], c['high'] = lo, hi
    if close is not None and c['low'] is not None and c['high'] is not None:
        if not (c['low'] - 1e-6 <= close <= c['high'] + 1e-6):
            c['low'] = c['high'] = None   # 對唔上收市＝抽錯，唔用
    if close is not None and c['open'] is not None and c['low'] is not None and c['high'] is not None:
        if not (c['low'] - 1e-6 <= c['open'] <= c['high'] + 1e-6):
            c['open'] = None
    c['volume'] = _vol(t)
    # SMA（跳過大盤／指數嘅均線）
    for m in re.finditer(r'(?:SMA|MA)\s*(10|20|50|150|200)\s*[:=]?\s*\$?\s*' + DEC, t):
        n = int(m.group(1))
        if n in c['sma']:
            continue
        pre = t[max(0, m.start() - 45):m.start()]
        if INDEX_NEAR.search(pre) or re.search(r'\d{1,2}/\d{1,2}[^。；;]{0,20}$|重算|→|ChartExchange|承襲|上一份|報告', pre[-30:]):
            continue
        c['sma'][n] = _f(m.group(2))
    ml = re.search(r'SMA\s*10\s*/\s*20\s*/\s*50\s*/\s*150\s*/\s*200\s*[=＝]\s*' + DEC + r'\s*/\s*' + DEC + r'\s*/\s*' + DEC + r'\s*/\s*' + DEC + r'\s*/\s*' + DEC, t)
    if ml:
        for n, g in zip((10, 20, 50, 150, 200), ml.groups()):
            c['sma'].setdefault(n, _f(g))
    h = re.search(r'52\s*週高\s*[:：]?\s*\$?\s*' + DEC, t)
    l = re.search(r'52\s*週低\s*[:：]?\s*\$?\s*' + DEC, t)
    c['hi52'] = _f(h.group(1)) if h else None
    c['lo52'] = _f(l.group(1)) if l else None
    s = re.search(r'(\d{1,3})\s*[／/]\s*100', t)
    c['score'] = int(s.group(1)) if s else None
    return c


# ───────────── 核對 ─────────────
_cache = {}


def fetch_rows(ticker, cache_dir=None):
    if ticker in _cache:
        return _cache[ticker]
    p = os.path.join(cache_dir, ticker + '.json') if cache_dir else None
    d = None
    if p and os.path.exists(p):
        d = json.load(open(p))
    else:
        try:
            with urllib.request.urlopen('%s/api/ohlcv?t=%s&range=2y' % (SITE, ticker), timeout=90) as r:
                d = json.load(r)
            if p:
                os.makedirs(cache_dir, exist_ok=True)
                json.dump(d, open(p, 'w'))
        except Exception:
            d = None
    rows = sorted(d['rows'], key=lambda x: x['d']) if d and d.get('rows') else None
    _cache[ticker] = rows
    return rows


def price_ok(claim, actual):
    return abs(claim - actual) <= max(0.02, abs(actual) * 0.0005)


def item(name, claim, actual, status, note=''):
    return {'item': name, 'claim': claim, 'actual': None if actual is None else round(actual, 4), 'status': status, 'note': note}


def verify(c, cache_dir=None, otc=()):
    out = {'file': c['file'], 'ticker': c['ticker'], 'date': c['date'], 'items': [], 'lag': False, 'verifiable': False, 'note': ''}
    if c.get('note'):
        out['note'] = c['note']
        return out
    if not c.get('ticker') or not c.get('date'):
        out['note'] = '代號或日期解析唔到'
        return out
    rows = fetch_rows(c['ticker'], cache_dir)
    if not rows:
        out['note'] = '未能核對（行情攞唔到）'
        return out
    idx = [i for i, r in enumerate(rows) if r['d'] <= c['date']]
    if not idx:
        out['note'] = '未能核對（行情冇該日期）'
        return out
    i = idx[-1]
    if rows[i]['d'] != c['date']:
        out['note'] = '聲稱日期 %s 非交易日，改用 %s 核對' % (c['date'], rows[i]['d'])
    r = rows[i]
    prev = rows[i - 1] if i >= 1 else None
    its = out['items']
    cl = c.get('close')
    if cl is not None:
        if price_ok(cl, r['c']):
            its.append(item('收市價', cl, r['c'], 'OK'))
        elif prev and price_ok(cl, prev['c']):
            its.append(item('收市價', cl, r['c'], '錯誤', '落後一日（等於 %s 收市 %.4f）' % (prev['d'], prev['c'])))
            out['lag'] = True
        elif c['ticker'] in otc and abs(cl - r['c']) / r['c'] <= 0.005:
            its.append(item('收市價', cl, r['c'], '來源差異', 'OTC／ADR 成交疏，收市價來源差 ≤0.5%'))
        else:
            nx = rows[i + 1] if i + 1 < len(rows) else None
            its.append(item('收市價', cl, r['c'], '錯誤', '等於次日收市（超前）' if nx and price_ok(cl, nx['c']) else ''))
    pv = c.get('prev')
    if pv is not None and prev:
        if price_ok(pv, prev['c']):
            its.append(item('前收', pv, prev['c'], 'OK'))
        else:
            its.append(item('前收', pv, prev['c'], '錯誤'))
    pct = c.get('pct')
    if pct is not None and prev:
        act = (r['c'] / prev['c'] - 1) * 100
        dpc = abs(pct - act)
        st = 'OK' if dpc <= 0.05 else ('來源差異' if c['ticker'] in otc and dpc <= 0.5 else '錯誤')
        its.append(item('升跌%', pct, act, st))
    for k, lab in (('open', '開市價'), ('high', '日高'), ('low', '日低')):
        v = c.get(k)
        if v is not None:
            a = r[{'open': 'o', 'high': 'h', 'low': 'l'}[k]]
            st = 'OK' if price_ok(v, a) else ('來源差異' if c['ticker'] in otc and abs(v - a) / a <= 0.005 else '錯誤')
            its.append(item(lab, v, a, st))
    vol = c.get('volume')
    if vol:
        d = abs(vol - r['v']) / r['v'] * 100 if r['v'] else 999
        st = 'OK' if d <= 0.5 else ('來源差異' if d <= 3 else '錯誤')
        its.append(item('成交量', vol, r['v'], st, '差 %.2f%%' % d + ('（量差>3%）' if d > 3 else '')))
    for n, v in sorted((c.get('sma') or {}).items(), key=lambda kv: int(kv[0])):
        n = int(n)
        if i + 1 < n:
            continue
        a = sum(x['c'] for x in rows[i - n + 1:i + 1]) / n
        d = abs(v - a) / a * 100
        if d <= 0.05:
            its.append(item('SMA%d' % n, v, a, 'OK'))
        else:
            note = '差 %.3f%%' % d
            st = '錯誤'
            if i >= n:
                a1 = sum(x['c'] for x in rows[i - n:i]) / n
                if abs(v - a1) / a1 * 100 <= 0.05:
                    note += '；等於前一日 SMA（落後一日）'
            if c.get('adj_hint') and 1 <= d <= 5:
                st, note = '來源差異', note + '；復權差異'
            its.append(item('SMA%d' % n, v, a, st, note))
    for k, lab, fn in (('hi52', '52週高', max), ('lo52', '52週低', min)):
        v = c.get(k)
        if v is not None and i >= 200:
            w = rows[max(0, i - 251):i + 1]
            ai = fn(x['h' if k == 'hi52' else 'l'] for x in w)
            ac = fn(x['c'] for x in w)
            ok = price_ok(v, ai) or price_ok(v, ac)
            its.append(item(lab, v, ai, 'OK' if ok else '錯誤', '' if ok else '（收市基準 %.2f）' % ac))
    out['verifiable'] = bool(its)
    if not its:
        out['note'] = (out['note'] + '；' if out['note'] else '') + '卡內抽唔到可核對數字'
    return out


def main():
    a = sys.argv[1:]
    if not a:
        print(__doc__); return
    if a[0] == 'extract':
        print(json.dumps(extract(open(a[1], encoding='utf-8').read(), a[2]), ensure_ascii=False, indent=1))
    elif a[0] == 'verify':
        cache = a[a.index('--cache') + 1] if '--cache' in a else None
        claims = json.load(open(a[1], encoding='utf-8'))
        otc = tuple(a[a.index('--otc') + 1].split(',')) if '--otc' in a else ()
        print(json.dumps([verify(c, cache, otc) for c in claims], ensure_ascii=False, indent=1))
    else:
        print(__doc__)


if __name__ == '__main__':
    main()
