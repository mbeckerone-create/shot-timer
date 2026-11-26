// Day audit: like eval_clips.js, but writes every string (film truth, phone log, matches) as JSON for the audit page.
// usage: node tools/audit_day.js <session.json> <wavdir> <out.json>
// usage: node tools/eval_clips.js <session.json> <wavdir> [--det path/to/detector.js] [--lf dB] [--wind dB] [--gain dB] [-v]
//   wavdir holds clipN.wav made with:  ffmpeg -i …-clipN.mp4 -ac 1 -ar 48000 clipN.wav
//   --lf   adds a low-frequency (80 Hz) thump this many dB re full scale under every real shot, like the muzzle blast an
//          unclipped iPhone mic delivers (the films are clipped at 0 dBFS by AAC, so their low end is tamer than live input)
//   --wind adds 20–150 Hz rumble at this level for the whole clip
//   --gain scales the whole clip (the live input reached ~+10 dB over the film's level on Nov 24)
// Truth = the film's own soundtrack: onsets where the 2 kHz-high-passed level jumps ≥ 20 dB within 3 ms to above -15 dB,
// at least 150 ms apart (a steel ding 70-120 ms after a shot is not a new shot). Per string the app's own-gun gate
// (S.gate dB below the loudest kept shot) is applied, as the app does.
const fs = require('fs'), vm = require('vm'), path = require('path');
const args = process.argv.slice(2), opt = (k, d) => { const i = args.indexOf(k); return i >= 0 ? args[i + 1] : d; };
const [sessFile, wavDir, outFile] = args; const OUT = [];
// clip times are saved from the audio clock, which stops while iOS pauses audio; the camera doesn't. Use the clip log's
// wall clock (beep_scheduled carries both) to move each beep to where it really is in the video.
const logDir = path.dirname(sessFile), stemOf = (n) => n.replace(/-clip\d+$/, '');
function fixT(r) {
  const f = path.join(logDir, r.clip + '.json'); if (!fs.existsSync(f)) return r.clipT;
  const L = JSON.parse(fs.readFileSync(f, 'utf8')), ev = (L.events || []).filter((e) => e.type === 'beep_scheduled');
  const e = ev.reduce((a, q) => (Math.abs(q.beepAt - L.recStartCtx - r.clipT) < Math.abs((a ? a.beepAt - L.recStartCtx : 1e9) - r.clipT) ? q : a), null);
  if (!e || Math.abs(e.beepAt - L.recStartCtx - r.clipT) > 0.5) return r.clipT;
  return r.clipT + ((e.wall - L.recStartWall) / 1000 - (e.ctx - L.recStartCtx));
}
const detPath = opt('--det', path.join(__dirname, '..', 'detector.js')), LF = +opt('--lf', -999), WIND = +opt('--wind', -999), GAIN = +opt('--gain', 0), V = args.includes('-v');
const ctx = {}; vm.createContext(ctx); vm.runInContext(fs.readFileSync(detPath, 'utf8') + ';this.SD=ShotDetector;', ctx); const SD = ctx.SD;
function readWav(p) {
  const b = fs.readFileSync(p); let o = 12, sr = 48000, d;
  while (o < b.length) { const id = b.toString('ascii', o, o + 4), n = b.readUInt32LE(o + 4); if (id === 'fmt ') sr = b.readUInt32LE(o + 12); if (id === 'data') { d = b.subarray(o + 8, o + 8 + n); break; } o += 8 + n; }
  const x = new Float32Array(d.length / 2); for (let i = 0; i < x.length; i++) x[i] = d.readInt16LE(i * 2) / 32768; return { x, sr };
}
function hpBlocks(x, sr) {   // 1 ms blocks of 2 kHz-HP energy (dB)
  const w0 = 2 * Math.PI * 2000 / sr, a = Math.sin(w0) / (2 * Math.SQRT1_2), c = Math.cos(w0), a0 = 1 + a;
  const b0 = (1 + c) / 2 / a0, b1 = -(1 + c) / a0, a1 = -2 * c / a0, a2 = (1 - a) / a0, B = sr / 1000, out = new Float32Array(Math.floor(x.length / B));
  let x1 = 0, x2 = 0, y1 = 0, y2 = 0, acc = 0;
  for (let n = 0; n < out.length * B; n++) { const y = b0 * x[n] + b1 * x1 + b0 * x2 - a1 * y1 - a2 * y2; x2 = x1; x1 = x[n]; y2 = y1; y1 = y; acc += y * y; if ((n + 1) % B === 0) { out[(n + 1) / B - 1] = 10 * Math.log10(acc / B + 1e-14); acc = 0; } }
  return out;
}
function truthShots(db, t0, t1) {
  const out = []; let last = -1e9;
  for (let i = Math.max(4, Math.round(t0 * 1000)); i < Math.min(db.length, t1 * 1000); i++) {
    if (db[i] > -15 && db[i] - Math.min(db[i - 3], db[i - 4]) >= 20 && i - last >= 150) { let k = i; while (db[k - 1] < db[k] - 10 && i - k < 3) k--; out.push(k / 1000); last = i; }
  }
  return out;
}
const S = JSON.parse(fs.readFileSync(sessFile, 'utf8'));
for (const r of S.records.filter((q) => !q.clip)) OUT.push({ noclip: true, r });
const recs = S.records.filter((r) => r.clip).sort((a, b) => a.at.localeCompare(b.at));
const byClip = {}; for (const r of recs) (byClip[r.clip.replace(/^.*-/, "")] = byClip[r.clip.replace(/^.*-/, "")] || []).push(r);
const tot = { truth: 0, kept: 0, gated: 0, missed: 0, extra: 0, phoneKept: 0, phoneGated: 0, phoneMissed: 0, phoneExtra: 0, mKept: 0, mGated: 0, mMissed: 0, mExtra: 0 };
for (const [clip, rs] of Object.entries(byClip)) {
  const f = path.join(wavDir, clip + '.wav'); if (!fs.existsSync(f)) { for (const r of rs) OUT.push({ clip, missing: true, r }); continue; }
  const { x, sr } = readWav(f);
  const truthDb = hpBlocks(x, sr);
  // find each string's beep in the film near clipT
  const strings = rs.map((r) => {
    const ct = fixT(r); r.clipFixed = +ct.toFixed(2);
    const bf = new SD.BeepFinder(sr, r.cfg.beepHz || 2400), s0 = Math.max(0, Math.round((ct - 0.6) * sr)); bf.window(s0, s0 + 2.5 * sr);
    let beep = null; for (let i = s0; i < Math.min(x.length, s0 + 3 * sr) && beep === null; i += 128) beep = bf.process(x.subarray(i, i + 128), i);
    const b = beep !== null ? beep / sr : ct;
    const lastLogged = Math.max(0, ...r.shots.map((q) => q.t));
    // an incomplete drill rep may have stopped listening early: look 5 s further to see shots fired after it quit
    const loud = r.shots.filter((q) => !q.removed && q.db >= -15).length, short = r.drillShots && loud < r.drillShots;
    return { r, beep: b, acoustic: beep !== null, end: b + Math.max(lastLogged, 3) + (short ? 6.0 : 1.0) };
  });
  for (let i = 0; i < strings.length - 1; i++) strings[i].end = Math.min(strings[i].end, strings[i + 1].beep - 0.3);
  // stress the input
  for (let i = 0; i < x.length; i++) x[i] *= 10 ** (GAIN / 20);
  if (WIND > -999) { let lp = 0, lp2 = 0, seed = 1; const ga = 10 ** (WIND / 20), al = 2 * Math.PI * 150 / sr; for (let i = 0; i < x.length; i++) { seed = (seed * 16807) % 2147483647; const w = seed / 2147483647 * 2 - 1; lp += al * (w - lp); lp2 += al * (lp - lp2); x[i] += ga * 12 * lp2 * (1 + 0.5 * Math.sin(2 * Math.PI * 0.3 * i / sr)); } }
  const allTruth = strings.flatMap((s) => truthShots(truthDb, s.beep + 0.08, s.end));
  if (LF > -999) { const ga = 10 ** (LF / 20); for (const t of allTruth) { const s0 = Math.round(t * sr); for (let k = 0; k < 0.12 * sr && s0 + k < x.length; k++) x[s0 + k] += ga * Math.exp(-k / (0.025 * sr)) * Math.sin(2 * Math.PI * 80 * k / sr); } }
  // run one detector over the clip, armed only inside each string (as the app does)
  const cfg = rs[0].cfg, det = new SD(sr, { shotDb: SD.sensitivityToDb(cfg.sens), echoMs: cfg.echo, lockMs: cfg.lock });
  const open = strings.map((s) => [Math.round((s.beep + 0.08) * sr), Math.round(s.end * sr)]), blank = []; let p = -Infinity;
  for (const [a, b] of open) { blank.push([p, a - 1]); p = b + 1; } blank.push([p, Infinity]); det.setBlank(blank);
  for (let i = 0; i < x.length; i += 128) det.process(x.subarray(i, i + 128));
  for (const s of strings) {
    const truth = truthShots(truthDb, s.beep + 0.08, s.end).map((t) => t - s.beep);
    const truthDbs = truth.map((t) => { let m = -120; for (let k = Math.round((t + s.beep) * 1000); k < Math.round((t + s.beep) * 1000) + 15 && k < truthDb.length; k++) m = Math.max(m, truthDb[k]); return +m.toFixed(1); });
    const mine = det.shots.filter((q) => q.frame / sr >= s.beep && q.frame / sr <= s.end).map((q) => ({ t: q.frame / sr - s.beep, db: q.peakDb }));
    const gate = s.r.gate || 10, top = Math.max(...mine.map((q) => q.db), -1e9); for (const q of mine) q.g = q.db < top - gate;
    const phone = s.r.shots.map((q) => ({ t: q.t, db: q.db, g: !!q.removed }));
    const score = (dets, key) => {
      const used = new Set(), marks = [];
      for (const t of truth) { const m = dets.find((q) => !used.has(q) && Math.abs(q.t - t) < 0.06); if (m) { used.add(m); tot[key + (m.g ? 'Gated' : 'Kept')]++; marks.push(m.g ? 'G' : 'K'); } else { tot[key + 'Missed']++; marks.push('-'); } }
      const ex = dets.filter((q) => !used.has(q) && !q.g); tot[key + 'Extra'] += ex.length; return { marks: marks.join(''), ex };
    };
    tot.truth += truth.length;
    const k = { kept: 0, gated: 0, missed: 0, extra: 0 };
    const a = score(mine, 'm'), b = score(phone, 'phone');
    OUT.push({ clip, beep: +s.beep.toFixed(3), acoustic: s.acoustic, end: +s.end.toFixed(2), truth: truth.map((t, i) => ({ t: +t.toFixed(3), db: truthDbs[i] })), phoneMarks: b.marks, phoneExtra: b.ex.map((q) => ({ t: q.t, db: q.db })), detMarks: a.marks, r: s.r });
    const line = `${clip} ${(s.r.drillName || 'free').slice(0, 10).padEnd(10)} rep${s.r.rep || '-'} beep@${s.beep.toFixed(2)}${s.acoustic ? '' : '?'} truth ${String(truth.length).padStart(2)}  phone ${b.marks.padEnd(9)} new ${a.marks.padEnd(9)}` +
      (a.ex.length ? ` extra:${a.ex.map((q) => q.t.toFixed(2) + '@' + q.db.toFixed(0)).join(',')}` : '');
    console.log(line);
    if (V) { console.log('   truth', truth.map((t) => t.toFixed(3)).join(' ')); console.log('   new  ', mine.map((q) => q.t.toFixed(3) + '@' + q.db.toFixed(0) + (q.g ? 'G' : '')).join(' ')); console.log('   phone', phone.map((q) => q.t.toFixed(3) + '@' + q.db.toFixed(0) + (q.g ? 'G' : '')).join(' ')); }
  }
}
const sum = (k) => `kept ${tot[k + 'Kept']}  gated ${tot[k + 'Gated']}  missed ${tot[k + 'Missed']}  extra ${tot[k + 'Extra']}`;
if (outFile) fs.writeFileSync(outFile, JSON.stringify({ session: S.session, build: S.build, strings: OUT }, null, 1));
console.log(`\ntruth ${tot.truth}\nphone (as logged): ${sum('phone')}\ndetector on film: ${sum('m')}`);
