// Ground truth from the user's draw video: find each start beep (2400 Hz), then the loud single snaps after it.
const fs = require('fs'), SD = require('../detector.js'), SR = 48000;
const b = fs.readFileSync('/home/user/data/dl2/draws.wav'), o = b.indexOf('data') + 8, n = (b.length - o) >> 1, x = new Float32Array(n);
for (let i = 0; i < n; i++) x[i] = b.readInt16LE(o + 2 * i) / 32768;
// beeps
const beeps = []; let f = new SD.BeepFinder(SR, 2400); f.window(0, n);
for (let i = 0; i < n; i += 128) { const v = f.process(x.subarray(i, i + 128), i); if (v !== null) { beeps.push(v / SR); const nf = new SD.BeepFinder(SR, 2400); nf.window(i + SR * 2, n); f = nf; } }
const d = new SD(SR, { shotDb: -57, echoMs: 0, lockMs: 60, notchHz: 2400 }); for (let i = 0; i < n; i += 128) d.process(x.subarray(i, i + 128));
const ev = d.shots.map((s) => ({ t: s.frame / SR, db: s.peakDb, bands: s.bands }));
fs.writeFileSync('/home/user/data/dl2/ev.json', JSON.stringify({ beeps, ev }));
console.log(`${beeps.length} beeps`);
beeps.forEach((bt, k) => {
  const w = ev.filter((e) => e.t > bt + 0.08 && e.t < bt + 3.5 && e.db > -30);
  const single = w.filter((e) => !w.some((q) => q !== e && Math.abs(q.t - e.t) >= 0.08 && Math.abs(q.t - e.t) < 0.25 && q.db > e.db - 15));
  console.log(`rep ${String(k + 1).padStart(2)} beep@${bt.toFixed(2)}  loud singles: ${single.map((e) => `+${(e.t - bt).toFixed(3)}(${e.db.toFixed(0)})`).join(' ')}`);
});
