const { chromium } = require('playwright'); const fs = require('fs');
(async () => {
  const [fake, tplFile, out] = process.argv.slice(2), tpl = JSON.parse(fs.readFileSync(tplFile));
  const b = await chromium.launch({ args: ['--use-fake-ui-for-media-stream', '--use-fake-device-for-media-stream', `--use-file-for-fake-audio-capture=${fake}`, '--autoplay-policy=no-user-gesture-required'] });
  const ctx = await b.newContext({ viewport: { width: 390, height: 844 }, deviceScaleFactor: 2, acceptDownloads: true });
  const p = await ctx.newPage(); const errs = []; p.on('pageerror', (e) => errs.push(e.message));
  await p.addInitScript((t) => localStorage.setItem('st.settings', JSON.stringify(Object.assign({ mode: 'dry', dryDrill: 'draw', dryRepeat: true, dmin: 0.3, dmax: 0.8, dryReholster: 2, dryTimeout: 6 }, t))), tpl);
  await p.goto('http://localhost:8765/?v=' + Date.now());
  await p.evaluate(() => enterDrill(S.mode, S.dryDrill));
  await p.click('#chip-film'); await p.waitForTimeout(1500);
  console.log('film chip:', await p.textContent('#lbl-film'));
  await p.click('#btn-main'); await p.waitForTimeout(25000);
  await p.screenshot({ path: out + '/film.png' });
  await p.click('#btn-main'); await p.waitForTimeout(500);
  await p.click('#chip-film'); await p.waitForTimeout(2000);
  console.log('dialog:', await p.textContent('#film-info'));
  const dls = []; p.on('download', (d) => dls.push(d));
  await p.click('#btn-film-share'); await p.waitForTimeout(3000);
  for (const d of dls) { const f = out + '/' + d.suggestedFilename(); await d.saveAs(f); console.log('saved', f); }
  console.log('errors:', errs.join(';') || 'none'); await b.close();
})();
