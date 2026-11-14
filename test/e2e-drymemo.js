const { chromium } = require('playwright'); const fs = require('fs');
(async () => {
  const [fake, tplFile] = process.argv.slice(2), tpl = JSON.parse(fs.readFileSync(tplFile));
  const b = await chromium.launch({ args: ['--use-fake-ui-for-media-stream', '--use-fake-device-for-media-stream', `--use-file-for-fake-audio-capture=${fake}`, '--autoplay-policy=no-user-gesture-required'] });
  const p = await b.newPage(); const errs = []; p.on('pageerror', (e) => errs.push(e.message));
  await p.addInitScript((t) => localStorage.setItem('st.settings', JSON.stringify(Object.assign({ mode: 'dry', dryRepeat: true, dmin: 0.3, dmax: 0.6, dryReholster: 2, dryTimeout: 8 }, t))), tpl);
  await p.goto('http://localhost:8765/?v=' + Date.now());
  await p.evaluate(() => enterDrill(S.mode, S.dryDrill));
  // log every judged sound with its absolute position in the looping memo (34 s loop)
  await p.click('#btn-main'); await p.waitForTimeout(70000); await p.click('#btn-main');
  console.log('status:', await p.textContent('#status'));
  const reps = await p.evaluate(() => JSON.parse(localStorage.getItem('st.history') || '[]').map((h) => h.shots[0].t.toFixed(3) + '(' + h.match + ')'));
  console.log('accepted draws:', reps.join(' '));
  console.log('errors:', errs.join(';') || 'none'); await b.close();
})();
