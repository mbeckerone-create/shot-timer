const fs = require('fs'), SD = require('../detector.js'), SR = 48000;
function events(file, db) { const b = fs.readFileSync(file), o = b.indexOf('data') + 8, n = (b.length - o) >> 1, x = new Float32Array(n);
  for (let i = 0; i < n; i++) x[i] = b.readInt16LE(o + 2 * i) / 32768;
  const d = new SD(SR, { shotDb: db, echoMs: 0, lockMs: 60 }); for (let i = 0; i < n; i += 128) d.process(x.subarray(i, i + 128));
  return d.shots.map((s) => ({ t: s.frame / SR, db: s.peakDb, bands: s.bands })); }
const shape = (v) => { const m = v.reduce((a, c) => a + c, 0) / v.length; return v.map((q) => q - m); };
const cos = (a, c) => { let s = 0, na = 0, nb = 0; for (let i = 0; i < a.length; i++) { s += a[i] * c[i]; na += a[i] * a[i]; nb += c[i] * c[i]; } return s / Math.sqrt(na * nb + 1e-12); };
const e1 = events('/home/user/data/dryfire/memo.wav', -48);
const teach = [[9, 12.3], [16.86, 19.3], [23.96, 26.1], [30.22, 33.8]].map((s) => e1.filter((e) => e.t >= s[0] && e.t <= s[1]).reduce((a, c) => (c.db > a.db ? c : a)));
const tpl = shape(teach[0].bands).map((_, k) => teach.reduce((t, e) => t + shape(e.bands)[k], 0) / teach.length);
const ev = events('/home/user/data/dryfire/memo3.wav', -57).filter((e) => e.db > -40);
for (const e of ev) {
  const dbl = ev.some((o) => o !== e && Math.abs(o.t - e.t) >= 0.08 && Math.abs(o.t - e.t) < 0.25 && o.db > e.db - 15);
  e.m = cos(shape(e.bands), tpl); e.dbl = dbl;
}
if (process.env.DUMP) fs.writeFileSync(process.env.DUMP, JSON.stringify(ev));
const from = +(process.env.FROM || 0), to = +(process.env.TO || 999);
for (const e of ev.filter((q) => q.t >= from && q.t <= to && q.db > -32)) console.log(`${e.t.toFixed(2)} ${e.db.toFixed(1).padStart(6)}dB match ${e.m.toFixed(2)} ${e.dbl ? 'double' : 'single'}${e.m >= 0.9 && !e.dbl ? '  <= CLICK?' : ''}`);
