// Draw-drill decision check on the user's draw memo (5-6 fast reps): leave-one-rep-out templates.
const ev = JSON.parse(require('fs').readFileSync('/home/user/data/dryfire/ev3.json')).filter((e) => e.db > -40);
const reps = [[69.49, 70.24], [76.55, 77.39], [82.98, 83.96], [89.28, 90.18], [95.99, 96.85], [101.93, 102.79]];
const near = (t) => ev.reduce((a, c) => (Math.abs(c.t - t) < Math.abs(a.t - t) ? c : a));
const shape = (v) => { const m = v.reduce((a, c) => a + c, 0) / v.length; return v.map((q) => q - m); };
const cos = (a, c) => { let s = 0, na = 0, nb = 0; for (let i = 0; i < a.length; i++) { s += a[i] * c[i]; na += a[i] * a[i]; nb += c[i] * c[i]; } return s / Math.sqrt(na * nb + 1e-12); };
const mean = (L) => shape(L[0].bands).map((_, k) => L.reduce((t, e) => t + shape(e.bands)[k], 0) / L.length);
const M = 0.9, ISO_S = 0.25, ISO_MIN = 0.08, ISO_DB = 15;
let good = 0;
reps.forEach(([u, c], k) => {
  const others = reps.filter((_, j) => j !== k), ctpl = mean(others.map((r) => near(r[1]))), htpl = mean(others.map((r) => near(r[0])));
  const beep = u - 1.0, win = ev.filter((e) => e.t > beep + 0.08 && e.t < beep + 6);
  let hol = null, click = null;
  for (const e of win) {
    const nb = win.find((o) => o !== e && Math.abs(o.t - e.t) >= ISO_MIN && Math.abs(o.t - e.t) < ISO_S && o.db > e.db - ISO_DB);
    if (nb) continue;
    const cs = cos(shape(e.bands), ctpl), hs = cos(shape(e.bands), htpl);
    if (hs >= M && hs > cs) { if (!hol && !click) hol = e; continue; }
    if (cs >= M) { click = e; break; }
  }
  const ok = hol && Math.abs(hol.t - u) < 0.01 && click && Math.abs(click.t - c) < 0.01; good += ok;
  console.log(`rep ${k + 1}: reaction ${hol ? (hol.t - beep).toFixed(3) : '—'}  shot ${click ? (click.t - beep).toFixed(3) : '—'}  draw→shot ${hol && click ? (click.t - hol.t).toFixed(3) : '—'}  ${ok ? '✓' : '✗ (expected holster ' + u + ', click ' + c + ')'}`);
});
console.log(`${good}/${reps.length} reps timed correctly`);
