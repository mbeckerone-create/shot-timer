/* Shot Timer — the screens from the design board (home, Range session, drills, editor, voice scoring), wired to the
 * real timer in app.js. app.js owns timing, detection, film, history and sessions; this file owns what you tap. */
'use strict';
(() => {
  const P = document.getElementById('app');
  const el = (tag, cls, txt) => { const e = document.createElement(tag); if (cls) e.className = cls; if (txt != null) e.textContent = txt; return e; };
  const saveJSON = (k, v) => { try { localStorage.setItem(k, JSON.stringify(v)); } catch {} };
  const loadJSON = (k, d) => { try { const v = JSON.parse(localStorage.getItem(k) || 'null'); return v == null ? d : v; } catch { return d; } };

  // ---------- look: style + scale the 300 px design up to the real screen ----------
  function applySkin(skin) {
    S.skin = skin; saveSettings();
    document.documentElement.dataset.skin = skin; P.dataset.skin = skin;
    const tc = document.querySelector('meta[name="theme-color"]'); if (tc) tc.content = skin === 'soft' ? '#e4e5e8' : '#0d0f12';
    gauge(0); parMark(T.preset ? T.preset.par : null);
  }
  function applyZoom() {
    const z = Math.max(1, Math.min(window.innerWidth / 300, 1.6)); P.style.setProperty('--z', z.toFixed(4));
    requestAnimationFrame(() => { const t = P.querySelector('.tabs'); if (t) document.documentElement.style.setProperty('--tabh', t.getBoundingClientRect().height + 'px'); });
  }
  window.addEventListener('resize', applyZoom); applyZoom();

  // ---------- shooters: your name first (Settings › Shooters), shown as initials ----------
  if (S.shooters[0] === 'Me') {                       // you told us your name: Michael Becker -> MB
    S.shooters[0] = 'Michael Becker'; if (S.shooter === 'Me') S.shooter = 'Michael Becker'; saveSettings();
    let changed = false; for (const r of history) if (r.shooter === 'Me') { r.shooter = 'Michael Becker'; changed = true; } if (changed) saveHistory();
  }
  const initials = (n) => { const w = String(n).trim().split(/\s+/); return (w[0][0] + (w.length > 1 ? w[w.length - 1][0] : '')).toUpperCase(); };
  const firstName = (n) => String(n).split(/\s+/)[0];
  function roster() {                                  // everyone, with how many sessions each has shot in
    const uses = {}; const seen = new Set();
    for (const r of history) { const k = r.shooter + '|' + (r.session || r.at.slice(0, 10)); if (!seen.has(k)) { seen.add(k); uses[r.shooter] = (uses[r.shooter] || 0) + 1; } }
    const names = [...S.shooters, ...tempNames.filter((n) => !S.shooters.includes(n))];
    return names.map((name, i) => ({ name, me: i === 0, uses: uses[name] || 0, temp: tempNames.includes(name) && !S.shooters.includes(name) }));
  }
  let tempNames = [];                                  // typed in before the session started: forgotten if it never starts
  let inSes = loadJSON('st.sesShooters', null);
  inSes = inSes && inSes.session === activeSession && activeSession ? inSes.names : [S.shooters[0]];
  const saveWho = () => saveJSON('st.sesShooters', { session: activeSession, names: inSes });
  function nextShooter() {                             // taking turns: whoever is next is up after each string / drill
    if (inSes.length < 2) return;
    const i = inSes.indexOf(S.shooter), nx = inSes[(i + 1) % inSes.length];
    S.shooter = nx; saveSettings(); renderChips(); toast(`Up next: ${firstName(nx)}`);
  }
  function togglePeople(open) {
    const m = $('sc-more'), t = $('sc-tog'); open = open ?? !m.classList.contains('open');
    m.classList.toggle('open', open); t.setAttribute('aria-expanded', open); m.classList.remove('done');
    if (open) setTimeout(() => m.classList.contains('open') && m.classList.add('done'), 260); else $('who-results').hidden = true;
    renderWho();
  }
  function chipFor(name, removable) {
    const up = name === S.shooter, b = el('button', 'on ini' + (up ? ' up' : ''), initials(name)); b.title = name;
    b.setAttribute('aria-label', `${name}${up ? ', up now' : ''}. Tap to make ${firstName(name)} up${removable ? '. Press and hold to remove' : ''}`);
    let t = null, held = false; const cancel = () => { clearTimeout(t); t = null; b.classList.remove('holding'); };
    b.onclick = () => { if (held) { held = false; return; } S.shooter = name; saveSettings(); renderChips(); renderWho(); };
    if (!removable) return b;
    b.addEventListener('pointerdown', () => { held = false; b.classList.add('holding'); t = setTimeout(() => {
      cancel(); held = true; inSes = inSes.filter((x) => x !== name); if (S.shooter === name) { S.shooter = inSes[0]; saveSettings(); renderChips(); }
      saveWho(); toast(`Removed ${name}`); renderWho(); renderResults(); }, 550); });
    ['pointerup', 'pointerleave', 'pointercancel'].forEach((ev) => b.addEventListener(ev, cancel));
    b.addEventListener('contextmenu', (e) => e.preventDefault());
    return b;
  }
  function renderWho() {
    const me = S.shooters[0]; if (!inSes.includes(me)) inSes.unshift(me);
    if (!inSes.includes(S.shooter)) { S.shooter = me; saveSettings(); renderChips(); }
    const top = $('hub-who'); top.innerHTML = '';
    inSes.forEach((n) => top.appendChild(chipFor(n, n !== me)));
  }
  function renderResults() {
    const res = $('who-results'); if (res.hidden) return;
    const raw = $('who-q').value.trim(), q = raw.toLowerCase(), R = roster();
    const match = (r) => !q || r.name.toLowerCase().includes(q);
    const top3 = R.filter((r) => r.uses > 0).sort((x, y) => y.uses - x.uses).slice(0, 3);
    const rest = R.filter((r) => !top3.includes(r)).sort((x, y) => x.name.localeCompare(y.name));
    res.innerHTML = '';
    const row = (r) => {
      const on = inSes.includes(r.name), b = el('button', on ? 'in' : '');
      b.append(el('i', null, initials(r.name)), el('span', null, r.name), (() => { const sm = el('small', null, on ? 'In session ' : r.uses ? r.uses + (r.uses === 1 ? ' session' : ' sessions') : 'New'); if (on) sm.insertAdjacentHTML('beforeend', '<svg class="ic" viewBox="0 0 24 24" aria-hidden="true"><path d="M5 12.5l4.5 4.5L19 7.5"/></svg>'); return sm; })());
      b.addEventListener('mousedown', (e) => e.preventDefault());
      b.onclick = () => { if (on) { if (!r.me) inSes = inSes.filter((x) => x !== r.name); } else inSes.push(r.name); saveWho(); renderWho(); renderResults(); };
      return b;
    };
    const head = (t) => res.appendChild(el('div', 'wr-h', t));
    const a1 = top3.filter(match), a2 = rest.filter(match);
    if (a1.length) { head('Most used'); a1.forEach((r) => res.appendChild(row(r))); }
    if (a2.length) { head(q ? 'Others' : 'Everyone else'); a2.forEach((r) => res.appendChild(row(r))); }
    if (q && !R.some((r) => r.name.toLowerCase() === q)) {
      const b = el('button', 'new'); b.append(el('i', null, '+'), el('span', null, `Add “${raw}” as a new shooter`));
      b.addEventListener('mousedown', (e) => e.preventDefault());
      b.onclick = () => { if (activeSession) { S.shooters.push(raw); saveSettings(); } else tempNames.push(raw); inSes.push(raw); saveWho(); $('who-q').value = ''; renderWho(); renderResults(); };
      res.appendChild(b);
    }
  }
  const openResults = () => { $('who-results').hidden = false; renderResults(); };
  $('sc-tog').onclick = () => togglePeople(); $('ses-title').onclick = () => togglePeople();
  $('who-q').addEventListener('focus', openResults); $('who-q').addEventListener('input', openResults);
  $('who-q').addEventListener('keydown', (e) => {
    if (e.key === 'Escape') { $('who-q').value = ''; $('who-q').blur(); }
    if (e.key === 'Enter') { e.preventDefault(); const f = $('who-results').querySelector('button'); if (f && $('who-q').value.trim()) { f.click(); $('who-q').value = ''; renderResults(); } }
  });
  $('who-q').addEventListener('blur', () => { $('who-results').hidden = true; });
  function resetWho() { tempNames = []; inSes = [S.shooters[0]]; S.shooter = S.shooters[0]; saveSettings(); saveWho(); $('who-q').value = ''; renderWho(); }

  // ---------- drills: targets + a string of steps + reps (Range only) ----------
  function norm(pr) {
    const p = Object.assign({ reps: pr.rounds || 1, reset: 5, start: 'ready', targets: [{ id: '1', dist: 7 }] }, pr);
    if (!p.steps) p.steps = [{ n: pr.shots || 1, t: '1' }];
    p.targets = p.targets.map((x) => ({ id: String(x.id), dist: x.dist })); p.steps = p.steps.map((x) => (x.reload ? { reload: true } : { n: x.n, t: String(x.t) }));
    p.shots = p.steps.reduce((a, x) => a + (x.n || 0), 0); return p;
  }
  const stepTxt = (p, long) => p.steps.map((x) => (x.reload ? 'reload' : long ? `${x.n} on T${x.t}` : `${x.n}×T${x.t}`)).join(' → ');
  function stepChips(p, heard, now) {
    let left = heard ?? 0, html = '';
    p.steps.forEach((x, i) => {
      if (i) html += '<span class="st-arrow">→</span>';
      if (x.reload) { html += '<span class="st-chip rl"><span class="mi mi-reload" aria-hidden="true"></span> reload</span>'; return; }
      const on = Math.max(0, Math.min(x.n, left)); left -= x.n;
      const cur = now && on < x.n && !html.includes(' now') ? ' now' : '';
      html += `<span class="st-chip${cur}"><i class="tg">T${x.t}</i><span class="dots">${Array.from({ length: x.n }, (_, k) => `<i${k < on ? ' class="on"' : ''}></i>`).join('')}</span></span>`;
    });
    return html;
  }
  const STD = [
    { name: 'Draw to first shot', par: 1.5, start: 'holster', steps: [{ n: 1, t: '1' }], reps: 5, reset: 5 },
    { name: 'Bill Drill', par: 2.5, start: 'holster', steps: [{ n: 6, t: '1' }], reps: 1 },
    { name: 'Mozambique', par: 2.0, start: 'low ready', steps: [{ n: 3, t: '1' }], reps: 3, reset: 6 },
    { name: 'Reload', par: 4.0, start: 'ready', steps: [{ n: 2, t: '1' }, { reload: true }, { n: 2, t: '1' }], reps: 3, reset: 8 },
    { name: 'Three-target transitions', par: 4.0, start: 'ready', targets: [{ id: '1', dist: 7 }, { id: '2', dist: 10 }, { id: '3', dist: 15 }], steps: [{ n: 2, t: '1' }, { n: 2, t: '2' }, { n: 2, t: '3' }], reps: 3, reset: 8 },
  ].map(norm);
  let MINE = loadJSON('st.drills', null);
  MINE = Array.isArray(MINE) ? MINE.map(norm) : [
    { name: 'Two-target doubles', par: 5.0, start: 'ready', targets: [{ id: '1', dist: 7 }, { id: '2', dist: 10 }], steps: [{ n: 2, t: '1' }, { n: 2, t: '2' }], reps: 5, reset: 6 },
  ].map(norm);
  const saveMine = () => saveJSON('st.drills', MINE);
  let selDrill = null, moreOpen = false;
  const runs = (pr) => history.filter((r) => r.drillName === pr.name).length;
  const chev = () => el('span', 'mi mi-chev hd-chev2');
  // a drill or free shooting starts the session if there isn't one yet (with the people picked on the card)
  function ensureSession(kind) {
    if (activeSession) return;
    for (const n of tempNames) if (!S.shooters.includes(n)) S.shooters.push(n); tempNames = []; saveSettings();
    startSession(kind || 'Range'); saveWho();
  }
  // no session yet: ask, so opening a drill to look around doesn't log a session
  async function askSession(kind) {
    if (activeSession) return;
    if (await askSheet('Start a session?', 'Runs are saved together in a session with its time. Not now: they are saved on their own.', 'Start session', 'Not now')) { ensureSession(kind); toast('Session started'); }
  }
  async function shoot(pr) { await askSession('Range'); enterDrill('range', null, pr || null); }
  async function shootDry(drill) { await askSession('Dry fire'); enterDrill('dry', drill); }
  function hubRow(pr) {
    const r = el('div', 'hd-row hd-go'); r.setAttribute('role', 'button'); r.tabIndex = 0;
    const txt = el('div', 'hd-txt'); txt.append(el('b', null, pr.name), el('small', null, `${pr.shots} shot${pr.shots === 1 ? '' : 's'} · ${pr.reps} rep${pr.reps === 1 ? '' : 's'} · par ${pr.par.toFixed(2)}`));
    const ed = el('button', 'hd-edit', 'Edit'); ed.onclick = (e) => { e.stopPropagation(); openEditor(pr); };
    r.append(txt, ed, chev()); r.onclick = () => shoot(pr);
    return r;
  }
  function renderHubDrills() {
    const box = $('hub-dlist'); box.innerHTML = '';
    const free = el('div', 'hd-row hd-go hd-free'); free.setAttribute('role', 'button'); free.tabIndex = 0;
    free.innerHTML = '<svg class="ic hd-ic" viewBox="0 0 24 24" aria-hidden="true"><circle cx="12" cy="12" r="8.5"/><circle cx="12" cy="12" r="4.5"/><circle cx="12" cy="12" r="0.8"/></svg>';
    const ft = el('div', 'hd-txt'); ft.append(el('b', null, 'Free shooting'), el('small', null, 'Beep, shoot, see splits. No par, no plan')); free.append(ft, chev());
    free.onclick = () => shoot(null); box.appendChild(free);
    const all = [...MINE, ...STD];
    const favs = all.slice().sort((x, y) => runs(y) - runs(x)).slice(0, 3), rest = all.filter((pr) => !favs.includes(pr));
    favs.forEach((pr) => box.appendChild(hubRow(pr)));
    const tog = el('div', 'hd-row hd-more' + (moreOpen ? ' open' : '')); tog.setAttribute('role', 'button');
    tog.append(el('span', 'hd-txt', `All drills (${rest.length})`), el('span', 'mi mi-down hd-chev')); tog.onclick = () => { moreOpen = !moreOpen; renderHubDrills(); };
    box.appendChild(tog);
    if (moreOpen) rest.forEach((pr) => { const r = hubRow(pr); r.classList.add('hd-sub'); box.appendChild(r); });
  }

  // ---------- Range screen: the session card ----------
  function sessionSummary() {
    const ses = sessions.find((x) => x.id === activeSession); if (!ses) return '';
    const recs = sessionRecs(ses.id), mins = Math.round((Date.now() - new Date(ses.start)) / 60000);
    return `${recs.length} ${recs.length === 1 ? 'run' : 'runs'} · ${mins >= 60 ? `${Math.floor(mins / 60)} h ${mins % 60} min` : `${mins} min`}`;
  }
  function renderHub() {
    const on = !!activeSession, ses = sessions.find((x) => x.id === activeSession);
    $('ses-card').classList.toggle('on', on); $('ses-btn').textContent = on ? 'End' : 'Start';
    $('ses-title').textContent = on && ses ? `Session · ${new Date(ses.start).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })}` : 'Session';
    $('ses-sum').textContent = on ? sessionSummary() : 'Starts when you pick a drill';
    renderWho(); renderHubDrills();
    const has = on && sessionRecs(activeSession).length; $('hub-log-h').hidden = !has; $('hub-log').hidden = !has;
    if (window.RUNS) RUNS.hubLog($('hub-log'));
    $('dry-ses-t').textContent = on && ses ? `Session · started ${new Date(ses.start).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })}` : 'Session';
    $('dry-ses-sum').textContent = on ? sessionSummary() : 'Starts when you pick a drill'; $('dry-end').hidden = !on;
    $('dry-sbar').querySelector('.dot').style.opacity = on ? 1 : .3;
  }
  // End is one tap from Shoot: ask first
  // End: a sheet with the session's bests. 'End and export' starts the share straight from the tap (iOS needs that).
  function askEnd() {
    const ses = sessions.find((x) => x.id === activeSession); if (!ses) return;
    const done = () => { resetWho(); renderHub(); };
    if (!sessionRecs(ses.id).length) { endSession(true); done(); return; }       // nothing shot: just end it
    const who = [...new Set(sessionRecs(ses.id).map((r) => r.shooter))].map(initials).join(', ');
    $('end-sum').textContent = `${sessionSummary()}${who ? ' · ' + who : ''}`;
    const L = $('end-list'); L.innerHTML = '';
    (window.RUNS ? RUNS.sessionGroups(ses.id) : []).slice(0, 4).forEach((g) => { const r = el('div', 'sheet-row'); r.append(el('span', null, g.name), el('i', null, g.best)); L.appendChild(r); });
    const D = $('end-sheet');
    $('btn-end-export').onclick = (e) => { e.preventDefault(); const id = ses.id; endSession(true); D.close(); done(); exportSession(id).then((r) => r === 'ok' && toast('Session exported')); };
    $('btn-end-only').onclick = (e) => { e.preventDefault(); endSession(true); D.close(); done(); toast('Session ended'); };
    D.showModal();
  }
  $('ses-btn').onclick = () => {
    if (activeSession) { askEnd(); return; }
    ensureSession(); toast('Session started'); renderHub();
  };
  $('dry-end').onclick = askEnd;
  $('hub-new').onclick = () => openEditor(null);

  // ---------- drill editor: describe it (voice or typing), then the fields ----------
  let ed = null, edTarget = null;
  function openEditor(pr) {
    edTarget = pr && MINE.includes(pr) ? pr : null;      // editing a standard drill saves your own copy
    ed = JSON.parse(JSON.stringify(norm(pr || { name: 'My drill', par: 5, start: 'ready', targets: [{ id: '1', dist: 7 }, { id: '2', dist: 10 }], steps: [{ n: 2, t: '1' }, { n: 2, t: '2' }], reps: 5, reset: 6 })));
    if (pr && !edTarget) ed.name = pr.name + ' (mine)';
    $('p-f-name').value = ed.name; $('p-ed-title').textContent = pr ? 'Edit drill' : 'New drill'; $('p-ed-del').hidden = !edTarget;
    $('vb-text').value = ''; $('vb-heard').textContent = pr ? 'Say what to change, or describe it again.' : 'Say it or type it. Press done when you finish.';
    renderEditor(); showScreen('editor');
    requestAnimationFrame(() => { const sc = P.querySelector('#view-editor .ed-scroll'); sc.style.scrollBehavior = 'auto'; sc.scrollTop = 0; sc.style.scrollBehavior = ''; });
  }
  function stepper(val, unit, on) {
    const w = el('div', 'p-step'), m = el('button', null, '–'), b = el('b', null, String(val)), pl = el('button', null, '+');
    m.onclick = () => on(-1); pl.onclick = () => on(1); w.append(m, b); if (unit) w.append(document.createTextNode(' ' + unit)); w.append(pl); return w;
  }
  function renderEditor() {
    ed.name = $('p-f-name').value;
    P.querySelectorAll('#p-f-start button').forEach((x) => x.classList.toggle('on', x.dataset.v === ed.start));
    $('p-f-par').textContent = ed.par.toFixed(2); $('p-f-reps').textContent = ed.reps; $('p-f-reset').textContent = ed.reset;
    const T2 = $('ed-targets'); T2.innerHTML = '';
    ed.targets.forEach((t) => {
      const r = el('div', 'ed-row'), lab = el('span', 'grow'); lab.innerHTML = `<i class="tg">T${t.id}</i>&nbsp; Target ${t.id}`;
      r.append(lab, stepper(t.dist, 'yd', (d) => { t.dist = Math.max(1, Math.min(100, t.dist + d)); renderEditor(); }));
      const x = el('button', 'ed-x'); x.innerHTML = '<span class="mi mi-x" aria-hidden="true"></span>'; x.setAttribute('aria-label', `Remove target ${t.id}`); x.style.visibility = ed.targets.length < 2 ? 'hidden' : '';
      x.onclick = () => { ed.targets = ed.targets.filter((q) => q !== t); ed.steps.forEach((q) => { if (q.t === t.id) q.t = ed.targets[0].id; }); renderEditor(); };
      r.appendChild(x); T2.appendChild(r);
    });
    if (ed.targets.length < 8) {
      const r = el('div', 'ed-row'), add = el('button', 'ed-addtg', '+ Add target');
      add.onclick = () => { let k = 1; while (ed.targets.some((q) => q.id === String(k))) k++; ed.targets.push({ id: String(k), dist: ed.targets[ed.targets.length - 1].dist }); renderEditor(); };
      r.appendChild(add); T2.appendChild(r);
    }
    const S2 = $('ed-steps'); S2.innerHTML = ''; let lastT = null, n = 0;
    ed.steps.forEach((x, i) => {
      if (!x.reload && lastT && x.t !== lastT) S2.appendChild(el('div', 'ed-row ed-tr', `↳ transition to T${x.t}`));
      const r = el('div', 'ed-row'); r.appendChild(el('span', 'n', String(++n)));
      if (x.reload) { const g = el('span', 'grow'); g.innerHTML = '<span class="mi mi-reload" aria-hidden="true"></span>' + ' Reload'; r.appendChild(g); }
      else {
        r.appendChild(stepper(x.n, '', (d) => { x.n = Math.max(1, Math.min(12, x.n + d)); renderEditor(); }));
        r.appendChild(el('span', 'grow', 'on'));
        const g = el('div', 'ed-tgs'); ed.targets.forEach((t) => { const b = el('button', t.id === x.t ? 'on' : null, 'T' + t.id); b.onclick = () => { x.t = t.id; renderEditor(); }; g.appendChild(b); }); r.appendChild(g);
        lastT = x.t;
      }
      const del = el('button', 'ed-x'); del.innerHTML = '<span class="mi mi-x" aria-hidden="true"></span>'; del.setAttribute('aria-label', 'Remove step'); del.style.visibility = ed.steps.filter((q) => !q.reload).length < 2 && !x.reload ? 'hidden' : '';
      del.onclick = () => { ed.steps.splice(i, 1); renderEditor(); }; r.appendChild(del); S2.appendChild(r);
    });
  }
  // speech -> text: the Web Speech API where the browser has it, else the keyboard's own dictation
  function micInto(btn, box, onText) {
    const SR = window.SpeechRecognition || window.webkitSpeechRecognition;
    btn.onclick = () => {
      if (!SR) { box.focus(); toast('Tap the mic key on your keyboard and speak'); return; }
      let r; try { r = new SR(); } catch { box.focus(); toast('Tap the mic key on your keyboard and speak'); return; }
      r.lang = 'en-US'; r.interimResults = true; r.continuous = false; btn.classList.add('on');
      r.onresult = (e) => { box.value = [...e.results].map((x) => x[0].transcript).join(' '); if (e.results[e.results.length - 1].isFinal) onText(); };
      r.onerror = () => { btn.classList.remove('on'); box.focus(); toast('Tap the mic key on your keyboard and speak'); };
      r.onend = () => btn.classList.remove('on');
      try { r.start(); } catch { btn.classList.remove('on'); box.focus(); }
    };
  }
  const toDetail = () => { const sc = P.querySelector('#view-editor .ed-scroll'); sc.scrollTo({ top: $('ed-detail').offsetTop - sc.offsetTop, behavior: 'smooth' }); };
  function buildFromVoice() {
    const txt = $('vb-text').value.trim(); if (!txt) { $('vb-text').focus(); return; }
    const { drill: v, heard } = VoiceParse.parseDrill(txt);
    if (v.name) { ed.name = v.name; $('p-f-name').value = v.name; }
    if (v.start) ed.start = v.start;
    if (v.steps.length) {
      ed.steps = v.steps;
      const ids = new Set([...v.steps.filter((x) => !x.reload).map((x) => x.t), ...Object.keys(v.targets)]);
      ed.targets = [...ids].sort((a, b) => a - b).map((id) => ({ id, dist: v.targets[id] ?? (ed.targets.find((q) => q.id === id) || {}).dist ?? 7 }));
    } else for (const [id, yd] of Object.entries(v.targets)) { const t = ed.targets.find((q) => q.id === id); if (t) t.dist = yd; else ed.targets.push({ id, dist: yd }); }
    if (v.reps) ed.reps = Math.min(20, v.reps); if (v.par) ed.par = v.par; if (v.reset) ed.reset = v.reset;
    $('vb-heard').innerHTML = heard.length ? 'Heard: ' + heard.map((h) => `<b>${esc(h)}</b>`).join(' · ') : 'Didn’t catch a drill in that. Try “2 shots on target 1, 5 reps under 4 seconds”.';
    renderEditor(); if (heard.length) setTimeout(toDetail, 450);
  }
  $('vb-text').addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); $('vb-text').blur(); buildFromVoice(); } });
  micInto($('vb-mic'), $('vb-text'), buildFromVoice);
  $('p-f-name').addEventListener('input', renderEditor);
  P.querySelectorAll('#p-f-start button').forEach((b) => b.onclick = () => { ed.start = b.dataset.v; renderEditor(); });
  $('ed-add-shots').onclick = () => { const last = [...ed.steps].reverse().find((q) => !q.reload); const nx = ed.targets[(ed.targets.findIndex((t) => t.id === (last || {}).t) + 1) % ed.targets.length].id; ed.steps.push({ n: 2, t: nx }); renderEditor(); };
  $('ed-add-reload').onclick = () => { ed.steps.push({ reload: true }); renderEditor(); };
  const LIM = { par: [0.5, 60, 2], reps: [1, 20, 0], reset: [2, 30, 0] };
  P.querySelectorAll('#view-editor [data-f]').forEach((b) => b.onclick = () => { const f = b.dataset.f, [lo, hi, dp] = LIM[f]; ed[f] = Math.max(lo, Math.min(hi, +(ed[f] + +b.dataset.d).toFixed(dp))); renderEditor(); });
  $('p-ed-cancel').onclick = () => showScreen('range');
  $('p-save').onclick = () => {
    ed.name = ($('p-f-name').value || '').trim() || 'My drill';
    const clean = norm(ed); let saved;
    if (edTarget) { Object.keys(edTarget).forEach((k) => delete edTarget[k]); Object.assign(edTarget, clean); saved = edTarget; } else { saved = clean; MINE.push(saved); }
    saveMine(); toast(`Saved “${ed.name}”`); showScreen('range');
  };
  $('p-ed-del').onclick = () => { MINE = MINE.filter((x) => x !== edTarget); saveMine(); toast('Deleted'); showScreen('range'); };

  // ---------- timer: plan strip for a drill, the arc gauge ----------
  function renderPlan(heard) {
    const p = T.preset; $('p-plan').hidden = !p; if (!p) return;
    const rr = T.drillRes || [], done = rr.length >= p.reps, cur = Math.min(rr.length, p.reps - 1);
    $('pl-round').textContent = done ? `${rr.filter((x) => x.ok).length} of ${p.reps} under par` : `Rep ${rr.length + 1} of ${p.reps}`;
    $('pl-do').textContent = done ? 'Drill complete' : `${p.shots} shots · under ${p.par.toFixed(2)} s`;
    $('pl-steps').innerHTML = stepChips(p, done ? 0 : (heard ?? (T.state === 'live' ? liveShots().length : 0)), !done);
    const d = $('pl-dots'); d.innerHTML = '';
    for (let i = 0; i < p.reps; i++) { const x = el('i'), r = rr[i]; x.className = r ? (r.ok ? 'ok' : 'over') : i === cur && !done ? 'cur' : ''; d.appendChild(x); }
  }
  const G = $('p-gauge'), NT = 44; let pm = null;
  for (let i = 0; i <= NT; i++) {
    const a = Math.PI * (1 - i / NT), r1 = i % 11 === 0 ? 74 : 79, r2 = 88, l = document.createElementNS('http://www.w3.org/2000/svg', 'line');
    l.setAttribute('x1', 100 + r1 * Math.cos(a)); l.setAttribute('y1', 96 - r1 * Math.sin(a)); l.setAttribute('x2', 100 + r2 * Math.cos(a)); l.setAttribute('y2', 96 - r2 * Math.sin(a));
    l.setAttribute('stroke-width', i % 11 === 0 ? 2.2 : 1.4); l.setAttribute('stroke-linecap', 'round'); G.appendChild(l);
  }
  pm = document.createElementNS('http://www.w3.org/2000/svg', 'line'); pm.setAttribute('stroke-width', 3); pm.setAttribute('stroke-linecap', 'round'); G.appendChild(pm);
  function gauge(t) {
    const on = Math.min(NT, Math.round(t / 5 * NT)), cs = getComputedStyle(P), ok = cs.getPropertyValue('--p-ok'), mu = cs.getPropertyValue('--p-muted');
    [...G.children].slice(0, NT + 1).forEach((l, i) => { l.setAttribute('stroke', i <= on && t > 0 ? ok : mu); l.setAttribute('opacity', i <= on && t > 0 ? 1 : .35); });
  }
  function parMark(par) {
    if (!par) { pm.setAttribute('opacity', 0); return; }
    const a = Math.PI * (1 - Math.min(par, 5) / 5); pm.setAttribute('opacity', 1); pm.setAttribute('stroke', getComputedStyle(P).getPropertyValue('--p-text'));
    pm.setAttribute('x1', 100 + 66 * Math.cos(a)); pm.setAttribute('y1', 96 - 66 * Math.sin(a)); pm.setAttribute('x2', 100 + 92 * Math.cos(a)); pm.setAttribute('y2', 96 - 92 * Math.sin(a));
  }

  // ---------- score by voice: "2 alpha on target 1, 1 bravo 1 alpha on target 2" ----------
  let scoring = null;
  function openScore() {
    const rec = history.find((r) => r.id === T.saved) || history.find((r) => r.mode !== 'dry');
    if (!rec || rec.mode === 'dry') { toast('Shoot a string first, then score it'); return; }
    const expect = {};
    if (T.preset && rec.drillName === T.preset.name) T.preset.steps.forEach((x) => { if (!x.reload) expect[x.t] = (expect[x.t] || 0) + x.n; });
    else expect[1] = recShots(rec).length;
    scoring = { rec, expect };
    $('sc-title').textContent = rec.drillName ? `Score rep ${rec.rep || ''}` : 'Score string';
    $('sc-text').value = ''; $('sc-table').innerHTML = ''; $('p-score').hidden = false;
  }
  function scoreFromVoice() {
    const txt = $('sc-text').value.trim(); if (!txt) { $('sc-text').focus(); return; }
    const { hits } = VoiceParse.parseScore(txt, scoring.expect), { points, count } = VoiceParse.points(hits);
    const time = recShots(scoring.rec).slice(-1)[0], shots = Object.values(scoring.expect).reduce((a, b) => a + b, 0), hf = time ? Math.max(0, points) / time : null;
    const ids = [...new Set([...Object.keys(scoring.expect), ...Object.keys(hits)])].sort((a, b) => a - b), Z = ['A', 'B', 'C', 'D', 'M', 'NS'];
    let h = `<div class="sc-row h"><b></b>${Z.map((z) => `<span>${z === 'M' ? 'Miss' : z}</span>`).join('')}</div>`;
    ids.forEach((id) => { const r = hits[id] || {}; h += `<div class="sc-row"><b>T${id}</b>${Z.map((z) => `<span>${r[z] || '·'}</span>`).join('')}</div>`; });
    h += `<div class="sc-sum"><span>${count} scored${shots ? ` of ${shots} shots` : ''} · ${points} pts</span><b>${hf != null ? 'HF ' + hf.toFixed(2) : ''}</b></div>`;
    if (shots && count !== shots) h += `<div class="sc-warn">${count < shots ? shots - count + ' shot(s) not scored yet' : count - shots + ' more hits than shots: check the targets'}</div>`;
    $('sc-table').innerHTML = h;
    scoring.rec.score = { hits, points, count, hf: hf != null ? +hf.toFixed(3) : null, said: txt }; saveHistory();
    $('sc-heard').textContent = 'Saved with this string. Say it again to correct it.';
  }
  $('sc-go').onclick = scoreFromVoice; micInto($('sc-mic'), $('sc-text'), scoreFromVoice);
  $('sc-close').onclick = () => { $('p-score').hidden = true; };

  // ---------- home: the year in dots, drills, best first shot ----------
  let hsel = null;
  function renderHome() {
    const now = new Date(), Y = now.getFullYear(), today = new Date(Y, now.getMonth(), now.getDate());
    const byDay = {};
    for (const r of history) { const d = new Date(r.at); if (d.getFullYear() !== Y) continue; const k = d.toDateString(); const e = byDay[k] || (byDay[k] = { k: 0, n: 0, best: null });
      e.k = Math.max(e.k, r.mode === 'dry' ? 1 : 2); e.n++; const v = recShots(r)[0]; if (v != null && (e.best == null || v < e.best)) e.best = v; }
    const grid = $('hy-grid'); grid.innerHTML = ''; let rangeN = 0, dryN = 0;
    'JFMAMJJASOND'.split('').forEach((mn, m) => {
      const box = el('div', 'hy-month' + (m === now.getMonth() ? ' now' : '')); box.appendChild(el('span', null, mn));
      const g = el('div', 'hy-days');
      for (let day = 1; day <= new Date(Y, m + 1, 0).getDate(); day++) {
        const d = new Date(Y, m, day), e = byDay[d.toDateString()], k = e ? e.k : 0, future = d > today, b = el('button');
        if (!future) { if (k === 2) rangeN++; else if (k === 1) dryN++; }
        b.className = (hsel === d.toDateString() ? 'sel' : '') + (d.getTime() === today.getTime() ? ' today' : '');
        b.setAttribute('aria-label', `${d.toLocaleDateString([], { month: 'short', day: 'numeric' })}: ${['no training', 'dry fire', 'range'][k]}`);
        b.innerHTML = `<span class="hy-dot${k === 1 ? ' dry' : k === 2 ? ' range' : ''}${future ? ' future' : ''}"></span>`;
        if (!future) b.onclick = () => { hsel = hsel === d.toDateString() ? null : d.toDateString(); renderHome(); };
        g.appendChild(b);
      }
      box.appendChild(g); grid.appendChild(box);
    });
    $('hy-year').textContent = Y;
    if (hsel == null) $('h-day').textContent = `${rangeN} Range · ${dryN} Dry fire`;
    else { const e = byDay[hsel], when = new Date(hsel).toLocaleDateString([], { weekday: 'short', month: 'short', day: 'numeric' });
      $('h-day').textContent = e ? `${when} · ${e.k === 2 ? 'Range' : 'Dry fire'} · ${e.n} ${e.n === 1 ? 'string' : 'strings/reps'}${e.best != null ? ` · best ${e.best.toFixed(2)}` : ''}` : `${when} · rest day`; }
    const car = $('h-car'); car.innerHTML = '';
    [...MINE, ...STD].forEach((pr) => { const c = el('button', 'h-card'); c.append(el('b', null, pr.name), el('small', null, `${pr.shots} shot${pr.shots === 1 ? '' : 's'} · par ${pr.par.toFixed(2)}`)); c.onclick = () => shoot(pr); car.appendChild(c); });
    const live = history.filter((r) => r.mode !== 'dry' && recShots(r).length).map((r) => ({ t: recShots(r)[0], at: r.at }));
    const best = live.sort((a, b) => a.t - b.t)[0];
    $('h-prtxt').textContent = best ? `${best.t.toFixed(3)} s` : 'Shoot a string to set one';
    $('h-prwhen').textContent = best ? new Date(best.at).toLocaleDateString([], { month: 'short', day: 'numeric' }) : '';
    $('h-ses').hidden = !activeSession; $('h-ses-sum').textContent = sessionSummary();
  }
  P.querySelectorAll('[data-go]').forEach((b) => b.onclick = () => showScreen(b.dataset.go === 'dry' ? 'drymenu' : 'range'));
  $('h-ses').onclick = () => { const ses = sessions.find((x) => x.id === activeSession); showScreen(ses && /^Dry/.test(ses.name) ? 'drymenu' : 'range'); };
  $('h-seeall').onclick = () => showScreen('history');
  $('h-pr').onclick = () => showScreen('history');

  // ---------- settings: style ----------
  const sk = $('set-skin'); sk.value = S.skin || 'softdark'; sk.onchange = () => applySkin(sk.value);

  // ---------- hooks for app.js ----------
  function onScreen(v) {
    if (v === 'home') { if (!activeSession) resetWho(); renderHome(); }
    if (v === 'range' || v === 'drymenu') renderHub();
    if (v === 'timer') { renderPlan(); if (window.RUNS) RUNS.refresh(); }
  }
  const allDrills = () => [...MINE, ...STD];
  window.UI = { renderPlan, gauge, parMark, openScore, nextShooter, renderHub, onScreen, renderHome, allDrills, shoot, shootDry, initials };
  if (!S.skinSet081) { S.skin = 'softdark'; S.skinSet081 = 1; }   // v0.8.1: Soft dark becomes the look, once; Settings › Look still changes it
  applySkin(S.skin || 'softdark'); renderWho(); onScreen(screen);
})();
