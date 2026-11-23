// v0.8 design: home -> Range (shooters, drill) -> Start -> drill run -> voice score -> back -> voice-built drill -> styles.
// usage: node test/e2e-v08-design.js range.wav outdir   (needs the app served on :8765)
const { chromium } = require('playwright');
const out = process.argv[3];
(async () => {
  const b = await chromium.launch({ args: ['--use-fake-ui-for-media-stream', '--use-fake-device-for-media-stream', `--use-file-for-fake-audio-capture=${process.argv[2]}`, '--autoplay-policy=no-user-gesture-required'] });
  const ctx = await b.newContext({ viewport: { width: 390, height: 844 }, deviceScaleFactor: 2 });
  const p = await ctx.newPage(); const errs = []; p.on('pageerror', (e) => errs.push(e.message)); p.on('console', (m) => m.type() === 'error' && errs.push('console: ' + m.text()));
  await p.addInitScript(() => localStorage.setItem('st.settings', JSON.stringify({ sens: 10, dmin: 0.5, dmax: 1, rangeReset: 2, auto: 3, shooters: ['Me', 'Jake', 'Gannon'], shooter: 'Me' })));
  await p.goto('http://localhost:8765/?v=' + Date.now()); await p.waitForTimeout(600);
  const scr = () => p.evaluate(() => document.querySelector('.view.active').id);
  await p.screenshot({ path: out + '/a-home.png' }); console.log('home:', await scr(), '| zoom', await p.evaluate(() => getComputedStyle(document.getElementById('app')).getPropertyValue('--z')));
  await p.click('.h-mode[data-go="range"]'); await p.waitForTimeout(200); await p.screenshot({ path: out + '/a-range.png' }); console.log('range:', await scr(), '| btn', await p.textContent('#ses-btn'));
  await p.click('#sc-tog'); await p.waitForTimeout(300); await p.click('#who-q'); await p.click('#who-results button:has-text("Jake")'); await p.locator('#who-q').blur();
  console.log('shooters:', await p.textContent('#hub-who'), '/', await p.textContent('#hub-added'));
  await p.click('#hub-dlist .hd-row:has-text("Bill Drill") .hd-txt').catch(async () => { await p.click('#hub-dlist .hd-more'); await p.click('#hub-dlist .hd-row:has-text("Bill Drill") .hd-txt'); });
  await p.click('#ses-btn'); await p.waitForTimeout(300); console.log('timer:', await scr(), '|', await p.textContent('#drill-title'), '| plan visible', await p.isVisible('#p-plan'));
  await p.screenshot({ path: out + '/a-timer.png' });
  await p.click('#btn-main');
  for (let i = 0; i < 12; i++) { await p.waitForTimeout(1500); console.log('  ', await p.textContent('#status'), '|', await p.textContent('#beepinfo'), '|', await p.textContent('#pl-round')); }
  await p.screenshot({ path: out + '/a-timer2.png' });
  await p.click('#btn-review'); await p.waitForTimeout(200); console.log('score open:', await p.isVisible('#p-score'));
  await p.fill('#sc-text', 'all alphas'); await p.click('#sc-go'); console.log('score:', (await p.textContent('#sc-table')).replace(/\s+/g, ' ')); await p.click('#sc-close');
  await p.click('#btn-back'); await p.waitForTimeout(200); console.log('back ->', await scr(), '| log:', await p.textContent('#hub-log'), '| shooter now', await p.evaluate(() => S.shooter));
  await p.click('#hub-new'); await p.waitForTimeout(200); await p.fill('#vb-text', 'call it test drill 2 shots on target 1 3 reps under 4 seconds'); await p.press('#vb-text', 'Enter'); await p.waitForTimeout(700);
  console.log('editor heard:', await p.textContent('#vb-heard')); await p.screenshot({ path: out + '/a-editor.png' }); await p.click('#p-save'); await p.waitForTimeout(200);
  console.log('saved & picked:', await p.textContent('#hub-dlist .hd-row.sel'));
  await p.click('[data-back="home"]'); await p.waitForTimeout(200); console.log('home resume visible:', await p.isVisible('#h-ses'));
  await p.screenshot({ path: out + '/a-home2.png' });
  await p.click('.tab[data-view="history"]'); await p.waitForTimeout(200); await p.screenshot({ path: out + '/a-history.png' });
  await p.click('.tab[data-view="settings"]'); await p.waitForTimeout(200); await p.selectOption('#set-skin', 'current'); await p.waitForTimeout(100); await p.screenshot({ path: out + '/a-settings-dark.png' });
  await p.click('.tab[data-view="train"]'); await p.waitForTimeout(200); await p.screenshot({ path: out + '/a-home-dark.png' });
  console.log('errors:', errs.join(' | ') || 'none'); await b.close();
})();
