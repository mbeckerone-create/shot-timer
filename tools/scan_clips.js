// Scan a folder of WAVs with the app's Range detector and write, per clip: duration, a loudness envelope (for drawing)
// and every detected sound (time, peak dB). usage: node tools/scan_clips.js wavdir out.json [sensitivity]
const fs = require('fs'), vm = require('vm'), path = require('path');
const ctx = {}; vm.createContext(ctx); vm.runInContext(fs.readFileSync(__dirname + '/../detector.js', 'utf8') + ';this.ShotDetector=ShotDetector;', ctx);
const { ShotDetector } = ctx; const [dir, out, sensArg] = process.argv.slice(2); const sens = +(sensArg || 8);
function readWav(p) {
  const buf = fs.readFileSync(p); let off = 12, sr = 48000, data;
  while (off < buf.length) { const id = buf.toString('ascii', off, off + 4), n = buf.readUInt32LE(off + 4); if (id === 'fmt ') sr = buf.readUInt32LE(off + 12); if (id === 'data') { data = buf.subarray(off + 8, off + 8 + n); break; } off += 8 + n; }
  const x = new Float32Array(data.length / 2); for (let i = 0; i < x.length; i++) x[i] = data.readInt16LE(i * 2) / 32768; return { x, sr };
}
const res = [];
for (const f of fs.readdirSync(dir).filter((f) => f.endsWith('.wav')).sort()) {
  const { x, sr } = readWav(path.join(dir, f));
  const d = new ShotDetector(sr, { shotDb: ShotDetector.sensitivityToDb(sens), echoMs: 180, lockMs: 100 });
  for (let i = 0; i < x.length; i += 128) d.process(x.subarray(i, i + 128));
  const W = 600, step = Math.ceil(x.length / W), env = [];
  for (let k = 0; k < W; k++) { let pk = 0; for (let i = k * step; i < Math.min(x.length, (k + 1) * step); i++) pk = Math.max(pk, Math.abs(x[i])); env.push(Math.round(Math.max(-60, 20 * Math.log10(pk + 1e-9)))); }
  const shots = d.shots.map((s) => [+(s.frame / sr).toFixed(3), +s.peakDb.toFixed(1)]);
  res.push({ name: f.replace(/\.wav$/, ''), dur: +(x.length / sr).toFixed(2), env, shots });
  const top = Math.max(...shots.map((s) => s[1]), -99);
  console.log(f.padEnd(30), `${(x.length / sr).toFixed(1)}s`.padStart(7), `${shots.length} sounds`.padStart(11), `within 10 dB of loudest: ${shots.filter((s) => s[1] >= top - 10).length}`, `loudest ${top} dB`);
}
fs.writeFileSync(out, JSON.stringify(res));
