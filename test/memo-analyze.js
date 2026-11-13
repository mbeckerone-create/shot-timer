// Labels the sounds in the user's voice memo (labels from the transcript) and compares fingerprints.
const fs = require('fs'), SD = require('../detector.js');
const b = fs.readFileSync('/home/user/data/dryfire/memo.wav'), o = b.indexOf('data') + 8, n = (b.length - o) >> 1, x = new Float32Array(n);
for (let i = 0; i < n; i++) x[i] = b.readInt16LE(o + 2 * i) / 32768;
const SR = 48000, segs = [['rack', 4.42, 6.85], ['click', 9.0, 12.3], ['rack', 13.34, 15.85], ['click', 16.86, 19.3], ['rack', 20.32, 23.0], ['click', 23.96, 26.1], ['rack', 27.08, 29.3], ['click', 30.22, 33.8]];
const db = +(process.env.DB || -48);
const d = new SD(SR, { shotDb: db, echoMs: 0, lockMs: +(process.env.LOCK || 150) });
for (let i = 0; i < n; i += 128) d.process(x.subarray(i, i + 128));
const lab = (t) => (segs.find((s) => t >= s[1] && t <= s[2]) || ['(speech/other)'])[0];
const ev = d.shots.map((s) => ({ t: s.frame / SR, db: s.peakDb, bands: s.bands, lab: lab(s.frame / SR) }));
const shape = (v) => { const m = v.reduce((a, c) => a + c, 0) / v.length; return v.map((q) => q - m); };
const cos = (a, c) => { let s = 0, na = 0, nb = 0; for (let i = 0; i < a.length; i++) { s += a[i] * c[i]; na += a[i] * a[i]; nb += c[i] * c[i]; } return s / Math.sqrt(na * nb + 1e-12); };
const clicks = ev.filter((e) => e.lab === 'click');
const tpl = shape(clicks[0].bands).map((_, k) => clicks.reduce((t, e) => t + shape(e.bands)[k], 0) / clicks.length);
console.log(`threshold ${db} dB: ${ev.length} sounds`);
for (const e of ev) console.log(`${e.t.toFixed(3)}s  ${e.lab.padEnd(14)} ${e.db.toFixed(1)} dB   match-to-click ${cos(shape(e.bands), tpl).toFixed(2)}`);
// leave-one-out: each click scored against a template built from the OTHER clicks
console.log('leave-one-out click scores:', clicks.map((c, i) => { const o2 = clicks.filter((_, j) => j !== i); const t2 = shape(o2[0].bands).map((_, k) => o2.reduce((t, e) => t + shape(e.bands)[k], 0) / o2.length); return cos(shape(c.bands), t2).toFixed(2); }).join(' '));
if (process.env.DUMP) fs.writeFileSync(process.env.DUMP, JSON.stringify(ev));
