// Old vs new Draw-drill logic on the 16 video reps (templates leave-one-rep-out from the video's own mic).
const { beeps, ev } = JSON.parse(require('fs').readFileSync('/home/user/data/dl2/ev.json'));
const shape = (v) => { const m = v.reduce((a, c) => a + c, 0) / v.length; return v.map((q) => q - m); };
const cos = (a, c) => { let s = 0, na = 0, nb = 0; for (let i = 0; i < a.length; i++) { s += a[i] * c[i]; na += a[i] * a[i]; nb += c[i] * c[i]; } return s / Math.sqrt(na * nb + 1e-12); };
const mean = (L) => shape(L[0].bands).map((_, k) => L.reduce((t, e) => t + shape(e.bands)[k], 0) / L.length);
const singles = (w) => w.filter((e) => !w.some((q) => q !== e && Math.abs(q.t - e.t) >= 0.08 && Math.abs(q.t - e.t) < 0.25 && q.db > e.db - 15));
const reps = beeps.map((bt) => { const w = ev.filter((e) => e.t > bt + 0.08 && e.t < bt + 5); return { bt, w, s: singles(w.filter((e) => e.db > -30)) }; });
// truth: when a rep has two loud singles 0.4-1.2 s apart within 2.5 s, first=holster, second=click
reps.forEach((r) => { const c = r.s.filter((e) => e.t < r.bt + 2.5); r.truth = c.length >= 2 && c[1].t - c[0].t > 0.4 ? { h: c[0], c: c[1] } : null; });
const M = +(process.env.M || 0.9);
let tally = { old: 0, neu: 0, n: 0 };
reps.forEach((r, k) => {
  if (!r.truth) { console.log(`rep ${k + 1}: (no clear holster+click pair in video audio, skipped)`); return; }
  const tr = reps.filter((q, j) => j !== k && q.truth), ct = mean(tr.map((q) => q.truth.c)), ht = mean(tr.map((q) => q.truth.h));
  const kind = (e) => { const cs = cos(shape(e.bands), ct), hs = process.env.NOHOL ? -1 : cos(shape(e.bands), ht); return hs >= M && hs > cs ? 'holster' : cs >= M ? 'click' : null; };
  const evs = singles(r.w.filter((e) => e.db > -40)).map((e) => ({ e, k: kind(e) })).filter((q) => q.k);
  // OLD: first holster (before any click) + first click ends the rep
  let oh = null, oc = null; for (const q of evs) { if (q.k === 'holster' && !oh && !oc) oh = q.e; if (q.k === 'click') { oc = q.e; break; } }
  // NEW: first click with nothing before it is tentative for 1.6 s; holster = loudest snap 0.25–2.0 s before the click
  let nc = null, nh = null;
  for (let i = 0; i < evs.length; i++) {
    const q = evs[i]; if (q.k !== 'click') continue;
    const pri = evs.filter((p) => p.e.t < q.e.t - 0.25 && p.e.t > q.e.t - 2.0);
    if (!pri.length) { const nxt = evs.find((p) => p.k === 'click' && p.e.t >= q.e.t + 0.35 && p.e.t <= q.e.t + 1.4); if (nxt) { nh = q.e; nc = nxt.e; break; } nc = q.e; break; }
    nc = q.e; nh = pri.reduce((a, p) => (p.e.db > a.e.db ? p : a)).e; break;
  }
  const ok = (h, c) => h === r.truth.h && c === r.truth.c, f = (e) => (e ? (e.t - r.bt).toFixed(3) : '—');
  tally.n++; tally.old += ok(oh, oc); tally.neu += ok(nh, nc);
  console.log(`rep ${String(k + 1).padStart(2)} truth ${f(r.truth.h)}/${f(r.truth.c)}  old ${f(oh)}/${f(oc)} ${ok(oh, oc) ? '✓' : '✗'}  new ${f(nh)}/${f(nc)} ${ok(nh, nc) ? '✓' : '✗'}`);
});
console.log(`old logic ${tally.old}/${tally.n}   new logic ${tally.neu}/${tally.n}`);
