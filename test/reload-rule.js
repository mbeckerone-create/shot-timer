// Reload rule check on the filmed reload reps: shot 2 only after the rack (double snap, doublet, or a slam much louder than shot 1).
const { beeps, ev } = JSON.parse(require('fs').readFileSync('/home/user/data/dl4/rl_ev.json'));
const truth = { 1: [1.76, 5.97], 2: [2.01, 5.00], 3: [1.61, 4.84], 5: [2.00, 6.41], 6: [1.62, 5.44], 8: [1.41, 4.16], 9: [1.38, 5.62], 10: [2.85, 8.42], 11: [1.82, 5.80], 12: [2.09, 6.10], 13: [1.56, 6.01] };
const shape = (v) => { const m = v.reduce((a, c) => a + c, 0) / v.length; return v.map((q) => q - m); };
const cos = (a, c) => { let s = 0, na = 0, nb = 0; for (let i = 0; i < a.length; i++) { s += a[i] * c[i]; na += a[i] * a[i]; nb += c[i] * c[i]; } return s / Math.sqrt(na * nb + 1e-12); };
const near = (t) => ev.filter((c) => Math.abs(c.t - t) < 0.03).reduce((a, c) => (c.db > a.db ? c : a));
const SLAM_DB = +(process.env.SLAM || 8), M = 0.9;
let ok = 0, n = 0, old = 0;
for (const [k, [s1, s2]] of Object.entries(truth)) {
  const bt = beeps[k - 1], shot1 = near(bt + s1);
  const others = Object.entries(truth).filter(([j]) => j !== k).map(([j, v]) => near(beeps[j - 1] + v[0]));
  const tpl = shape(others[0].bands).map((_, i) => others.reduce((t, e) => t + shape(e.bands)[i], 0) / others.length);
  const w = ev.filter((e) => e.t > shot1.t + 0.25 && e.t < bt + 10 && e.db > -45);
  const dbl = (e) => w.some((q) => q !== e && Math.abs(q.t - e.t) >= 0.08 && Math.abs(q.t - e.t) < 0.25 && q.db > e.db - 15);
  const doublet = (e) => w.some((q) => q !== e && Math.abs(q.t - e.t) < 0.08 && Math.abs(q.db - e.db) <= 6);
  let rackT = null, got = null, oldGot = null;
  for (const e of w) {
    const click = cos(shape(e.bands), tpl) >= M && !dbl(e);
    if (!oldGot && click) oldGot = e;                              // old rule: first click-like single after shot 1
    if (e.db >= shot1.db + SLAM_DB || dbl(e) || doublet(e)) { rackT = e.t; continue; }
    if (rackT != null && e.t - rackT >= 0.25 && click) { got = e; break; }
  }
  const good = got && Math.abs(got.t - (bt + s2)) < 0.02, ogood = oldGot && Math.abs(oldGot.t - (bt + s2)) < 0.02; n++; ok += !!good; old += !!ogood;
  console.log(`rep ${k}: truth reload ${(s2 - s1).toFixed(2)}  new ${got ? (got.t - shot1.t).toFixed(2) : '—'} ${good ? '✓' : '✗'}   old ${oldGot ? (oldGot.t - shot1.t).toFixed(2) : '—'} ${ogood ? '✓' : '✗'}`);
}
console.log(`new rule ${ok}/${n}   old rule ${old}/${n}`);
if (process.env.DBG) for (const k of process.env.DBG.split(',')) {
  const [s1, s2] = truth[k], bt = beeps[k - 1], shot1 = near(bt + s1);
  const others = Object.entries(truth).filter(([j]) => j !== k).map(([j, v]) => near(beeps[j - 1] + v[0]));
  const tpl = shape(others[0].bands).map((_, i) => others.reduce((t, e) => t + shape(e.bands)[i], 0) / others.length);
  const w = ev.filter((e) => e.t > shot1.t + 0.25 && e.t < bt + 10 && e.db > -45);
  console.log(`rep ${k} (shot1 ${shot1.db.toFixed(0)} dB):`, w.map((e) => `${(e.t - bt).toFixed(2)}[${e.db.toFixed(0)} c${cos(shape(e.bands), tpl).toFixed(2)}${w.some((q) => q !== e && Math.abs(q.t - e.t) >= 0.08 && Math.abs(q.t - e.t) < 0.25 && q.db > e.db - 15) ? ' D' : ''}${w.some((q) => q !== e && Math.abs(q.t - e.t) < 0.08 && Math.abs(q.db - e.db) <= 6) ? ' d' : ''}]`).join(' '));
}
