// Simulates the AudioWorklet in Node: fake latency + start beep + real recorded shots.
const fs = require('fs'), path = require('path'), vm = require('vm');
const SR = 48000;
function wav(p){const b=fs.readFileSync(p),o=b.indexOf('data')+8,n=(b.length-o)>>1,x=new Float32Array(n);for(let i=0;i<n;i++)x[i]=b.readInt16LE(o+2*i)/32768;return x;}
const clip = wav(process.argv[2] || '/home/user/data/audio/IMG_5090.wav');
const CLIP_FROM = 66.5, CLIP_TO = 69.3, LAT = 0.090, BEEP_AT = 1.5, PLACE = 2.6, HZ = 2400, BLEN = 300;
const N = Math.round(6 * SR), x = new Float32Array(N);
const RUMBLE = +(process.env.RUMBLE || 0), BEEP_AMP = +(process.env.BEEP_AMP || 0.3);
for (let i = 0; i < N; i++) x[i] = (Math.random() - .5) * 0.002 + RUMBLE * (Math.sin(2 * Math.PI * 31 * i / SR) + 0.6 * Math.sin(2 * Math.PI * 47 * i / SR + 1));
const b0 = Math.round((BEEP_AT + LAT) * SR);
for (let i = 0; i < BLEN / 1000 * SR; i++) x[b0 + i] += BEEP_AMP * Math.sin(2 * Math.PI * HZ * i / SR);
const seg = clip.subarray(Math.round(CLIP_FROM * SR), Math.round(CLIP_TO * SR)), p0 = Math.round(PLACE * SR);
for (let i = 0; i < seg.length; i++) x[p0 + i] += seg[i];
// reference: python detector times inside the clip
const ref = JSON.parse(fs.readFileSync('/home/user/data/analysis/detections_v2.json'))['IMG_5090'].map(s => s.t).filter(t => t > CLIP_FROM && t < CLIP_TO);
const expected = ref.map(t => t - CLIP_FROM + PLACE - (BEEP_AT + LAT));
// worklet global scope
const msgs = []; let proc;
const ctx = { sampleRate: SR, currentFrame: 0, console,
  AudioWorkletProcessor: class { constructor() { this.port = { postMessage: m => msgs.push(m), onmessage: null }; } },
  registerProcessor: (n, C) => { ctx.Proc = C; } };
vm.createContext(ctx);
for (const f of ['detector.js', 'worklet.js']) vm.runInContext(fs.readFileSync(path.join(__dirname, '..', f), 'utf8'), ctx);
proc = new ctx.Proc();
let armed = false;
for (let f = 0; f < N; f += 128) {
  ctx.currentFrame = f + 512;   // graph clock runs ahead of input frames by an arbitrary offset
  if (!armed && f >= 0.5 * SR) { proc.port.onmessage({ data: { type: 'arm', beepAt: BEEP_AT + 512 / SR, parAt: [], beepMs: BLEN, beepHz: HZ, latency: 0.02 } }); armed = true; }
  proc.process([[x.subarray(f, f + 128)]]);
}
const beep = msgs.find(m => m.type === 'beep'), shots = msgs.filter(m => m.type === 'shot').map(m => (m.frame - beep.frame) / SR);
console.log('beep acoustic:', beep.acoustic, 'found at', (beep.frame / SR).toFixed(4), 's (truth', (BEEP_AT + LAT).toFixed(4) + ')');
console.log('shots  :', shots.map(t => t.toFixed(4)).join(' '));
console.log('expect :', expected.map(t => t.toFixed(4)).join(' '));
const err = shots.length === expected.length ? Math.max(...shots.map((t, i) => Math.abs(t - expected[i]))) : NaN;
console.log('count', shots.length, '/', expected.length, ' max error', (err * 1000).toFixed(3), 'ms');
const sp = shots.slice(1).map((t, i) => (t - shots[i]).toFixed(3)); console.log('splits:', sp.join(' '));
const errs=shots.map((t,i)=>Math.abs(t-expected[i])).sort((a,b)=>a-b); const med=errs[errs.length>>1];
console.log('median error',(med*1000).toFixed(3),'ms');
process.exit(shots.length===expected.length && med<0.001 && err<0.010 && Math.abs(beep.frame/SR-(BEEP_AT+LAT))<0.002 ? 0 : 1);
