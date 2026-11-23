// Range + Repeat while filming, fed real range audio as the mic. Checks: stays in Range (listens for shots, not
// clicks), strings repeat on their own, the own-gun gate strikes out quiet bangs, the clip is kept in IndexedDB with a
// session-matched name, records carry clip + clipT, and History › session opens a detail page.
// usage: node test/e2e-range-repeat.js range.wav outdir   (needs the app served on :8765)
const { chromium } = require('playwright');
(async () => {
  const [fake, out] = process.argv.slice(2);
  const b = await chromium.launch({ args: ['--use-fake-ui-for-media-stream', '--use-fake-device-for-media-stream', `--use-file-for-fake-audio-capture=${fake}`, '--autoplay-policy=no-user-gesture-required'] });
  const ctx = await b.newContext({ viewport: { width: 390, height: 844 }, deviceScaleFactor: 1 });
  const p = await ctx.newPage(); const errs = []; p.on('pageerror', (e) => errs.push(e.message)); p.on('dialog', (d) => d.accept());
  await p.addInitScript(() => localStorage.setItem('st.settings', JSON.stringify({ mode: 'dry', dryDrill: 'trigger', dryRepeat: true, sens: 10, dmin: 0.5, dmax: 1, rangeReset: 2, auto: 3 })));
  await p.goto('http://localhost:8765/?v=' + Date.now());
  await p.click('.h-mode[data-go="range"]'); await p.waitForTimeout(300); await p.click('#ses-btn'); await p.waitForTimeout(300);   // v0.8: Range screen, Start = session + free shooting
  await p.click('#seg-rep button[data-rep="repeat"]');
  console.log('after Repeat tap: mode =', await p.evaluate(() => S.mode), '| status:', await p.textContent('#status'));
  await p.click('#chip-film'); await p.waitForTimeout(1200);
  await p.click('#btn-main');
  for (let i = 0; i < 9; i++) { await p.waitForTimeout(3000); console.log(`  ${(i + 1) * 3}s`, await p.evaluate(() => S.mode), '|', await p.textContent('#status'), '|', await p.textContent('#beepinfo')); }
  await p.screenshot({ path: out + '/range-repeat.png' });
  await p.click('#btn-main'); await p.waitForTimeout(500);
  await p.click('#chip-film'); await p.waitForTimeout(2000);
  console.log('film dialog:', (await p.textContent('#film-info')).replace(/\n/g, ' | '), '|', await p.textContent('#film-kept'));
  await p.click('#btn-film-close');
  const recs = await p.evaluate(() => history.map((r) => ({ mode: r.mode, n: r.shots.length, kept: r.shots.filter((s) => !s.removed).length, gated: r.shots.filter((s) => s.gated).length, clip: r.clip, clipT: r.clipT })));
  console.log('records:', JSON.stringify(recs));
  console.log('clips in IndexedDB:', JSON.stringify(await p.evaluate(async () => (await clipDB.list()).map((c) => [c.name, c.video.size]))));
  await p.click('.tab[data-view="history"]'); await p.waitForTimeout(300);
  await p.click('.card.ses .who'); await p.waitForTimeout(500);
  console.log('screen:', await p.evaluate(() => screen), '| title:', await p.textContent('#ses-title'));
  await p.screenshot({ path: out + '/session-detail.png', fullPage: true });
  await p.click('#ses-back'); await p.click('.tab[data-view="train"]'); await p.waitForTimeout(200);
  await p.click('#btn-back'); await p.waitForTimeout(300);
  await p.evaluate(() => showScreen('home')); await p.waitForTimeout(300);
  console.log('home reminder:', await p.evaluate(() => !$('clip-note').hidden && $('clip-note').textContent));
  console.log('errors:', errs.join(';') || 'none'); await b.close();
})();
