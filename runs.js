/* Shot Timer — seeing your shots inside a session (design page "Session features"):
 *  1. Run done: after each range run the result stays on the timer screen until the next one starts.
 *  2. Range hub "This session": one row per drill / free shooting, tap for its runs.
 *  3. Runs: every rep of one drill this session.   4. Run: every shot of one rep, with Keep / strike out.
 * app.js owns the timer and history; ui.js owns the other screens. This file only reads and edits saved records. */
'use strict';
(() => {
  const el = (tag, cls, txt) => { const e = document.createElement(tag); if (cls) e.className = cls; if (txt != null) e.textContent = txt; return e; };
  const f2 = (v) => (v == null || !isFinite(v) ? '—' : v.toFixed(2));
  const ini = (n) => (window.UI ? UI.initials(n || '?') : String(n || '?').slice(0, 2).toUpperCase());
  const tm = (iso) => new Date(iso).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
  const TG = ['var(--p-text)', 'var(--p-dry)', '#e3b58f', '#a9d5a0', '#d7a6e0', '#e8d88a', '#8fd3d9', '#f0a3a3'];
  const tgColor = (t) => TG[(Math.max(1, +t || 1) - 1) % TG.length];
  const MINUS = '−';
  const chev = () => el('span', 'mi mi-chev hd-chev2');

  // ---------- records ----------
  const keyOf = (r) => (r.mode === 'dry' ? 'dry:' + (r.drill || 'trigger') : r.drillName || 'Free shooting');
  const nameOf = (k) => (k.startsWith('dry:') ? DRILL_NAMES[k.slice(4)] : k);
  const isFree = (k) => k === 'Free shooting';
  const live = (r) => r.shots.filter((s) => !s.removed).map((s) => s.t);
  const total = (r) => (r.mode === 'dry' ? (r.drill === 'reload' ? r.reload : live(r)[0]) : live(r).slice(-1)[0]);
  const first = (r) => live(r)[0];
  const counted = (r) => r.mode === 'dry' || (!isFree(keyOf(r)) && recComplete(r));     // may count as a best
  function targetOf(r, k) {                                          // which target the k-th shot (0-based) goes on
    if (!r.steps) return null; let i = 0;
    for (const x of r.steps) { if (x.reload) continue; if (k < i + x.n) return x.t; i += x.n; }
    return null;
  }
  // splits with what they are: draw, split on the same target, or a transition
  function splitsOf(r) {
    const t = live(r), out = [];
    t.forEach((v, i) => {
      const tg = targetOf(r, i), pt = i ? targetOf(r, i - 1) : null;
      if (!i) out.push({ v, kind: 'draw', tg, label: r.drillName ? `Draw${tg ? ' · T' + tg : ''}` : 'First' });
      else if (tg && pt && tg !== pt) out.push({ v: v - t[i - 1], kind: 'tr', tg, label: `T${pt} → T${tg}` });
      else out.push({ v: v - t[i - 1], kind: 'split', tg, label: 'Split' });
    });
    const sp = out.filter((x) => x.kind === 'split'); if (sp.length) { const b = sp.reduce((a, x) => (x.v < a.v ? x : a)); b.best = true; }
    return out;
  }
  const sesOf = (r) => (r && r.session) || activeSession;
  const groupRecs = (sid, key) => history.filter((h) => h.session === sid && keyOf(h) === key);   // newest first
  function runLabel(r) {                                             // "Rep 2" in a drill, "String 3" in free shooting
    if (r.mode !== 'dry' && r.rep) return `Rep ${r.rep}`;
    const same = groupRecs(sesOf(r), keyOf(r)).filter((h) => h.shooter === r.shooter).reverse();
    return `${r.mode === 'dry' || r.drillName ? 'Rep' : 'String'} ${same.indexOf(r) + 1}`;
  }
  function saveEdit(r) {
    saveHistory(); if (typeof renderHistory === 'function') renderHistory();
    if (T.saved === r.id) {                                          // the run still on the timer: keep the two in step
      T.shots = r.shots.map((s) => ({ t: s.t, db: s.db, removed: !!s.removed, auto: s.gated ? 'quiet' : s.extra ? 'extra' : undefined, keep: s.keep }));
      renderShots(); renderStats();
    }
    const d = (T.drillRes || []).find((x) => x.rec === r.id);
    if (d) { const v = total(r); d.inc = !!r.drillShots && live(r).length < r.drillShots && live(r).length > 0; d.v = v ?? null; d.ok = recUnderPar(r); if (window.UI) UI.renderPlan(); }
  }
  function deleteRun(r) {
    history = history.filter((h) => h !== r); saveHistory(); if (typeof renderHistory === 'function') renderHistory(); renderSession();
    const i = (T.drillRes || []).findIndex((x) => x.rec === r.id); if (i >= 0) { T.drillRes.splice(i, 1); if (window.UI) UI.renderPlan(); }
    if (T.saved === r.id) { T.saved = false; T.shots = []; renderShots(); renderStats(); $('btn-review').disabled = true; hideRunDone(); setStatus('Run deleted'); }
    toast('Run deleted');
  }

  // ---------- 1. run done ----------
  const RD = $('rd'), VT = $('view-timer');
  let rdId = null;
  function cell(k, v, cls) { const d = el('div'); d.append(el('span', null, k), el('b', cls || null, v)); return d; }
  function showRunDone() {
    const r = history.find((h) => h.id === T.saved);
    if (!r || r.mode === 'dry' || isDry()) return hideRunDone();
    rdId = r.id; renderRunDone(r); RD.hidden = false; VT.classList.add('rd-on'); VT.scrollTop = 0;
  }
  function hideRunDone() { rdId = null; RD.hidden = true; VT.classList.remove('rd-on'); }
  function refresh() { if (rdId) { const r = history.find((h) => h.id === rdId); if (r) renderRunDone(r); else hideRunDone(); } }
  function renderRunDone(r) {
    const key = keyOf(r), free = isFree(key), t = live(r), n = t.length, need = r.drillShots || 0, inc = need && n < need;
    const tot = total(r), sp = splitsOf(r);
    const reps = $('rd-reps'); reps.innerHTML = ''; reps.hidden = !T.preset;
    if (T.preset) {
      const rr = T.drillRes || [], cur = rr.findIndex((x) => x.rec === r.id);
      for (let i = 0; i < T.preset.reps; i++) { const x = rr[i], s = el('i'); s.className = i === cur ? 'cur' : x ? (x.inc ? 'inc' : x.ok ? 'ok' : 'over') : ''; reps.appendChild(s); }
    }
    $('rd-done').textContent = free ? `String done · ${n} shot${n === 1 ? '' : 's'}` : `Run done · ${n} of ${need || n} shots`;
    const pill = $('rd-pill'); pill.className = 'rd-pill';
    if (inc) { pill.textContent = 'Incomplete'; pill.classList.add('warn'); }
    else if (r.par) { const ok = tot <= r.par; pill.textContent = ok ? `Under par ${r.par.toFixed(2)}` : `Over par +${(tot - r.par).toFixed(2)}`; if (!ok) pill.classList.add('over'); }
    else pill.textContent = ini(r.shooter);
    $('rd-time').textContent = f2(tot); RD.classList.toggle('inc', !!inc);
    const note = $('rd-note'); note.hidden = !inc; if (inc) note.textContent = `${n} shot${n === 1 ? '' : 's'} heard, the drill calls for ${need}. Not counted as under par or as a best. Tap to fix it.`;
    const same = groupRecs(sesOf(r), key).filter((h) => h.shooter === r.shooter), cells = $('rd-cells'); cells.innerHTML = '';
    if (free) {
      const bf = Math.min(...same.map(first).filter((v) => v != null)), spl = sp.filter((x) => x.kind !== 'draw').map((x) => x.v);
      cells.append(cell('First shot', f2(first(r))), cell('Best split', spl.length ? f2(Math.min(...spl)) : '—'), cell('Session best first', f2(bf), first(r) === bf && same.length > 1 ? 'hi' : ''));
    } else {
      const ok = same.filter(counted), prev = ok.filter((h) => h.at < r.at)[0], best = ok.length ? Math.min(...ok.map(total)) : null;
      const d = !inc && prev ? tot - total(prev) : null;
      cells.append(cell('vs last rep', d == null ? '—' : (d <= 0 ? MINUS : '+') + Math.abs(d).toFixed(2), d != null && d <= 0 ? 'hi' : ''),
        cell('Session best', f2(best), !inc && best != null && tot === best && ok.length > 1 ? 'hi' : ''), cell('Draw', f2(first(r))));
    }
    // splits as bars: the draw in grey, splits in their target's colour, the best split in orange
    const bars = $('rd-bars'); bars.innerHTML = ''; const mx = Math.max(...sp.map((x) => x.v), 0.01);
    bars.style.setProperty('--n', Math.max(4, sp.length));
    for (const x of sp) {
      const c = el('div', 'rd-bar'), h = Math.max(4, Math.round(x.v / mx * 100));
      const bar = el('i'); bar.style.height = h + '%'; bar.style.background = x.kind === 'draw' ? 'var(--rd-draw)' : x.best ? 'var(--p-mark)' : tgColor(x.tg);
      c.append(el('b', null, f2(x.v)), bar, el('span', null, x.best ? `${x.label} · best` : x.label)); bars.appendChild(c);
    }
    $('rd-all-t').innerHTML = `${free ? 'All free shooting today' : 'All runs of this drill today'} <i>· ${groupRecs(sesOf(r), key).length}</i>`;
    refreshNext();
  }
  function refreshNext(left) {
    if (!rdId) return; const p = T.preset, unit = p ? 'rep' : 'string', b = $('rd-next'); if (left == null) left = T.resetLeft;
    if (p && (T.drillRes || []).length >= p.reps && T.state !== 'reholster') b.textContent = 'Shoot drill again';
    else b.textContent = T.state === 'reholster' && left != null ? `Next ${unit} · ${left}` : `Next ${unit}`;
  }
  $('rd-next').onclick = () => {
    if (T.state === 'reholster') { clearTimeout(T.nextTimer); start(); return; }
    onMain();
  };
  $('rd-score').onclick = () => { if (window.UI) UI.openScore(); };
  $('rd-del').onclick = () => { const r = history.find((h) => h.id === rdId); if (r && confirm(`Delete this run (${f2(total(r))} s)? It won't count in the session.`)) deleteRun(r); };
  $('rd-card').onclick = () => rdId && openRun(rdId, 'timer');
  $('rd-all').onclick = () => { const r = history.find((h) => h.id === rdId); if (r) openRuns(keyOf(r), 'timer', sesOf(r)); };

  // ---------- 2. Range hub: this session, one row per drill ----------
  function hubLog(box) {
    box.innerHTML = ''; if (!activeSession) return;
    const order = [], by = {};
    for (const r of history) { if (r.session !== activeSession) continue; const k = keyOf(r); if (!by[k]) { by[k] = []; order.push(k); } by[k].push(r); }
    for (const k of order) {
      const recs = by[k], free = isFree(k), who = [...new Set(recs.map((r) => r.shooter))];
      const per = who.map((w) => `${ini(w)} ${recs.filter((r) => r.shooter === w).length}`).join(' · ');
      let sub, best, bl;
      if (free) { sub = `${per} string${recs.length === 1 ? '' : 's'}`; best = Math.min(...recs.map(first).filter((v) => v != null)); bl = 'best first'; }
      else {
        const under = recs.filter((r) => r.mode === 'dry' ? false : recUnderPar(r)).length, inc = recs.filter((r) => r.mode !== 'dry' && !recComplete(r)).length;
        sub = `${per} rep${recs.length === 1 ? '' : 's'}${recs[0].par ? ` · ${under} under par` : ''}${inc ? ` · ${inc} incomplete` : ''}`;
        const ok = recs.filter(counted).map(total).filter((v) => v != null); best = ok.length ? Math.min(...ok) : null; bl = 'best';
      }
      const row = el('button', 'hl-row'), tt = el('span', 'hl-t'); tt.append(el('b', null, nameOf(k)), el('i', null, sub));
      const bv = el('span', 'hl-b'); bv.append(el('b', null, isFinite(best) ? f2(best) : '—'), el('i', null, bl));
      row.append(tt, bv, chev()); row.onclick = () => openRuns(k, 'range', activeSession); box.appendChild(row);
    }
  }

  // ---------- 3. runs of one drill ----------
  let rv = { key: null, back: 'range', sid: null, who: null };
  function openRuns(key, back, sid) {
    if (rv.key !== key) rv.who = null;
    rv = Object.assign(rv, { key, back: back || rv.back, sid: sid || rv.sid || activeSession });
    renderRuns(); showScreen('runs'); $('view-runs').scrollTop = 0;
  }
  function renderRuns() {
    const all = groupRecs(rv.sid, rv.key); if (!all.length) { showScreen(rv.back); return; }
    const free = isFree(rv.key), dry = rv.key.startsWith('dry:'), r0 = all.find((r) => r.targets) || all[0];
    $('runs-back').textContent = rv.back === 'timer' ? 'Timer' : 'Range';
    $('runs-title').textContent = nameOf(rv.key);
    const tg = r0.targets ? r0.targets.map((t) => `T${t.id} ${t.dist} yd`).join(', ') : '';
    const st = r0.steps ? r0.steps.map((x) => (x.reload ? 'reload' : x.n)).join(' + ') + ' shots' : '';
    $('runs-sub').textContent = ['This session', dry ? 'dry fire' : '', tg, st, r0.par ? `par ${r0.par.toFixed(2)}` : free ? 'no par' : ''].filter(Boolean).join(' · ');
    const who = [...new Set(all.map((r) => r.shooter))], W = $('runs-who'); W.innerHTML = ''; W.hidden = who.length < 2;
    if (rv.who && !who.includes(rv.who)) rv.who = null;
    if (who.length > 1) [null, ...who].forEach((w) => { const b = el('button', rv.who === w ? 'on' : '', w == null ? 'All' : ini(w)); b.title = w || 'Everyone'; b.onclick = () => { rv.who = w; renderRuns(); }; W.appendChild(b); });
    const recs = all.filter((r) => rv.who == null || r.shooter === rv.who);
    // stats
    const S3 = $('runs-stats'); S3.innerHTML = '';
    const box = (k, v) => { const d = el('div'); d.append(el('span', null, k), el('b', null, v)); S3.appendChild(d); };
    if (free) {
      const fs = recs.map(first).filter((v) => v != null), spl = recs.flatMap((r) => splitsOf(r).filter((x) => x.kind !== 'draw').map((x) => x.v));
      box('Best first', fs.length ? f2(Math.min(...fs)) : '—'); box('Best split', spl.length ? f2(Math.min(...spl)) : '—'); box('Strings', String(recs.length));
    } else {
      const ok = recs.filter(counted).map(total).filter((v) => v != null);
      box('Best', ok.length ? f2(Math.min(...ok)) : '—'); box('Average', ok.length ? f2(ok.reduce((a, b) => a + b, 0) / ok.length) : '—');
      const tr = recs.filter(counted).flatMap((r) => splitsOf(r).filter((x) => x.kind === 'tr'));
      if (tr.length) { const lab = tr[0].label; const v = tr.filter((x) => x.label === lab).map((x) => x.v); box(`${lab} avg`, f2(v.reduce((a, b) => a + b, 0) / v.length)); }
      else { const spl = recs.flatMap((r) => splitsOf(r).filter((x) => x.kind === 'split').map((x) => x.v)); box('Best split', spl.length ? f2(Math.min(...spl)) : '—'); }
    }
    // rows
    const okVals = recs.filter(counted).map(total).filter((v) => v != null), bestV = !free && okVals.length ? Math.min(...okVals) : null;
    const L = $('runs-list'); L.innerHTML = '';
    for (const r of recs) {
      const t = live(r), need = r.mode === 'dry' ? t.length : r.drillShots || t.length, inc = r.mode !== 'dry' && !free && !recComplete(r), v = total(r), isBest = bestV != null && v === bestV && counted(r);
      const row = el('button', 'rv-row'), lab = el('span', 'rv-l'); lab.append(el('b', null, runLabel(r)), el('i', null, ini(r.shooter)));
      const dots = el('span', 'rv-dots'); dots.setAttribute('aria-label', `${t.length} of ${need} shots`);
      for (let i = 0; i < Math.min(need, 12); i++) { const d = el('i'); if (i < t.length) d.style.background = tgColor(targetOf(r, i)); else d.className = 'miss'; dots.appendChild(d); }
      if (need > 12) dots.appendChild(el('small', null, `+${need - 12}`));
      if (isBest && recs.length > 1) dots.appendChild(el('em', 'best', 'Best'));
      if (inc) dots.appendChild(el('em', 'inc', `Incomplete ${t.length} / ${need}`));
      const val = el('b', 'rv-v' + (isBest && recs.length > 1 ? ' hi' : '') + (inc ? ' mu' : ''), inc ? '—' : f2(v));
      row.append(lab, dots, val, chev()); row.onclick = () => openRun(r.id, 'runs'); L.appendChild(row);
    }
    $('runs-note').textContent = free ? 'Dots are shots. Tap a string for its splits.'
      : r0.targets && r0.targets.length > 1 ? `Dots are shots: ${r0.targets.slice(0, 3).map((x, i) => `${['white', 'blue', 'tan'][i]} on T${x.id}`).join(', ')}; hollow = not heard. An incomplete rep never counts as under par or as a best.`
        : 'Dots are shots, hollow = not heard. An incomplete rep never counts as under par or as a best.';
    const pr = !free && !dry && window.UI ? UI.allDrills().find((d) => d.name === rv.key) : null;
    const again = $('runs-again'); again.hidden = !free && !dry && !pr;
    again.textContent = free ? 'Free shoot again' : 'Shoot this drill again';
    again.onclick = () => { if (dry) enterDrill('dry', rv.key.slice(4)); else if (window.UI) UI.shoot(pr || null); };
  }
  $('runs-back').onclick = () => showScreen(rv.back);

  // ---------- 4. one run ----------
  let rn = { id: null, back: 'runs' };
  const WHY = { quiet: 'quieter, not yours?', extra: 'after the last shot', manual: 'struck out' };
  function openRun(id, back) { rn = { id, back }; if (renderRun()) { showScreen('run'); $('view-run').scrollTop = 0; } }
  function renderRun() {
    const r = history.find((h) => h.id === rn.id); if (!r) { showScreen(rn.back === 'timer' ? 'timer' : 'runs'); return false; }
    const key = keyOf(r), free = isFree(key), t = live(r), need = r.drillShots || 0, inc = r.mode !== 'dry' && need && t.length < need, tot = total(r);
    $('run-back').textContent = rn.back === 'timer' ? 'Timer' : nameOf(key);
    $('run-title').textContent = `${runLabel(r)} · ${ini(r.shooter)}`;
    $('run-sub').textContent = [tm(r.at), r.gun, r.clip ? `clip ${r.clip.replace(/^.*-clip/, '')} at ${Math.floor(r.clipT / 60)}:${String(Math.floor(r.clipT % 60)).padStart(2, '0')}` : ''].filter(Boolean).join(' · ');
    const pill = $('run-pill'); pill.className = 'rn-pill'; pill.hidden = !(inc || (r.par && t.length));
    if (inc) { pill.textContent = 'Incomplete'; pill.classList.add('warn'); }
    else if (r.par && t.length) { pill.textContent = tot <= r.par ? 'Under par' : 'Over par'; if (tot > r.par) pill.classList.add('over'); }
    // timeline: beep at the left, par at the right (or the last sound), every sound as a mark
    $('run-par').textContent = r.par ? `par ${r.par.toFixed(2)}` : '';
    const all = r.shots.slice().sort((a, b) => a.t - b.t), span = Math.max(r.par || 0, ...all.map((s) => s.t), 0.5) * 1.03, TL = $('run-tl'); TL.innerHTML = '<span class="tl-line"></span><span class="tl-beep"></span>';
    let k = 0;
    for (const s of all) { const m = el('span', 'tl-m' + (s.removed ? ' off' : '')); m.style.left = `calc(${(s.t / span * 100).toFixed(1)}% - 4px)`; if (!s.removed) m.style.background = tgColor(targetOf(r, k++)); TL.appendChild(m); }
    if (r.par) { const p = el('span', 'tl-par'); p.style.left = `${(r.par / span * 100).toFixed(1)}%`; TL.appendChild(p); }
    $('run-note').textContent = inc ? `${t.length} shot${t.length === 1 ? '' : 's'} heard, the drill calls for ${need}. Not counted as under par.`
      : t.length ? `${t.length} shot${t.length === 1 ? '' : 's'} · ${f2(tot)} s${r.par ? (tot <= r.par ? ` · ${(r.par - tot).toFixed(2)} under par` : ` · ${(tot - r.par).toFixed(2)} over par`) : ''}` : 'No shots kept. Tap Keep on one below.';
    // shots
    const box = $('run-shots'); box.innerHTML = ''; const sp = splitsOf(r); let j = 0;
    for (const s of all) {
      const row = el('div', 'rn-row' + (s.removed ? ' off' : ''));
      if (!s.removed) {
        const x = sp[j++]; row.append(el('b', 'rn-n', String(j)), el('span', 'rn-l', x.kind === 'draw' ? x.label : `${x.label} · ${f2(x.v)}`), el('b', 'rn-t', f2(s.t)), el('span', 'rn-db', `${s.db < 0 ? MINUS : ''}${Math.abs(Math.round(s.db))} dB`));
        row.setAttribute('role', 'button'); row.title = 'Not your shot? Tap to strike it out';
        row.onclick = () => { if (!confirm(`Strike out the sound at ${f2(s.t)} s? It won't count as a shot.`)) return; s.removed = true; delete s.keep; delete s.gated; delete s.extra; saveEdit(r); renderRun(); };
      } else {
        const why = s.gated ? WHY.quiet : s.extra ? WHY.extra : WHY.manual, keep = el('button', 'rn-keep', 'Keep');
        keep.onclick = () => { s.removed = false; s.keep = true; delete s.gated; delete s.extra; saveEdit(r); renderRun(); };
        row.append(el('span', 'rn-n', '·'), el('span', 'rn-l', `${f2(s.t)} · ${why}`), keep);
      }
      box.appendChild(row);
    }
    if (!all.length) box.appendChild(el('div', 'rn-row off', 'No sounds saved'));
    // shots you fired: a correction for training the detector
    const fr = $('run-fired-row'); fr.hidden = r.mode === 'dry';
    const fired = r.fired ?? (need || t.length); $('run-fired').textContent = fired;
    $('run-fm').onclick = () => { r.fired = Math.max(0, fired - 1); saveHistory(); renderRun(); };
    $('run-fp').onclick = () => { r.fired = Math.min(99, fired + 1); saveHistory(); renderRun(); };
    $('run-play').disabled = !r.clip; $('run-play').textContent = r.clip ? 'Play clip' : 'No clip';
    $('run-play').onclick = () => playClip(r);
    $('run-del').onclick = () => { if (!confirm(`Delete this run (${f2(tot)} s)? It won't count in the session.`)) return; deleteRun(r); showScreen(rn.back === 'timer' ? 'timer' : groupRecs(sesOf(r), key).length ? 'runs' : 'range'); if (rn.back !== 'timer') renderRuns(); };
    return true;
  }
  $('run-back').onclick = () => { if (rn.back === 'runs') renderRuns(); showScreen(rn.back === 'timer' ? 'timer' : 'runs'); };
  async function playClip(r) {
    const c = await clipDB.get(r.clip).catch(() => null);
    if (!c) { toast('That clip is no longer on this phone'); return; }
    const v = $('clip-video'), url = URL.createObjectURL(c.video); v.src = url; $('clipview').hidden = false;
    v.onloadedmetadata = () => { v.currentTime = Math.max(0, (r.clipT || 0) - 1); v.play().catch(() => {}); };
    $('clip-close').onclick = () => { v.pause(); v.removeAttribute('src'); v.load(); URL.revokeObjectURL(url); $('clipview').hidden = true; };
  }

  // a session's drills, each with its best (for the End sheet)
  function sessionGroups(sid) {
    const order = [], by = {};
    for (const r of history) { if (r.session !== sid) continue; const k = keyOf(r); if (!by[k]) { by[k] = []; order.push(k); } by[k].push(r); }
    return order.map((k) => {
      const recs = by[k];
      if (isFree(k)) { const v = recs.map(first).filter((x) => x != null); return { name: nameOf(k), best: v.length ? `best first ${f2(Math.min(...v))}` : '' }; }
      const v = recs.filter(counted).map(total).filter((x) => x != null); return { name: nameOf(k), best: v.length ? `best ${f2(Math.min(...v))}` : `${recs.length} rep${recs.length === 1 ? '' : 's'}` };
    });
  }
  window.RUNS = { sessionGroups, showRunDone, hideRunDone, refresh, refreshNext, hubLog, openRuns, openRun };
})();
