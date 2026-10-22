// 用 signals.js 嘅 parseCard／classify 測行動卡 PDF：node tools/stockreport/sigtest.js card.pdf …（要先喺 repo 根目錄 npm ci）
const s = require('../../signals.js'), fs = require('fs');
(async () => { for (const f of process.argv.slice(2)) { const raw = await s.pdfText(fs.readFileSync(f)); const c = s.parseCard(raw, ''); console.log(f.split('/').pop(), JSON.stringify({date: c.date, ticker: c.titleTicker, stars: c.stars, rating: c.rating, score: c.score, flat: c.flat, held: c.held, close: c.close, levels: c.levels, alerts: c.alerts.length}), JSON.stringify(s.classify(c))); } })();
