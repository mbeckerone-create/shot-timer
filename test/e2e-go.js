const { chromium } = require('playwright');
(async () => {
  const [fake, out] = process.argv.slice(2);
  const b = await chromium.launch({ args: ['--use-fake-ui-for-media-stream', '--use-fake-device-for-media-stream', `--use-file-for-fake-audio-capture=${fake}`, '--autoplay-policy=no-user-gesture-required'] });
  const p = await b.newPage({ viewport: { width: 390, height: 844 } });
  const errs = []; p.on('pageerror', e => errs.push(e.message));
  await p.addInitScript(() => localStorage.setItem('st.settings', JSON.stringify({ dmin: 2, dmax: 2, auto: 0 })));
  await p.goto('http://localhost:8765/?v=' + Date.now());
  await p.click('#btn-main');
  const t0 = Date.now(); const seen = [];
  while (Date.now() - t0 < 4500) { seen.push([Date.now() - t0, await p.textContent('#status'), await p.textContent('#big'), await p.locator('#shotlist li:not(.head)').count()]); await p.waitForTimeout(150); }
  await p.screenshot({ path: out + '/go.png' });
  await p.click('#btn-main');
  let last = ''; for (const r of seen) { const k = r[1] + '|' + (r[3] > 0); if (k !== last) { console.log(r.join('  ')); last = k; } }
  console.log('final shots:', await p.locator('#shotlist li:not(.head)').count(), 'info:', await p.textContent('#beepinfo'), 'errors:', errs.join(';') || 'none');
  await b.close();
})();
