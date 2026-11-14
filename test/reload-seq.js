// Full sound sequence of each reload rep from the training clip's audio (beeps found in the audio itself).
const fs = require('fs'), SD = require('../detector.js'), SR = 48000;
const b = fs.readFileSync(process.argv[2]), o = b.indexOf('data') + 8, n = (b.length - o) >> 1, x = new Float32Array(n);
for (let i = 0; i < n; i++) x[i] = b.readInt16LE(o + 2 * i) / 32768;
const beeps = []; let f = new SD.BeepFinder(SR, 2400); f.window(0, n);
for (let i = 0; i < n; i += 128) { const v = f.process(x.subarray(i, i + 128), i); if (v !== null) { beeps.push(v / SR); f = new SD.BeepFinder(SR, 2400); f.window(i + SR * 3, n); } }
const d = new SD(SR, { shotDb: -57, echoMs: 0, lockMs: 60, notchHz: 2400 }); for (let i = 0; i < n; i += 128) d.process(x.subarray(i, i + 128));
const ev = d.shots.map((s) => ({ t: s.frame / SR, db: s.peakDb, bands: s.bands }));
fs.writeFileSync(process.argv[3], JSON.stringify({ beeps, ev }));
const isDbl = (e, w) => w.some((q) => q !== e && Math.abs(q.t - e.t) >= 0.08 && Math.abs(q.t - e.t) < 0.25 && q.db > e.db - 15);
beeps.forEach((bt, k) => {
  const nxt = beeps[k + 1] || bt + 12, w = ev.filter((e) => e.t > bt + 0.08 && e.t < Math.min(nxt, bt + 9) && e.db > -42);
  console.log(`rep ${String(k + 1).padStart(2)} @${bt.toFixed(1)}: ` + w.map((e) => `${(e.t - bt).toFixed(2)}${isDbl(e, w) ? 'D' : 'S'}${e.db.toFixed(0)}`).join(' '));
});
