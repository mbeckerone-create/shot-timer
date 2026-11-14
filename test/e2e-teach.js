const { chromium } = require('playwright');
(async () => {
  const [fake, out] = process.argv.slice(2);
  const b = await chromium.launch({ args: ['--use-fake-ui-for-media-stream', '--use-fake-device-for-media-stream', `--use-file-for-fake-audio-capture=${fake}`, '--autoplay-policy=no-user-gesture-required'] });
  const p = await b.newPage({ viewport: { width: 390, height: 844 } });
  const errs = []; p.on('pageerror', (e) => errs.push(e.message));
  await p.addInitScript(() => localStorage.setItem('st.settings', JSON.stringify({ mode: 'dry' })));
  await p.goto('http://localhost:8765/?v=' + Date.now());
  await p.evaluate(() => enterDrill(S.mode, S.dryDrill));
  await p.click('#btn-review');
  let last = '';
  for (let i = 0; i < 60; i++) { const s = (await p.textContent('#status')) + ' | ' + (await p.textContent('#big')); if (s !== last) { console.log(s); last = s; } if (s.startsWith('Click learned') || s.startsWith('Not enough')) break; await p.waitForTimeout(500); }
  console.log('info:', await p.textContent('#beepinfo'));
  console.log('errors:', errs.join(';') || 'none'); await b.close();
})();
