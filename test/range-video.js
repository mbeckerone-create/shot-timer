// Run the app's Range detector over a filmed range session and line it up with the film log's beeps.
// usage: node test/range-video.js clip.wav film-log.json [sensitivity] [-] [gate dB]
// Prints, for every beep, the shots Range mode finds in the 8 s after it (time from the beep, split, level),
// next to what the app actually logged in that rep. This is a check, not a unit test: real gunfire, real echoes.
const fs = require('fs'), vm = require('vm');
const ctx = {}; vm.createContext(ctx); vm.runInContext(fs.readFileSync(__dirname + '/../detector.js', 'utf8') + ';this.ShotDetector=ShotDetector;', ctx);
const { ShotDetector } = ctx;
const [wavPath, logPath, sensArg] = process.argv.slice(2);
const buf = fs.readFileSync(wavPath); let off = 12, sr = 48000, data = null;
while (off < buf.length) { const id = buf.toString('ascii', off, off + 4), n = buf.readUInt32LE(off + 4);
  if (id === 'fmt ') sr = buf.readUInt32LE(off + 12); if (id === 'data') { data = buf.subarray(off + 8, off + 8 + n); break; } off += 8 + n; }
const x = new Float32Array(data.length / 2); for (let i = 0; i < x.length; i++) x[i] = data.readInt16LE(i * 2) / 32768;
const sens = +(sensArg || 10), lock = 100, echo = 180;
const d = new ShotDetector(sr, { shotDb: ShotDetector.sensitivityToDb(sens), echoMs: echo, lockMs: lock });
for (let i = 0; i < x.length; i += 128) d.process(x.subarray(i, i + 128));
const shots = d.shots.map((s) => ({ t: s.frame / sr, db: s.peakDb }));
const log = JSON.parse(fs.readFileSync(logPath, 'utf8')), t0 = log.recStartCtx || 0;
// beeps in clip time: the 2400 Hz tone, searched near each logged beep
function beepAt(around) {
  const N = sr / 100 | 0, c = 2 * Math.cos(2 * Math.PI * (log.settings.beepHz || 2400) / sr); let run = 0, first = 0;
  for (let s = Math.max(0, (around - 1.2) * sr | 0); s < Math.min(x.length - N, (around + 1.2) * sr); s += N) {
    let s1 = 0, s2 = 0, en = 1e-12; for (let k = 0; k < N; k++) { const v = x[s + k]; const s0 = v + c * s1 - s2; s2 = s1; s1 = s0; en += v * v; }
    const pw = s1 * s1 + s2 * s2 - c * s1 * s2;
    if (pw / (N / 2 * en) > 0.5 && en / N > 1e-6) { if (++run === 1) first = s; if (run >= 3) return first / sr; } else run = 0;
  }
  return null;
}
let rep = 0, cur = null; const reps = [];
for (const e of log.events) {
  if (e.type === 'beep_scheduled') { cur = { mode: e.mode, drill: e.drill, sched: e.beepAt - t0, app: [] }; reps.push(cur); }
  else if (cur && e.type === 'string') cur.app = e.shots.map((s) => s.t);
  else if (cur && e.type === 'rep') cur.app = e.result ? [e.result.t] : [];
}
console.log(`sensitivity ${sens}: ${shots.length} shots in the whole clip (${(x.length / sr).toFixed(0)} s)`);
for (const r of reps) {
  rep++; const b = beepAt(r.sched + 0.05) ?? r.sched;
  const mine = shots.filter((s) => s.t > b && s.t < b + 8).map((s) => ({ t: s.t - b, db: s.db }));
  const txt = mine.map((s, i) => `${s.t.toFixed(3)}${i ? ` (+${(s.t - mine[i - 1].t).toFixed(3)})` : ''} ${s.db.toFixed(0)}dB`).join('  ');
  console.log(`rep ${String(rep).padStart(2)} @${b.toFixed(1)}s [${r.mode}/${r.drill}] range finds ${mine.length}: ${txt}\n            app logged: ${r.app.map((t) => t.toFixed(3)).join(' ') || '—'}`);
}
// Own-gun gate: in a string, keep only sounds within GATE dB of the loudest one (your gun is the loudest thing the mic hears).
const GATE = +(process.argv[6] || 12);
console.log(`\nwith the own-gun gate (${GATE} dB below the loudest shot in the string is ignored):`);
rep = 0;
for (const r of reps) {
  rep++; const b = beepAt(r.sched + 0.05) ?? r.sched;
  const mine = shots.filter((s) => s.t > b && s.t < b + 8); const top = Math.max(-200, ...mine.map((s) => s.db));
  const kept = mine.filter((s) => s.db >= top - GATE).map((s) => s.t - b);
  console.log(`rep ${String(rep).padStart(2)}: ${kept.map((t, i) => t.toFixed(3) + (i ? ` (+${(t - kept[i - 1]).toFixed(3)})` : '')).join('  ') || '—'}`);
}
