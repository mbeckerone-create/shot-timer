// v0.8.1 History: session cards with stats, filter, open detail, expand a string, swipe left to delete.
// usage: node test/e2e-history.js outdir   (needs the app served on :8765)
const { chromium } = require('playwright');
const out = process.argv[2];
(async () => {
  const b = await chromium.launch();
  const ctx = await b.newContext({ viewport: { width: 390, height: 844 }, deviceScaleFactor: 2, hasTouch: false });
  const p = await ctx.newPage(); const errs = []; p.on('pageerror', (e) => errs.push(e.message)); p.on('console', (m) => m.type() === 'error' && errs.push('console: ' + m.text()));
  await p.addInitScript(() => {
    if (localStorage.getItem('seeded')) return; localStorage.setItem('seeded', 1);
    const at = (d, h, m, s = 0) => new Date(2026, 10, d, h, m, s).toISOString();
    const shots = (arr) => arr.map((t) => ({ t, db: -10 }));
    const H = [];
    const names = ['Michael Becker', 'Jake', 'Gannon'];
    for (let i = 0; i < 9; i++) H.push({ at: at(14, 9, 20 + i), session: 'sA', mode: 'range', shooter: names[i % 3], gun: 'Glock 19', drillName: 'Bill Drill', par: 2.5, rep: Math.floor(i / 3) + 1,
      shots: shots([1.12 + i * .04, 1.4 + i * .04, 1.65 + i * .04, 1.9 + i * .04, 2.15 + i * .05, 2.38 + i * .06]), clip: i % 3 === 0 ? 'ST-2026-11-14-0912-clip1' : undefined, clipT: 30 + i * 20,
      score: i === 0 ? { hits: { 1: { A: 6 } }, points: 30, count: 6, hf: 12.6 } : undefined });
    for (let i = 0; i < 4; i++) H.push({ at: at(14, 10, i), session: 'sA', mode: 'range', shooter: 'Michael Becker', gun: 'Glock 19', shots: shots([1.31 + i * .1, 1.9, 2.5, 3.1, 3.8]) });
    for (let i = 0; i < 12; i++) H.push({ at: at(20, 19, i), session: 'sB', mode: 'dry', drill: i < 8 ? 'draw' : 'reload', shooter: 'Michael Becker', gun: 'Glock 19', shots: shots([0.98 + i * .03, 2.4]), react: 0.4, split: 0.6, reload: i < 8 ? undefined : 2.2 + i * .05 });
    for (let i = 0; i < 3; i++) H.push({ at: at(7, 15, i), mode: 'range', shooter: 'Michael Becker', gun: 'Glock 19', shots: shots([1.5, 2.1, 2.7]) });
    H.sort((x, y) => (x.at < y.at ? 1 : -1));
    localStorage.setItem('st.history', JSON.stringify(H));
    localStorage.setItem('st.sessions', JSON.stringify([{ id: 'sB', name: 'Dry fire · Nov 20', start: at(20, 19, 0), end: at(20, 19, 40), clips: [] }, { id: 'sA', name: 'Range · Nov 14', start: at(14, 9, 12), end: at(14, 11, 5), clips: [{ name: 'ST-2026-11-14-0912-clip1', start: at(14, 9, 12) }] }]));
    localStorage.setItem('st.settings', JSON.stringify({ shooters: ['Michael Becker', 'Jake', 'Gannon'], shooter: 'Michael Becker' }));
  });
  await p.goto('http://localhost:8765/?v=' + Date.now()); await p.waitForTimeout(600);
  console.log('skin:', await p.evaluate(() => document.documentElement.dataset.skin));
  await p.click('.tab[data-view="history"]'); await p.waitForTimeout(250);
  console.log('cards:', await p.locator('.hs-card').count(), '| best:', (await p.textContent('#hs-best')).replace(/\s+/g, ' '));
  await p.screenshot({ path: out + '/h-list.png' });
  await p.click('.hs-pills button[data-f="dry"]'); console.log('dry filter cards:', await p.locator('.hs-card').count()); await p.click('.hs-pills button[data-f="all"]');
  await p.click('.hs-card:has-text("Nov 14") .hs-ses'); await p.waitForTimeout(250);
  console.log('detail:', await p.evaluate(() => document.querySelector('.view.active').id), '|', await p.textContent('#ses-title-h'), '|', await p.textContent('#hd-sub'), '|', (await p.textContent('#hd-stats')).replace(/\s+/g, ' '));
  await p.click('.hd-str >> nth=0'); await p.waitForTimeout(100);
  await p.screenshot({ path: out + '/h-detail.png' });
  await p.click('#hd-who button >> nth=2'); console.log('Jake rows:', await p.locator('.hd-str:visible').count());
  await p.screenshot({ path: out + '/h-detail-jk.png' });
  await p.click('#ses-back'); await p.waitForTimeout(200);
  // swipe the Nov 7 card left
  const box = await p.locator('.hs-card:has-text("Nov 7") .hs-ses').boundingBox();
  p.once('dialog', (d) => { console.log('confirm:', d.message()); d.accept(); });
  await p.mouse.move(box.x + box.width - 20, box.y + 30); await p.mouse.down();
  for (let i = 1; i <= 10; i++) await p.mouse.move(box.x + box.width - 20 - i * 16, box.y + 30);
  await p.mouse.up(); await p.waitForTimeout(300);
  console.log('cards after swipe delete:', await p.locator('.hs-card').count());
  await p.click('.tab[data-view="settings"]'); await p.selectOption('#set-skin', 'soft'); await p.click('.tab[data-view="history"]'); await p.waitForTimeout(200);
  await p.screenshot({ path: out + '/h-list-light.png' });
  await p.selectOption('#set-skin', 'softdark').catch(() => {});
  console.log('errors:', errs.join(' | ') || 'none'); await b.close();
})();
