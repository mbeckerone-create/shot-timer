const { chromium } = require('playwright'); const fs = require('fs');
(async () => {
  const [fake, tplFile, out] = process.argv.slice(2), tpl = JSON.parse(fs.readFileSync(tplFile));
  const b = await chromium.launch({ args: ['--use-fake-ui-for-media-stream', '--use-fake-device-for-media-stream', `--use-file-for-fake-audio-capture=${fake}`, '--autoplay-policy=no-user-gesture-required'] });
  const p = await b.newPage({ viewport: { width: 390, height: 844 }, deviceScaleFactor: 2 }); const errs = []; p.on('pageerror', (e) => errs.push(e.message));
  await p.addInitScript((t) => localStorage.setItem('st.settings', JSON.stringify(Object.assign({ mode: 'dry', dryDrill: 'draw', dryRepeat: true, dmin: 0.3, dmax: 0.8, dryReholster: 2, dryTimeout: 6 }, t))), tpl);
  await p.goto('http://localhost:8765/?v=' + Date.now());
  console.log('ready:', await p.textContent('#status'));
  await p.click('#btn-main'); await p.waitForTimeout(60000);
  await p.screenshot({ path: out + '/draw.png' }); await p.click('#btn-main');
  console.log('status:', await p.textContent('#status'));
  const reps = await p.evaluate(() => JSON.parse(localStorage.getItem('st.history') || '[]').reverse().map((h) => `${h.drill} shot ${h.shots[0].t.toFixed(3)} react ${h.react ?? '—'} split ${h.react != null ? (h.shots[0].t - h.react).toFixed(3) : '—'}`));
  console.log(reps.join('\n'));
  console.log('errors:', errs.join(';') || 'none'); await b.close();
})();
