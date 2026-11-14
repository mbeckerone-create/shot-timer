const { chromium } = require('playwright');
(async () => {
  const [fake, out] = process.argv.slice(2);
  const b = await chromium.launch({ args: ['--use-fake-ui-for-media-stream', '--use-fake-device-for-media-stream', `--use-file-for-fake-audio-capture=${fake}`, '--autoplay-policy=no-user-gesture-required'] });
  const p = await b.newPage({ viewport: { width: 390, height: 844 }, deviceScaleFactor: 2 });
  const errs = []; p.on('pageerror', (e) => errs.push(e.message));
  await p.addInitScript(() => localStorage.setItem('st.settings', JSON.stringify({ dmin: 0.5, dmax: 1.5, dryReholster: 2, mode: 'dry' })));
  await p.goto('http://localhost:8765/?v=' + Date.now());
  await p.evaluate(() => enterDrill(S.mode, S.dryDrill));
  // 1) teach: the fake mic plays holster + trigger pairs; the template should keep the trigger-like majority? (equal mix -> report)
  await p.click('#btn-review'); await p.waitForTimeout(9000);
  if (await p.textContent('#btn-main') === 'DONE') await p.click('#btn-main');
  console.log('teach:', await p.textContent('#status'), '|', await p.textContent('#beepinfo'));
  // 2) repeat drill
  await p.click('#btn-main'); await p.waitForTimeout(14000);
  await p.screenshot({ path: out + '/dry.png' });
  await p.click('#btn-main');
  console.log('drill:', await p.textContent('#status'));
  console.log('reps:', (await p.locator('#shotlist li:not(.head)').allTextContents()).join(' | '));
  const hist = await p.evaluate(() => JSON.parse(localStorage.getItem('st.history') || '[]').map((h) => h.mode + ':' + h.shots[0].t + ':' + h.match));
  console.log('history:', hist.join(' '));
  console.log('errors:', errs.join(';') || 'none'); await b.close();
})();
