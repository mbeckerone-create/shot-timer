const fs=require('fs'); const SD=require('../detector.js');
const ref=JSON.parse(fs.readFileSync('./data/analysis/detections_v2.json'));
let ok=true;
for(const b of Object.keys(ref)){
  const buf=fs.readFileSync(`./data/audio/${b}.wav`); const off=buf.indexOf('data')+8; const n=(buf.length-off)>>1; const x=new Float32Array(n);
  for(let i=0;i<n;i++) x[i]=buf.readInt16LE(off+2*i)/32768;
  const d=new SD(48000); for(let i=0;i<n;i+=128) d.process(x.subarray(i,i+128));
  const js=d.shots.map(s=>s.frame/48000), py=ref[b].map(s=>s.t);
  const maxdiff=js.length===py.length?Math.max(...js.map((t,i)=>Math.abs(t-py[i]))):NaN;
  console.log(b,'py',py.length,'js',js.length,'max |dt| ms',(maxdiff*1000).toFixed(3));
  if(!(maxdiff<0.0005)) ok=false;
}
console.log(ok?'PARITY OK':'PARITY MISMATCH');
