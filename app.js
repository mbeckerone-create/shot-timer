/* Shot Timer — app logic. Timing lives in the AudioWorklet (worklet.js + detector.js);
 * this file runs the UI, the start/par beeps, and history. */
'use strict';
const BUILD = 'v0.1.0';
const $ = (id) => document.getElementById(id);
const fmt = (t) => (t == null || !isFinite(t)) ? '—' : t.toFixed(3);

// ---------- settings & storage ----------
const DEFAULT_SETTINGS = {
  dmin: 2, dmax: 5, hz: 2400, blen: 300, par: 0,
  sens: 5, echo: 180, lock: 100, auto: 4,
  shooters: ['Me'], guns: ['Pistol'], shooter: 'Me', gun: 'Pistol',
};
const store = {
  get(k, d) { try { const v = localStorage.getItem(k); return v ? JSON.parse(v) : d; } catch { return d; } },
  set(k, v) { try { localStorage.setItem(k, JSON.stringify(v)); } catch {} },
};
let S = Object.assign({}, DEFAULT_SETTINGS, store.get('st.settings', {}));
if (!S.shooters.includes(S.shooter)) S.shooter = S.shooters[0] || '';
if (!S.guns.includes(S.gun)) S.gun = S.guns[0] || '';
let history = store.get('st.history', []);
const saveSettings = () => store.set('st.settings', S);
const saveHistory = () => store.set('st.history', history);

function detParams() {
  return { shotDb: ShotDetector.sensitivityToDb(S.sens), echoMs: S.echo, lockMs: S.lock };
}

// ---------- audio engine ----------
const audio = { ctx: null, node: null, stream: null, sr: 48000, ready: null, gain: null };

async function ensureAudio() {
  if (audio.ready) return audio.ready;
  audio.ready = (async () => {
    if (navigator.audioSession) { try { navigator.audioSession.type = 'play-and-record'; } catch {} }
    const ctx = new (window.AudioContext || window.webkitAudioContext)({ latencyHint: 'interactive' });
    audio.ctx = ctx;
    const stream = await navigator.mediaDevices.getUserMedia({
      audio: { echoCancellation: false, noiseSuppression: false, autoGainControl: false, channelCount: 1 },
    });
    audio.stream = stream;
    await ctx.audioWorklet.addModule('detector.js');
    await ctx.audioWorklet.addModule('worklet.js');
    const src = ctx.createMediaStreamSource(stream);
    const node = new AudioWorkletNode(ctx, 'shot-timer', { numberOfInputs: 1, numberOfOutputs: 1, outputChannelCount: [1] });
    const mute = ctx.createGain(); mute.gain.value = 0;     // keep the graph pulling without echoing the mic
    src.connect(node); node.connect(mute); mute.connect(ctx.destination);
    audio.gain = ctx.createGain(); audio.gain.gain.value = 1; audio.gain.connect(ctx.destination);
    audio.node = node; audio.sr = ctx.sampleRate;
    node.port.onmessage = (e) => onWorklet(e.data);
    node.port.postMessage({ type: 'params', params: detParams() });
    node.port.postMessage({ type: 'disarm' });
    if (ctx.state !== 'running') await ctx.resume();
    return true;
  })();
  try { return await audio.ready; } catch (e) { audio.ready = null; throw e; }
}

function latencyEstimate() {
  const c = audio.ctx; let lat = (c.outputLatency || 0) + (c.baseLatency || 0);
  try { const s = audio.stream.getAudioTracks()[0].getSettings(); if (s.latency) lat += s.latency; } catch {}
  return lat;
}

function scheduleBeep(at, ms) {
  const c = audio.ctx, o = c.createOscillator(), g = c.createGain();
  o.type = 'sine'; o.frequency.value = S.hz;
  const d = ms / 1000;
  g.gain.setValueAtTime(0, at); g.gain.linearRampToValueAtTime(0.9, at + 0.003);
  g.gain.setValueAtTime(0.9, at + d - 0.01); g.gain.linearRampToValueAtTime(0, at + d);
  o.connect(g); g.connect(audio.gain); o.start(at); o.stop(at + d + 0.02);
  return o;
}

// ---------- timer state machine ----------
// idle -> standby (waiting for random beep) -> live (listening) -> done (review)
const T = { state: 'idle', beepFrame: null, acoustic: false, shots: [], oscs: [], lastActivity: 0, delay: 0, autoTimer: null, wakeLock: null };

async function onMain() {
  if (T.state === 'idle' || T.state === 'done') return start();
  if (T.state === 'standby') return cancel();
  if (T.state === 'live') return stop();
}

async function start() {
  try { await ensureAudio(); } catch (e) {
    setStatus('Mic blocked', 'err');
    $('beepinfo').textContent = 'Allow microphone access (Settings › Safari › Microphone), and open over https.';
    return;
  }
  if (audio.ctx.state !== 'running') await audio.ctx.resume();
  if (T.state === 'done' && T.shots.length && !T.saved) autoSaveIfNeeded();
  T.shots = []; T.beepFrame = null; T.saved = false; renderShots(); renderStats();
  const lo = Math.min(S.dmin, S.dmax), hi = Math.max(S.dmin, S.dmax);
  T.delay = lo + Math.random() * (hi - lo);
  const beepAt = audio.ctx.currentTime + Math.max(0.15, T.delay);
  T.oscs = [scheduleBeep(beepAt, S.blen)];
  const parAt = [];
  if (S.par > 0) { parAt.push(beepAt + S.par); T.oscs.push(scheduleBeep(beepAt + S.par, S.blen)); }
  audio.node.port.postMessage({ type: 'params', params: detParams() });
  audio.node.port.postMessage({ type: 'arm', beepAt, parAt, beepMs: S.blen, beepHz: S.hz, latency: latencyEstimate() });
  T.state = 'standby'; setStatus('Standby', 'standby'); $('big').textContent = '0.000';
  $('beepinfo').textContent = '';
  setMain('CANCEL', 'standby'); $('btn-review').disabled = true;
  requestWake();
}

function cancel() {
  for (const o of T.oscs) { try { o.stop(); } catch {} }
  audio.node.port.postMessage({ type: 'disarm' });
  T.state = 'idle'; setStatus('Ready'); setMain('START'); releaseWake();
}

function stop() {
  audio.node.port.postMessage({ type: 'disarm' });
  for (const o of T.oscs) { try { o.stop(); } catch {} }
  clearInterval(T.autoTimer);
  T.state = 'done'; setStatus(T.shots.length ? 'String done' : 'No shots heard');
  setMain('START'); $('btn-review').disabled = !T.shots.length; $('btn-review').textContent = 'Save';
  releaseWake();
  autoSaveIfNeeded();
}

function onWorklet(m) {
  if (m.type === 'level') return drawMeter(m.db);
  if (m.type === 'beep' && T.state === 'standby') {
    T.beepFrame = m.frame; T.acoustic = m.acoustic; T.state = 'live'; T.lastActivity = performance.now();
    setStatus('Shooter ready… go', 'live'); setMain('STOP', 'stop');
    const off = ((m.frame - m.expected) / audio.sr * 1000).toFixed(0);
    $('beepinfo').textContent = m.acoustic ? `Start beep heard by mic (latency ${off} ms, removed)` : 'Beep not heard by mic — using estimated timing';
    clearInterval(T.autoTimer);
    T.autoTimer = setInterval(() => {
      if (T.state !== 'live') return clearInterval(T.autoTimer);
      const quiet = (performance.now() - T.lastActivity) / 1000;
      const lim = S.auto > 0 ? S.auto : 120;
      if (quiet > lim && (T.shots.length || quiet > 30)) stop();
    }, 250);
    return;
  }
  if (m.type === 'shot' && T.state === 'live' && T.beepFrame != null && m.frame > T.beepFrame) {
    T.shots.push({ t: (m.frame - T.beepFrame) / audio.sr, db: m.peakDb, removed: false });
    T.lastActivity = performance.now();
    renderShots(); renderStats();
  }
}

// ---------- rendering ----------
function setStatus(txt, cls) { const s = $('status'); s.textContent = txt; s.className = 'status' + (cls ? ' ' + cls : ''); }
function setMain(txt, cls) { const b = $('btn-main'); b.textContent = txt; b.className = 'btn primary big-btn' + (cls ? ' ' + cls : ''); }

function liveShots() { return T.shots.filter((s) => !s.removed).map((s) => s.t); }
function summarize(ts) {
  const splits = ts.slice(1).map((t, i) => t - ts[i]);
  return {
    count: ts.length, first: ts[0], total: ts[ts.length - 1], splits,
    avg: splits.length ? splits.reduce((a, b) => a + b, 0) / splits.length : null,
    best: splits.length ? Math.min(...splits) : null,
  };
}
function renderStats() {
  const s = summarize(liveShots());
  $('big').textContent = s.count ? fmt(s.total) : '0.000';
  $('s-count').textContent = s.count; $('s-first').textContent = fmt(s.first);
  $('s-split').textContent = fmt(s.splits[s.splits.length - 1]); $('s-avg').textContent = fmt(s.avg);
}
function renderShots() {
  const ol = $('shotlist'); ol.innerHTML = '';
  if (!T.shots.length) return;
  const head = document.createElement('li'); head.className = 'head';
  head.innerHTML = '<span>#</span><span>Time</span><span class="sp">Split</span><span></span>'; ol.appendChild(head);
  let prev = null, n = 0;
  T.shots.forEach((s, i) => {
    const li = document.createElement('li'); if (s.removed) li.className = 'removed';
    const split = !s.removed && prev != null ? s.t - prev : null;
    if (!s.removed) { n++; prev = s.t; }
    li.innerHTML = `<span class="n">${s.removed ? '' : n}</span><span class="t">${fmt(s.t)}</span><span class="sp">${s.removed ? '' : (n === 1 ? 'draw' : fmt(split))}</span>`;
    const x = document.createElement('button'); x.className = 'x'; x.textContent = s.removed ? '↺' : '×';
    x.title = s.removed ? 'Restore shot' : 'Not a shot — remove';
    x.onclick = () => { s.removed = !s.removed; renderShots(); renderStats(); if (T.saved) updateSaved(); };
    li.appendChild(x); ol.prepend(li);
  });
  ol.prepend(head);
}
let meterMax = -10, meterMin = -70;
function drawMeter(db) {
  const pct = (v) => Math.max(0, Math.min(100, (v - meterMin) / (meterMax - meterMin) * 100));
  const f = $('meter-fill'); f.style.width = pct(db) + '%';
  const thr = ShotDetector.sensitivityToDb(S.sens);
  f.classList.toggle('hot', db > thr); $('meter-thr').style.left = pct(thr) + '%';
}

// ---------- history ----------
function autoSaveIfNeeded() {
  if (T.saved || !liveShots().length) return;
  const rec = {
    id: Date.now().toString(36), at: new Date().toISOString(), shooter: S.shooter, gun: S.gun,
    delay: +T.delay.toFixed(2), par: S.par || null, acoustic: T.acoustic, sens: S.sens,
    shots: T.shots.map((s) => ({ t: +s.t.toFixed(4), removed: s.removed || undefined })),
  };
  history.unshift(rec); saveHistory(); T.saved = rec.id;
  $('btn-review').textContent = 'Saved ✓'; $('btn-review').disabled = true; renderHistory();
}
function updateSaved() {
  const r = history.find((h) => h.id === T.saved); if (!r) return;
  r.shots = T.shots.map((s) => ({ t: +s.t.toFixed(4), removed: s.removed || undefined })); saveHistory(); renderHistory();
}
function recShots(r) { return r.shots.filter((s) => !s.removed).map((s) => s.t); }

function renderHistory() {
  const el = $('history'); el.innerHTML = '';
  if (!history.length) { el.innerHTML = '<div class="empty">No strings yet. Shoot one on the Timer tab.</div>'; $('hist-summary').innerHTML = ''; return; }
  // summary across everything for the current shooter
  const mine = history.filter((h) => h.shooter === S.shooter).map((h) => summarize(recShots(h))).filter((s) => s.count);
  const best = (a) => a.length ? Math.min(...a) : null;
  $('hist-summary').innerHTML =
    `<div><span class="k">${esc(S.shooter)} · strings</span><span class="v">${mine.length}</span></div>` +
    `<div><span class="k">Best first shot</span><span class="v">${fmt(best(mine.map((s) => s.first)))}</span></div>` +
    `<div><span class="k">Best split</span><span class="v">${fmt(best(mine.map((s) => s.best).filter((x) => x != null)))}</span></div>`;
  let day = '';
  for (const r of history) {
    const d = new Date(r.at), ds = d.toLocaleDateString(undefined, { weekday: 'short', month: 'short', day: 'numeric' });
    if (ds !== day) { day = ds; const h = document.createElement('div'); h.className = 'day'; h.textContent = ds; el.appendChild(h); }
    const s = summarize(recShots(r));
    const c = document.createElement('div'); c.className = 'card';
    c.innerHTML = `<div class="top"><span class="who">${esc(r.shooter)} · ${esc(r.gun)}</span><span class="when">${d.toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' })}</span></div>
      <div class="nums"><div><span class="k">Shots</span><span class="v">${s.count}</span></div><div><span class="k">First</span><span class="v">${fmt(s.first)}</span></div>
      <div><span class="k">Avg split</span><span class="v">${fmt(s.avg)}</span></div><div><span class="k">Total</span><span class="v">${fmt(s.total)}</span></div></div>
      <div class="detail">${recShots(r).map((t, i, a) => `${String(i + 1).padStart(2)}  ${fmt(t)}  ${i ? '+' + fmt(t - a[i - 1]) : 'draw'}`).join('<br>')}
      ${r.par ? `<br>par ${r.par}s` : ''}${r.acoustic === false ? '<br>beep timing estimated' : ''}<br><button class="del">Delete string</button></div>`;
    c.onclick = (e) => {
      if (e.target.classList.contains('del')) { if (confirm('Delete this string?')) { history = history.filter((h) => h !== r); saveHistory(); renderHistory(); } return; }
      c.classList.toggle('open');
    };
    el.appendChild(c);
  }
}
function esc(s) { return String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c])); }

function exportCsv() {
  const rows = [['date', 'shooter', 'gun', 'shot', 'time_s', 'split_s', 'par_s', 'delay_s']];
  for (const r of history.slice().reverse()) recShots(r).forEach((t, i, a) => rows.push([r.at, r.shooter, r.gun, i + 1, t.toFixed(4), i ? (t - a[i - 1]).toFixed(4) : '', r.par || '', r.delay]));
  const csv = rows.map((r) => r.map((v) => /[",\n]/.test(String(v)) ? `"${String(v).replace(/"/g, '""')}"` : v).join(',')).join('\n');
  const blob = new Blob([csv], { type: 'text/csv' }), url = URL.createObjectURL(blob);
  const a = document.createElement('a'); a.href = url; a.download = `shot-timer-${new Date().toISOString().slice(0, 10)}.csv`; a.click();
  setTimeout(() => URL.revokeObjectURL(url), 5000);
}

// ---------- shooter / gun pickers ----------
function pick(title, options, current, cb) {
  const dlg = $('picker'); $('picker-title').textContent = title; const list = $('picker-list'); list.innerHTML = '';
  for (const o of options) {
    const b = document.createElement('button'); b.className = 'btn' + (o === current ? ' primary' : ''); b.textContent = o; b.value = o;
    b.onclick = (e) => { e.preventDefault(); cb(o); dlg.close(); }; list.appendChild(b);
  }
  dlg.showModal();
}
function renderChips() { $('lbl-shooter').textContent = S.shooter || '—'; $('lbl-gun').textContent = S.gun || '—'; }

// ---------- settings form ----------
const NUMS = { 'set-dmin': 'dmin', 'set-dmax': 'dmax', 'set-hz': 'hz', 'set-blen': 'blen', 'set-par': 'par', 'set-echo': 'echo', 'set-lock': 'lock', 'set-auto': 'auto', 'set-sens': 'sens' };
function bindSettings() {
  for (const [id, k] of Object.entries(NUMS)) {
    const el = $(id); el.value = S[k];
    el.addEventListener('input', () => {
      const v = parseFloat(el.value); if (!isFinite(v)) return; S[k] = v; saveSettings();
      if (k === 'sens') $('lbl-sens').textContent = v;
      if (audio.node) audio.node.port.postMessage({ type: 'params', params: detParams() });
    });
  }
  $('lbl-sens').textContent = S.sens;
  const lines = (el) => el.value.split('\n').map((s) => s.trim()).filter(Boolean);
  $('set-shooters').value = S.shooters.join('\n'); $('set-guns').value = S.guns.join('\n');
  $('set-shooters').addEventListener('change', (e) => { S.shooters = lines(e.target); if (!S.shooters.includes(S.shooter)) S.shooter = S.shooters[0] || ''; saveSettings(); renderChips(); });
  $('set-guns').addEventListener('change', (e) => { S.guns = lines(e.target); if (!S.guns.includes(S.gun)) S.gun = S.guns[0] || ''; saveSettings(); renderChips(); });
  $('btn-clear').onclick = () => { if (confirm('Delete ALL saved strings? This cannot be undone.')) { history = []; saveHistory(); renderHistory(); } };
  $('file-test').addEventListener('change', analyzeFile);
  $('build').textContent = `Build ${BUILD}`;
}

async function analyzeFile(e) {
  const f = e.target.files[0]; if (!f) return; const out = $('file-result'); out.textContent = 'Decoding…';
  try {
    const buf = await f.arrayBuffer();
    const ac = new (window.OfflineAudioContext || window.webkitOfflineAudioContext)(1, 1, 48000);
    const ab = await ac.decodeAudioData(buf);
    const x = ab.getChannelData(0), d = new ShotDetector(ab.sampleRate, detParams());
    for (let i = 0; i < x.length; i += 4096) d.process(x.subarray(i, i + 4096));
    const ts = d.shots.map((s) => s.frame / ab.sampleRate);
    out.textContent = `${ts.length} shots in ${ab.duration.toFixed(1)} s (sensitivity ${S.sens})\n` +
      ts.map((t, i) => `${String(i + 1).padStart(3)}  @${t.toFixed(3)}s  ${i ? 'split ' + (t - ts[i - 1]).toFixed(3) : ''}`).join('\n');
  } catch (err) { out.textContent = 'Could not read that file: ' + err.message; }
}

// ---------- wake lock, tabs, boot ----------
async function requestWake() { try { T.wakeLock = await navigator.wakeLock?.request('screen'); } catch {} }
function releaseWake() { try { T.wakeLock?.release(); } catch {} T.wakeLock = null; }

function showView(v) {
  document.querySelectorAll('.view').forEach((el) => el.classList.toggle('active', el.id === 'view-' + v));
  document.querySelectorAll('.tab').forEach((el) => el.classList.toggle('active', el.dataset.view === v));
  if (v === 'history') renderHistory();
}

document.addEventListener('DOMContentLoaded', () => {
  $('btn-main').onclick = onMain;
  $('btn-review').onclick = autoSaveIfNeeded;
  $('btn-export').onclick = exportCsv;
  $('chip-shooter').onclick = () => pick('Shooter', S.shooters, S.shooter, (v) => { S.shooter = v; saveSettings(); renderChips(); });
  $('chip-gun').onclick = () => pick('Gun', S.guns, S.gun, (v) => { S.gun = v; saveSettings(); renderChips(); });
  document.querySelectorAll('.tab').forEach((b) => b.onclick = () => showView(b.dataset.view));
  bindSettings(); renderChips(); renderStats(); renderHistory(); drawMeter(-120);
  document.addEventListener('visibilitychange', () => { if (!document.hidden && audio.ctx && audio.ctx.state !== 'running') audio.ctx.resume(); });
  if ('serviceWorker' in navigator && location.protocol === 'https:') navigator.serviceWorker.register('sw.js').catch(() => {});
});
