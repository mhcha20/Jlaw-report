#!/usr/bin/env python3
"""build.py <TICKER> <DATE> <work.py> [--market-note ...]
work.py 要有 spec(m) 同 texts(m, S) 兩個函數（見 examples/）。
先跑 `python3 prep.py data <TICKER> <DATE>`。輸出：out/<DATE>_<TICKER>_{行動卡,股票分析終極報告,核對附錄}.pdf
"""
import importlib.util, json, os, subprocess, sys
HERE = os.path.dirname(os.path.abspath(__file__)); os.chdir(HERE); sys.path.insert(0, HERE)
from lib import *
import gen
from gen import *
from gen2 import *
t, date, work = sys.argv[1], sys.argv[2], sys.argv[3]
gen.DATE = date
import gen2; gen2.DATE = date
y, mo, d = date.split('-'); wd = '一二三四五六日'[__import__('datetime').date(int(y), int(mo), int(d)).weekday()]
gen.DATE_ZH = gen2.DATE_ZH = f'{date}（{wd}）'
spec_ = importlib.util.spec_from_file_location('work', work); w = importlib.util.module_from_spec(spec_); spec_.loader.exec_module(w)
m = metrics(t); S = w.spec(m); S = plan_numbers(m, S); T = w.texts(m, S)
assert len(S['action']) <= 40, ('今日動作超過 40 字', len(S['action']))
assert len(T['script3']) <= 950 and len(T['scriptfull']) <= 3500, '朗讀稿超出字數上限'
os.makedirs('out', exist_ok=True)
names = {'card': f'{date}_{t}_行動卡', 'rep': f'{date}_{t}_股票分析終極報告', 'app': f'{date}_{t}_核對附錄'}
open(f'{names["card"]}.html', 'w').write(page(f'{t} 一頁行動卡', build_card(m, S, T), S))
open(f'{names["rep"]}.html', 'w').write(page(f'{t} 本體報告', build_report(m, S, T), S))
open(f'{names["app"]}.html', 'w').write(page(f'{t} 核對附錄', build_appendix(m, S, T), S))
jobs = [dict(html=f'{names["card"]}.html', pdf=f'out/{names["card"]}.pdf', footer=f'{t} 一頁行動卡 · {date}'),
        dict(html=f'{names["rep"]}.html', pdf=f'out/{names["rep"]}.pdf', footer=f'{t} 本體報告 · {date}'),
        dict(html=f'{names["app"]}.html', pdf=f'out/{names["app"]}.pdf', footer=f'{t} 核對附錄 · {date}')]
json.dump(jobs, open(f'out/jobs_{t}.json', 'w'))
subprocess.check_call(['node', 'render.js', f'out/jobs_{t}.json'])
res = {}
for j in jobs:
    n = subprocess.run(['pdfinfo', j['pdf']], capture_output=True, text=True).stdout
    res[j['pdf']] = int([l for l in n.splitlines() if l.startswith('Pages')][0].split()[1])
print(json.dumps({'ticker': t, 'date': date, 'score': round(S['score'], 1), 'rating': S['rating'], 'tier': S['tier'], 'pages': res}, ensure_ascii=False))
assert res[jobs[0]['pdf']] == 1, '行動卡超過 1 頁'
assert res[jobs[1]['pdf']] <= 10, '本體報告超過 10 頁'
