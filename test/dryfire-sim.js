// Synthetic dry-fire check: can the fingerprint tell a trigger click from a holster clack?
const SD = require('../detector.js'), SR = 48000;
function click(x, at, freqs, decayMs, amp) {
  const n = Math.round(0.03 * SR), ph = freqs.map(() => Math.random() * 6.28);
  for (let i = 0; i < n; i++) { let v = 0; const env = Math.exp(-i / (decayMs / 1000 * SR));
    freqs.forEach((f, j) => { v += Math.sin(2 * Math.PI * f * i / SR + ph[j]); }); x[at + i] += amp * env * (v / freqs.length + 0.3 * (Math.random() - .5)); }
}
const jit = (f) => f * (1 + (Math.random() - .5) * 0.08);
const trig = () => [5500, 9000, 12500].map(jit), hol = () => [2600, 3600, 6000].map(jit);
const N = 30 * SR, x = new Float32Array(N); for (let i = 0; i < N; i++) x[i] = (Math.random() - .5) * 0.0015;
const truth = [];
for (let k = 0; k < 12; k++) {             // 6 trigger, 6 holster, varying loudness
  const at = Math.round((1 + k * 2.2) * SR), isT = k % 2 === 0, amp = (isT ? 0.03 : 0.05) * (0.6 + Math.random() * 0.8);
  click(x, at, isT ? trig() : hol(), isT ? 1.2 : 3.5, amp); truth.push({ at, isT });
}
const d = new SD(SR, { shotDb: +(process.env.DB || -55), echoMs: 0, lockMs: 150 });
for (let i = 0; i < N; i += 128) d.process(x.subarray(i, i + 128));
const shape = (b) => { const m = b.reduce((a, c) => a + c, 0) / b.length; return b.map((v) => v - m); };
const cos = (a, b) => { let s = 0, na = 0, nb = 0; for (let i = 0; i < a.length; i++) { s += a[i] * b[i]; na += a[i] * a[i]; nb += b[i] * b[i]; } return s / Math.sqrt(na * nb + 1e-12); };
const got = d.shots.map((s) => ({ s, t: truth.find((q) => Math.abs(q.at - s.frame) < 0.02 * SR) }));
console.log('detected', got.length, 'of', truth.length, 'clicks; levels', got.map((g) => g.s.peakDb.toFixed(0)).join(' '));
const learn = got.filter((g) => g.t && g.t.isT).slice(0, 3).map((g) => shape(g.s.bands));     // "teach" from 3 trigger clicks
const tpl = learn[0].map((_, i) => learn.reduce((a, b) => a + b[i], 0) / learn.length);
for (const g of got) console.log(g.t ? (g.t.isT ? 'TRIGGER' : 'holster') : '???', 'match', cos(shape(g.s.bands), tpl).toFixed(2));
