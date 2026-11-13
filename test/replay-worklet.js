// Replays a recorded mic WAV through the real worklet (detector + beep finder + notch switching).
// usage: node test/replay-worklet.js file.wav [beepGuessSeconds] [beepHz]
const fs = require('fs'), path = require('path'), vm = require('vm');
const [file, guess = '1.0', hz = '2400'] = process.argv.slice(2);
const b = fs.readFileSync(file), o = b.indexOf('data') + 8, SR = b.readUInt32LE(24), n = (b.length - o) >> 1, x = new Float32Array(n);
for (let i = 0; i < n; i++) x[i] = b.readInt16LE(o + 2 * i) / 32768;
const msgs = [], ctx = { sampleRate: SR, currentFrame: 0, console,
  AudioWorkletProcessor: class { constructor() { this.port = { postMessage: (m) => msgs.push(m), onmessage: null }; } },
  registerProcessor: (nm, C) => { ctx.Proc = C; } };
vm.createContext(ctx);
for (const f of ['detector.js', 'worklet.js']) vm.runInContext(fs.readFileSync(path.join(__dirname, '..', f), 'utf8'), ctx);
const p = new ctx.Proc(); let armed = false;
if (process.env.SENS) p.port.onmessage({ data: { type: 'params', params: { shotDb: -14 - (+process.env.SENS - 1) * 3 } } });
for (let f = 0; f < n; f += 128) {
  ctx.currentFrame = f;
  if (!armed && f >= 0.05 * SR) { p.port.onmessage({ data: { type: 'arm', beepAt: +guess, parAt: [], beepMs: 300, beepHz: +hz, latency: 0 } }); armed = true; }
  p.process([[x.subarray(f, Math.min(n, f + 128))]]);
}
const bp = msgs.find((m) => m.type === 'beep');
console.log('beep', bp && bp.acoustic ? 'found at ' + (bp.frame / SR).toFixed(4) + ' s' : 'NOT found');
console.log('shots (s after beep):', msgs.filter((m) => m.type === 'shot').map((m) => ((m.frame - bp.frame) / SR).toFixed(3) + ` (${m.peakDb.toFixed(1)} dB)`).join('  ') || 'none');
