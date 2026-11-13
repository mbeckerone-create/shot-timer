const { chromium } = require('playwright');
(async () => {
  const b = await chromium.launch({ args: ['--use-fake-ui-for-media-stream', '--use-fake-device-for-media-stream', `--use-file-for-fake-audio-capture=${process.argv[2]}`, '--autoplay-policy=no-user-gesture-required'] });
  const p = await b.newPage(); await p.addInitScript(() => localStorage.setItem('st.settings', JSON.stringify({ dmin: 3, dmax: 3 })));
  await p.goto('http://localhost:8765/?v=' + Date.now());
  await p.click('#btn-main'); await p.waitForTimeout(800);
  const lv = await p.evaluate(() => new Promise((r) => { const v = []; const o = audio.node.port.onmessage; audio.node.port.onmessage = (e) => { if (e.data.type === 'level') v.push(e.data.db); o(e); }; setTimeout(() => r(v.slice(0, 5)), 500); }));
  console.log('level msgs:', lv.map((x) => x.toFixed(1)).join(' '));
  await p.waitForTimeout(2000);
  console.log('status:', await p.textContent('#status'), '|', await p.textContent('#beepinfo'));
  await p.click('#btn-main'); await p.waitForTimeout(1500);
  console.log('after START again:', await p.textContent('#status'));
  await b.close();
})();
