const { chromium } = require('playwright');
(async () => {
  const [fake, out] = process.argv.slice(2);
  const b = await chromium.launch({ args: ['--use-fake-ui-for-media-stream', '--use-fake-device-for-media-stream', `--use-file-for-fake-audio-capture=${fake}`, '--autoplay-policy=no-user-gesture-required'] });
  const p = await b.newPage({ viewport: { width: 390, height: 844 } });
  const errs = []; p.on('pageerror', e => errs.push(e.message));
  await p.addInitScript((extra) => localStorage.setItem('st.settings', JSON.stringify(Object.assign({ dmin: 1, dmax: 1, auto: 0 }, JSON.parse(extra)))), process.env.EXTRA || '{}');
  await p.goto('http://localhost:8765/?v=' + Date.now());
  await p.click('#btn-main'); await p.waitForTimeout(7500);
  console.log('beepinfo:', await p.textContent('#beepinfo'));
  console.log('shots:', await p.locator('#shotlist li:not(.head)').count());
  await p.click('#btn-main');
  await p.click('.tab[data-view=settings]'); await p.locator('#diag').scrollIntoViewIfNeeded();
  console.log('diag:\n' + await p.textContent('#diag'));
  await p.screenshot({ path: out + '/diag.png' });
  console.log('errors:', errs.join(';') || 'none'); await b.close();
})();
