// Score a train take (Settings › Record a train take): the clip's soundtrack is the truth, then compare
//   1. what the phone logged during the take (clip.json, its sounds carry clip time t), and
//   2. the current detector.js run over the clip's audio (no beep, nothing blanked: the take's own setup).
// usage: ffmpeg -i ST-…-clipN.mp4 -ac 1 -ar 48000 clipN.wav
//        node tools/eval_train.js clipN.wav [ST-…-clipN.json] [--det path/to/detector.js] [--sens 1-10] [-v]
// Truth: onsets where the 2 kHz-high-passed level jumps ≥ 20 dB within 3 ms to above -15 dB, ≥ 150 ms apart.
// The films are clipped at 0 dBFS, so the truth is 'loud, sharp sounds': listen to the clip to confirm a disputed one.
const fs = require('fs'), vm = require('vm'), path = require('path');
const args = process.argv.slice(2), opt = (k, d) => { const i = args.indexOf(k); return i >= 0 ? args[i + 1] : d; };
const files = args.filter((a, i) => !a.startsWith('-') && !(i > 0 && args[i - 1].startsWith('--')));
const [wavFile, logFile] = files, V = args.includes('-v');
const ctx = {}; vm.createContext(ctx); vm.runInContext(fs.readFileSync(opt('--det', path.join(__dirname, '..', 'detector.js')), 'utf8') + ';this.SD=ShotDetector;', ctx); const SD = ctx.SD;
function readWav(p) {
  const b = fs.readFileSync(p); let o = 12, sr = 48000, d;
  while (o < b.length) { const id = b.toString('ascii', o, o + 4), n = b.readUInt32LE(o + 4); if (id === 'fmt ') sr = b.readUInt32LE(o + 12); if (id === 'data') { d = b.subarray(o + 8, o + 8 + n); break; } o += 8 + n; }
  const x = new Float32Array(d.length / 2); for (let i = 0; i < x.length; i++) x[i] = d.readInt16LE(i * 2) / 32768; return { x, sr };
}
const { x, sr } = readWav(wavFile);
const log = logFile ? JSON.parse(fs.readFileSync(logFile, 'utf8')) : null;
const sens = +opt('--sens', log && log.settings ? log.settings.sens : 8);
// truth
const w0 = 2 * Math.PI * 2000 / sr, a = Math.sin(w0) / (2 * Math.SQRT1_2), c = Math.cos(w0), a0 = 1 + a;
const b0 = (1 + c) / 2 / a0, b1 = -(1 + c) / a0, a1 = -2 * c / a0, a2 = (1 - a) / a0, B = sr / 1000, db = new Float32Array(Math.floor(x.length / B));
{ let x1 = 0, x2 = 0, y1 = 0, y2 = 0, acc = 0; for (let n = 0; n < db.length * B; n++) { const y = b0 * x[n] + b1 * x1 + b0 * x2 - a1 * y1 - a2 * y2; x2 = x1; x1 = x[n]; y2 = y1; y1 = y; acc += y * y; if ((n + 1) % B === 0) { db[(n + 1) / B - 1] = 10 * Math.log10(acc / B + 1e-14); acc = 0; } } }
const truth = []; { let last = -1e9; for (let i = 4; i < db.length; i++) if (db[i] > -15 && db[i] - Math.min(db[i - 3], db[i - 4]) >= 20 && i - last >= 150) { let k = i; while (db[k - 1] < db[k] - 10 && i - k < 3) k--; truth.push(k / 1000); last = i; } }
// detector over the clip
const det = new SD(sr, { shotDb: SD.sensitivityToDb(sens), echoMs: log && log.settings ? 180 : 180, lockMs: 100 });
for (let i = 0; i < x.length; i += 128) det.process(x.subarray(i, i + 128));
const gate = 10;
function withGate(L) { const top = Math.max(-1e9, ...L.map((q) => q.db)); return L.map((q) => Object.assign(q, { g: q.db < top - gate })); }   // gate vs the take's loudest shot
const mine = withGate(det.shots.map((q) => ({ t: q.frame / sr, db: q.peakDb })));
let phone = null;
if (log) {
  const snd = log.events.filter((e) => e.type === 'sound');
  if (snd.length && snd[0].t == null) console.log('(log has no clip times: made before train takes existed)');
  else phone = withGate(snd.map((e) => ({ t: e.t, db: e.db })));
}
function score(dets, name, tol) {
  if (!dets) return;
  // the phone's clip times are ±~30 ms (mapped from the input clock): align on the median offset of near matches first
  const offs = dets.map((q) => { const n = truth.reduce((m, t) => (Math.abs(t - q.t) < Math.abs(m - q.t) ? t : m), 1e9); return n - q.t; }).filter((o) => Math.abs(o) < 0.1).sort((p, q) => p - q);
  const off = offs.length ? offs[offs.length >> 1] : 0, used = new Set(); let k = 0, g = 0, m = 0; const miss = [];
  for (const t of truth) { const d = dets.find((q) => !used.has(q) && Math.abs(q.t + off - t) < tol); if (d) { used.add(d); d.g ? g++ : k++; } else { m++; miss.push(t); } }
  const ex = dets.filter((q) => !used.has(q) && !q.g);
  console.log(`${name.padEnd(9)} kept ${k}  gated ${g}  missed ${m}  extra ${ex.length}${Math.abs(off) > 0.001 ? `  (clock offset ${(off * 1000).toFixed(0)} ms)` : ''}`);
  if (V) { if (miss.length) console.log('   missed at', miss.map((t) => t.toFixed(2)).join(' ')); if (ex.length) console.log('   extra at ', ex.map((q) => (q.t + off).toFixed(2) + '@' + q.db.toFixed(0)).join(' ')); }
}
console.log(`${path.basename(wavFile)}: ${(x.length / sr).toFixed(1)} s, ${truth.length} loud sharp sounds on the soundtrack (sensitivity ${sens})`);
score(phone, 'phone', 0.06);
score(mine, 'detector', 0.06);
