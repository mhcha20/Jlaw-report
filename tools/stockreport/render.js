const { chromium } = require('/opt/node22/lib/node_modules/playwright');
const path = require('path'), fs = require('fs');
(async () => {
  const jobs = JSON.parse(fs.readFileSync(process.argv[2], 'utf8'));
  const browser = await chromium.launch();
  for (const j of jobs) {
    const page = await browser.newPage();
    await page.goto('file://' + path.resolve(j.html), { waitUntil: 'networkidle' });
    await page.evaluate(() => document.fonts.ready);
    const footer = `<div style="width:100%;font-size:7.5pt;color:#222;padding:0 9.8mm;text-align:center;color:#777;font-family:'Noto Sans CJK TC','WenQuanYi Zen Hei',sans-serif">${j.footer} · <span class="pageNumber"></span>／<span class="totalPages"></span></div>`;
    await page.pdf({ path: j.pdf, format: 'A4', printBackground: true, displayHeaderFooter: true,
      headerTemplate: '<div></div>', footerTemplate: footer,
      margin: { top: '10mm', bottom: '13mm', left: '9.8mm', right: '10mm' } });
    await page.close();
  }
  await browser.close();
  console.log('rendered', jobs.length);
})();
