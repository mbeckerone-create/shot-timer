// Runs the dry-fire decision rules over the user's labelled voice memo: teach from 4 clicks, test on the 5th + everything else.
const fs = require('fs'), SD = require('../detector.js'), SR = 48000;
const b = fs.readFileSync('/home/user/data/dryfire/memo.wav'), o = b.indexOf('data') + 8, n = (b.length - o) >> 1, x = new Float32Array(n);
for (let i = 0; i < n; i++) x[i] = b.readInt16LE(o + 2 * i) / 32768;
const segs = [['rack', 4.42, 6.85], ['click', 9.0, 12.3], ['rack', 13.34, 15.85], ['click', 16.86, 19.3], ['rack', 20.32, 23.0], ['click', 23.96, 26.1], ['rack', 27.08, 29.3], ['click', 30.22, 33.8]];
const lab = (t) => (segs.find((s) => t >= s[1] && t <= s[2]) || ['speech'])[0];
const d = new SD(SR, { shotDb: -48, echoMs: 0, lockMs: 60 });
for (let i = 0; i < n; i += 128) d.process(x.subarray(i, i + 128));
const ev = d.shots.map((s) => ({ t: s.frame / SR, db: s.peakDb, bands: s.bands, lab: lab(s.frame / SR) }));
const shape = (v) => { const m = v.reduce((a, c) => a + c, 0) / v.length; return v.map((q) => q - m); };
const cos = (a, c) => { let s = 0, na = 0, nb = 0; for (let i = 0; i < a.length; i++) { s += a[i] * c[i]; na += a[i] * a[i]; nb += c[i] * c[i]; } return s / Math.sqrt(na * nb + 1e-12); };
// "guided teach": loudest sound in each click segment
const teach = segs.filter((s) => s[0] === 'click').map((s) => ev.filter((e) => e.t >= s[1] && e.t <= s[2]).reduce((a, c) => (c.db > a.db ? c : a)));
const MATCH = +(process.env.MATCH || 0.9), ISO = 0.25, LVL = 15;
let fa = 0, hit = 0;
teach.forEach((held, k) => {
  const tr = teach.filter((_, j) => j !== k), tpl = shape(tr[0].bands).map((_, i) => tr.reduce((t, e) => t + shape(e.bands)[i], 0) / tr.length);
  const tdb = tr.map((e) => e.db).sort((a, c) => a - c)[tr.length >> 1];
  const acc = ev.filter((e) => cos(shape(e.bands), tpl) >= MATCH && e.db >= tdb - LVL && !ev.some((o2) => o2 !== e && Math.abs(o2.t - e.t) < ISO && o2.db > e.db - 20));
  const ok = acc.some((e) => e === held), wrong = acc.filter((e) => e.lab !== 'click');
  hit += ok; fa += wrong.length;
  console.log(`fold ${k + 1}: held-out click ${held.t.toFixed(2)}s ${ok ? 'ACCEPTED' : 'missed'}; false accepts: ${wrong.map((e) => e.lab + '@' + e.t.toFixed(2)).join(', ') || 'none'}`);
});
console.log(`=> ${hit}/${teach.length} clicks recognised, ${fa} false accepts across all folds (match ${MATCH})`);
