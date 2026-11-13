/* Shot Timer — app logic. Timing lives in the AudioWorklet (worklet.js + detector.js);
 * this file runs the UI, the start/par beeps, and history. */
'use strict';
const BUILD = 'v0.1.2';
const $ = (id) => document.getElementById(id);
const fmt = (t) => (t == null || !isFinite(t)) ? '—' : t.toFixed(3);

// ---------- settings & storage ----------
const DEFAULT_SETTINGS = {
  dmin: 2, dmax: 5, hz: 2400, blen: 300, par: 0,
  sens: 5, echo: 180, lock: 100, auto: 4,
  audioMode: 'play-and-record',
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
    if (navigator.audioSession && S.audioMode !== 'default') { try { navigator.audioSession.type = S.audioMode; } catch {} }
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
const T = { state: 'idle', beepAt: 0, pending: [], raf: 0, beepFrame: null, acoustic: false, shots: [], oscs: [], lastActivity: 0, delay: 0, autoTimer: null, wakeLock: null };

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
  T.shots = []; T.pending = []; T.beepFrame = null; T.saved = false; renderShots(); renderStats();
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
  T.beepAt = beepAt; cancelAnimationFrame(T.raf); T.raf = requestAnimationFrame(tick);
  requestWake();
}

// Drives the screen off the audio clock: flips to GO the instant the beep sounds, then runs the clock.
function tick() {
  const c = audio.ctx; if (!c) return;
  const now = c.currentTime - (c.outputLatency || 0);      // time the speaker is actually playing
  if (T.state === 'standby' && now >= T.beepAt) goLive();
  if (T.state === 'live') {
    if (!liveShots().length) $('big').textContent = Math.max(0, now - T.beepAt).toFixed(2) + '0';
  }
  if (T.state === 'standby' || T.state === 'live') T.raf = requestAnimationFrame(tick);
}

function goLive() {
  T.state = 'live'; T.lastActivity = performance.now();
  setStatus('GO', 'live'); setMain('STOP', 'stop');
  clearInterval(T.autoTimer);
  T.autoTimer = setInterval(() => {
    if (T.state !== 'live') return clearInterval(T.autoTimer);
    const quiet = (performance.now() - T.lastActivity) / 1000;
    const lim = S.auto > 0 ? S.auto : 120;
    if (quiet > lim && (T.shots.length || quiet > 30)) stop();
  }, 250);
}

function addShot(frame, db) {
  if (frame <= T.beepFrame) return;
  T.shots.push({ t: (frame - T.beepFrame) / audio.sr, db, removed: false });
  T.shots.sort((a, b) => a.t - b.t);
  T.lastActivity = performance.now(); renderShots(); renderStats();
}

function cancel() {
  for (const o of T.oscs) { try { o.stop(); } catch {} }
  audio.node.port.postMessage({ type: 'disarm' });
  cancelAnimationFrame(T.raf); $('big').textContent = '0.000';
  T.state = 'idle'; setStatus('Ready'); setMain('START'); releaseWake();
}

function stop() {
  audio.node.port.postMessage({ type: 'disarm' });
  for (const o of T.oscs) { try { o.stop(); } catch {} }
  clearInterval(T.autoTimer); cancelAnimationFrame(T.raf);
  T.state = 'done'; renderStats(); setStatus(T.shots.length ? 'String done' : 'No shots heard');
  setMain('START'); $('btn-review').disabled = !T.shots.length; $('btn-review').textContent = 'Save';
  releaseWake();
  autoSaveIfNeeded();
}

function onWorklet(m) {
  if (m.type === 'level') return drawMeter(m.db);
  if (m.type === 'beepdiag') return onBeepDiag(m);
  if (m.type === 'beep' && (T.state === 'standby' || T.state === 'live') && T.beepFrame == null) {
    // The worklet located the beep in the mic stream: that is t=0 for every shot.
    T.beepFrame = m.frame; T.acoustic = m.acoustic;
    const off = ((m.frame - m.expected) / audio.sr * 1000).toFixed(0);
    $('beepinfo').textContent = m.acoustic ? `Start beep heard by mic (latency ${off} ms, removed)` : 'Beep not heard by mic — using estimated timing';
    const p = T.pending; T.pending = []; for (const q of p) addShot(q.frame, q.db);
    return;
  }
  if (m.type === 'shot' && T.state === 'live') {
    if (T.beepFrame == null) T.pending.push({ frame: m.frame, db: m.peakDb });   // beep timing not confirmed yet
    else addShot(m.frame, m.peakDb);
  }
}

// ---------- beep diagnostics ----------
// Re-scans the raw mic audio captured around the start beep and reports where (and how loud) the beep tone was.
let lastDiag = null;
function goertzelScan(x, sr, hz) {
  const N = Math.round(sr / 1000), coef = 2 * Math.cos(2 * Math.PI * hz / sr), out = [];
  for (let b = 0; b + N <= x.length; b += N) {
    let s1 = 0, s2 = 0, en = 0;
    for (let k = 0; k < N; k++) { const v = x[b + k], s0 = v + coef * s1 - s2; s2 = s1; s1 = s0; en += v * v; }
    const pw = s1 * s1 + s2 * s2 - coef * s1 * s2;
    out.push({ b, ratio: pw / (N / 2 * en + 1e-20), db: 10 * Math.log10(en / N + 1e-14), tone: 10 * Math.log10(pw / (N * N / 4) + 1e-14) });
  }
  return out;
}
function onBeepDiag(m) {
  const sr = m.sampleRate, sc = goertzelScan(m.buf, sr, m.hz);
  // a beep = at least 10 ms in a row of pure tone (a gunshot can look tonal for a block or two, never 10)
  const tonal = []; let run = [];
  for (const c of sc.concat([{ ratio: 0 }])) { if (c.ratio > 0.3) run.push(c); else { if (run.length >= 10) tonal.push(...run); run = []; } }
  const best = (tonal.length ? tonal : sc).reduce((a, c) => (c.tone > a.tone ? c : a), tonal[0] || sc[0]);
  const pure = sc.reduce((a, c) => (c.ratio > a.ratio ? c : a), sc[0]);
  const pre = sc.filter((c) => c.b < 0.25 * sr);
  const noise = pre.length ? pre.map((c) => c.db).sort((a, b) => a - b)[pre.length >> 1] : -99;
  const loud = Math.max(...sc.map((c) => c.db));
  lastDiag = {
    at: new Date().toLocaleTimeString(), heard: m.acoustic, sr, hz: m.hz,
    toneFound: tonal.length > 0, bestPurity: pure.ratio, toneDb: best.tone, toneRatio: best.ratio, toneAtMs: ((m.from + best.b) - m.exp) / sr * 1000,
    noiseDb: noise, loudDb: loud, latencyMs: m.latency * 1000, ua: navigator.userAgent.replace(/^Mozilla\/5.0 /, ''),
    audioMode: S.audioMode, audioSession: navigator.audioSession ? navigator.audioSession.type : 'n/a',
    raw: m.buf,
  };
  renderDiag();
  if (!m.acoustic) $('beepinfo').textContent = tonal.length ? `Beep not heard by mic — faint beep tone at ${best.tone.toFixed(0)} dB (noise ${noise.toFixed(0)} dB). Settings › Diagnostics` : 'Beep not heard by mic — no beep tone in the recording at all. Settings › Diagnostics';
}
function renderDiag() {
  const d = lastDiag, el = $('diag'); if (!el) return;
  if (!d) { el.textContent = 'Run one string on the Timer tab, then come back here.'; return; }
  el.textContent =
    `Last string ${d.at}: beep ${d.heard ? 'HEARD by mic ✓' : 'NOT heard ✗'}\n` +
    (d.toneFound ? `Beep tone peak: ${d.toneDb.toFixed(1)} dB, purity ${d.toneRatio.toFixed(2)}, at ${d.toneAtMs >= 0 ? '+' : ''}${d.toneAtMs.toFixed(0)} ms vs expected\n` : `No beep tone found (best purity ${d.bestPurity.toFixed(2)})\n`) +
    `Background noise: ${d.noiseDb.toFixed(1)} dB   loudest sound: ${d.loudDb.toFixed(1)} dB\n` +
    `Latency estimate: ${d.latencyMs.toFixed(0)} ms   sample rate: ${d.sr}\n` +
    `Audio mode: ${d.audioMode} (session: ${d.audioSession})\n${d.ua}`;
}
function wavBlob(x, sr) {
  const b = new ArrayBuffer(44 + x.length * 2), v = new DataView(b), w = (o, s) => [...s].forEach((c, i) => v.setUint8(o + i, c.charCodeAt(0)));
  w(0, 'RIFF'); v.setUint32(4, 36 + x.length * 2, true); w(8, 'WAVEfmt '); v.setUint32(16, 16, true); v.setUint16(20, 1, true); v.setUint16(22, 1, true);
  v.setUint32(24, sr, true); v.setUint32(28, sr * 2, true); v.setUint16(32, 2, true); v.setUint16(34, 16, true); w(36, 'data'); v.setUint32(40, x.length * 2, true);
  for (let i = 0; i < x.length; i++) v.setInt16(44 + i * 2, Math.max(-1, Math.min(1, x[i])) * 32767, true);
  return new Blob([b], { type: 'audio/wav' });
}
async function shareDiag() {
  if (!lastDiag) return;
  const file = new File([wavBlob(lastDiag.raw, lastDiag.sr)], `beep-debug-${Date.now()}.wav`, { type: 'audio/wav' });
  try { if (navigator.canShare && navigator.canShare({ files: [file] })) return await navigator.share({ files: [file], text: $('diag').textContent }); } catch (e) { if (e.name === 'AbortError') return; }
  const a = document.createElement('a'); a.href = URL.createObjectURL(file); a.download = file.name; a.click();
}

// ---------- rendering ----------
function setStatus(txt, cls) { const s = $('status'); s.textContent = txt; s.className = 'status' + (cls ? ' ' + cls : ''); document.querySelector('.readout').classList.toggle('go', cls === 'live'); }
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
  const am = $('set-audiomode'); am.value = S.audioMode;
  am.addEventListener('change', () => { S.audioMode = am.value; saveSettings(); $('audiomode-note').textContent = 'Close and reopen the app for this to take effect.'; });
  $('btn-diag-share').onclick = shareDiag; renderDiag();
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
