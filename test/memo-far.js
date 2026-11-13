// Teach from the close memo (memo.wav), test on the 3-ft memo (memo2.wav). Labels from the transcripts/levels.
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
const ISO_MIN = +(process.env.ISO_MIN ?? 0.08), ISO_MAX = 0.3, ISO_DB = +(process.env.ISO_DB ?? 15), M = +(process.env.M ?? 0.9);
function judge(c, all) {
  const score = cos(shape(c.bands), tpl);
  const dbl = all.some((o) => o !== c && Math.abs(o.t - c.t) >= ISO_MIN && Math.abs(o.t - c.t) < ISO_MAX && o.db > c.db - ISO_DB);
  return { score, ok: score >= M && !dbl, dbl };
}
for (const [name, file, clicks] of [['close memo', '/home/user/data/dryfire/memo.wav', [11.207, 18.308, 25.012, 31.342]], ['3-ft memo', '/home/user/data/dryfire/memo2.wav', [14.46, 19.53, 23.76]]]) {
  const ev = events(file, -57).filter((e) => e.db > -45);
  const isClick = (e) => clicks.some((t) => Math.abs(t - e.t) < 0.01);
  const acc = ev.filter((e) => judge(e, ev).ok);
  console.log(`${name}: clicks found ${acc.filter(isClick).length}/${clicks.length}; false accepts: ${acc.filter((e) => !isClick(e)).map((e) => e.t.toFixed(2) + '(' + judge(e, ev).score.toFixed(2) + ')').join(' ') || 'none'}`);
  if (process.env.V) for (const e of ev.filter((q) => q.db > -25)) { const j = judge(e, ev); console.log(`   ${e.t.toFixed(2)} ${e.db.toFixed(1)}dB match ${j.score.toFixed(2)} ${j.dbl ? 'double' : 'single'} ${isClick(e) ? 'CLICK' : ''}`); }
}
