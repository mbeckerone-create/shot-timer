const { chromium } = require('playwright');
(async () => {
  const fake = process.argv[2];
  const b = await chromium.launch({ args: ['--use-fake-ui-for-media-stream', '--use-fake-device-for-media-stream', `--use-file-for-fake-audio-capture=${fake}`, '--autoplay-policy=no-user-gesture-required'] });
  const p = await b.newPage({ viewport: { width: 390, height: 844 }, deviceScaleFactor: 2 });
  const logs = []; p.on('console', m => logs.push(m.text())); p.on('pageerror', e => logs.push('ERR ' + e.message));
  await p.addInitScript(() => localStorage.setItem('st.settings', JSON.stringify({ dmin: 0.5, dmax: 0.5, auto: 3, shooters: ['Me', 'Jake', 'Gannon'], guns: ['Glock 19', 'AR-15'] })));
  await p.goto('http://localhost:8765/');
  await p.screenshot({ path: process.argv[3] + '/e2e-0-ready.png' });
  await p.click('#btn-main');
  await p.waitForTimeout(800);
  await p.screenshot({ path: process.argv[3] + '/e2e-1-live.png' });
  await p.waitForTimeout(3500); await p.click('#btn-main'); await p.waitForTimeout(300);
  await p.screenshot({ path: process.argv[3] + '/e2e-2-done.png' });
  const res = await p.evaluate(() => ({ status: document.getElementById('status').textContent, info: document.getElementById('beepinfo').textContent, big: big.textContent,
    shots: [...document.querySelectorAll('#shotlist li:not(.head)')].map(li => li.textContent), hist: JSON.parse(localStorage.getItem('st.history') || '[]').length }));
  console.log(JSON.stringify(res, null, 1));
  await p.click('.tab[data-view=history]'); await p.waitForTimeout(200); await p.click('.card'); await p.screenshot({ path: process.argv[3] + '/e2e-3-history.png' });
  await p.click('.tab[data-view=settings]'); await p.screenshot({ path: process.argv[3] + '/e2e-4-settings.png' });
  console.log('console:', logs.join(' | ') || '(clean)');
  await b.close();
})();
