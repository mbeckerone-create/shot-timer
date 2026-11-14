const { chromium } = require('playwright'); const fs = require('fs');
(async () => {
  const [fake, tplFile, out] = process.argv.slice(2), tpl = JSON.parse(fs.readFileSync(tplFile));
  const b = await chromium.launch({ args: ['--use-fake-ui-for-media-stream', '--use-fake-device-for-media-stream', `--use-file-for-fake-audio-capture=${fake}`, '--autoplay-policy=no-user-gesture-required'] });
  const ctx = await b.newContext({ viewport: { width: 390, height: 844 }, deviceScaleFactor: 2, acceptDownloads: true });
  const p = await ctx.newPage(); const errs = []; p.on('pageerror', (e) => errs.push(e.message));
  p.on('dialog', (d) => d.type() === 'prompt' ? d.accept('Test session') : d.accept());
  await p.addInitScript((t) => { localStorage.setItem('st.settings', JSON.stringify(Object.assign({ mode: 'dry', dryDrill: 'draw', dryRepeat: true, dmin: 0.3, dmax: 0.8, dryReholster: 2, dryTimeout: 6 }, t)));
    localStorage.setItem('st.history', JSON.stringify([{ id: 'old1', mode: 'dry', drill: 'trigger', at: '2026-11-01T00:00:00Z', shooter: 'Me', gun: 'Pistol', shots: [{ t: 1.5 }] }])); }, tpl);
  await p.goto('http://localhost:8765/?v=' + Date.now());
  await p.click('#btn-ses'); console.log('session bar:', await p.textContent('#ses-text'));
  await p.click('#chip-film'); await p.waitForTimeout(1200);
  await p.click('#btn-main'); await p.waitForTimeout(16000);
  await p.screenshot({ path: out + '/film-full.png' });
  await p.click('#btn-main'); await p.waitForTimeout(400);
  await p.click('#chip-film'); await p.waitForTimeout(1500); await p.click('#btn-film-close');
  console.log('session bar:', await p.textContent('#ses-text'));
  await p.click('#btn-ses'); await p.waitForTimeout(300);
  console.log('end dialog:', await p.textContent('#ses-dlg-info'));
  const dls = []; p.on('download', (d) => dls.push(d));
  await p.click('#btn-ses-export'); await p.waitForTimeout(2000);
  for (const d of dls) { const f = out + '/' + d.suggestedFilename(); await d.saveAs(f); console.log('saved', d.suggestedFilename()); }
  console.log('errors:', errs.join(';') || 'none'); await b.close();
})();
