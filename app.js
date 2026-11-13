/* Shot Timer — app logic. Timing lives in the AudioWorklet (worklet.js + detector.js);
 * this file runs the UI, the start/par beeps, and history. */
'use strict';
const BUILD = 'v0.1.8';
const $ = (id) => document.getElementById(id);
const fmt = (t) => (t == null || !isFinite(t)) ? '—' : t.toFixed(3);

// ---------- settings & storage ----------
const DEFAULT_SETTINGS = {
  dmin: 2, dmax: 5, hz: 2400, blen: 300, par: 0,
  sens: 5, echo: 180, lock: 100, auto: 4,
  audioMode: 'play-and-record', beepOut: 'webaudio',
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

// The mic can stop delivering audio on iOS (route change, another app, an audio element). A live mic always has
// some noise; dead silence (exact zeros) for 1.5 s means it stopped. Then tear down and reopen it on the next START.
let deadSince = 0;
function micHealth(db) {
  if (db > -115) { deadSince = 0; return; }   // a working mic never reads below about -100 dB; -120 is exact silence
  if (!deadSince) deadSince = performance.now();
  if (performance.now() - deadSince > 1500 && !audio.dead) {
    audio.dead = true; console.warn('[shot-timer] mic delivering silence — will reopen');
    if (T.state === 'standby' || T.state === 'live') { cancel(); }
    setStatus('Mic stopped', 'err'); $('beepinfo').textContent = 'The microphone stopped. Tap START to reconnect it.';
  }
}
async function resetAudio() {
  try { audio.stream && audio.stream.getTracks().forEach((t) => t.stop()); } catch {}
  try { audio.ctx && (await audio.ctx.close()); } catch {}
  Object.assign(audio, { ctx: null, node: null, stream: null, ready: null, dead: false }); deadSince = 0;
}
async function ensureAudio() {
  if (audio.dead || (audio.stream && audio.stream.getAudioTracks().some((t) => t.readyState === 'ended'))) await resetAudio();
  if (audio.ready) return audio.ready;
  audio.ready = (async () => {
    setSession(S.audioMode);
    const ctx = new (window.AudioContext || window.webkitAudioContext)({ latencyHint: 'interactive' });
    audio.ctx = ctx;
    const stream = await navigator.mediaDevices.getUserMedia({
      audio: { echoCancellation: false, noiseSuppression: false, autoGainControl: false, channelCount: 1 },
    });
    audio.stream = stream;
    // Confirm what iOS actually applied; if any processing is still on, ask again on the live track.
    const track = stream.getAudioTracks()[0], g0 = track.getSettings(), ti = { ec0: g0.echoCancellation, ns0: g0.noiseSuppression, agc0: g0.autoGainControl };
    try { const cp = track.getCapabilities ? track.getCapabilities() : {}; ti.ecCaps = JSON.stringify(cp.echoCancellation); } catch {}
    if (g0.echoCancellation || g0.noiseSuppression || g0.autoGainControl) {
      try { await track.applyConstraints({ echoCancellation: false, noiseSuppression: false, autoGainControl: false }); ti.apply = 'ok'; }
      catch (e) { ti.apply = 'failed: ' + (e.name || e.message); }
    }
    const g1 = track.getSettings();
    Object.assign(ti, { ec: g1.echoCancellation, ns: g1.noiseSuppression, agc: g1.autoGainControl, sampleRate: g1.sampleRate, channelCount: g1.channelCount });
    audio.trackInfo = ti; console.log('[shot-timer] mic track settings', g0, '→', g1, ti);
    await ctx.audioWorklet.addModule('detector.js');
    await ctx.audioWorklet.addModule('worklet.js');
    const src = ctx.createMediaStreamSource(stream);
    const node = new AudioWorkletNode(ctx, 'shot-timer', { numberOfInputs: 1, numberOfOutputs: 1, outputChannelCount: [1] });
    const mute = ctx.createGain(); mute.gain.value = 0;     // keep the graph pulling without echoing the mic
    src.connect(node); node.connect(mute); mute.connect(ctx.destination);
    audio.gain = ctx.createGain(); audio.gain.gain.value = 1; audio.gain.connect(ctx.destination);
    audio.an = ctx.createAnalyser(); audio.an.fftSize = 2048; audio.gain.connect(audio.an);   // confirms the beep was generated
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
  const c = audio.ctx; let inp = 0;
  try { const s = audio.stream.getAudioTracks()[0].getSettings(); if (s.latency) inp = s.latency; } catch {}
  audio.reportedLatency = { output: (c.outputLatency || 0) * 1000, base: (c.baseLatency || 0) * 1000, input: inp * 1000 };
  return (c.outputLatency || 0) + (c.baseLatency || 0) + inp;
}
const sessType = () => (navigator.audioSession ? navigator.audioSession.type : 'n/a (no audioSession API)');
function setSession(mode) {
  if (!navigator.audioSession || mode === 'default') return;
  try { navigator.audioSession.type = mode; } catch (e) { console.warn('audioSession', e); }
}
// Alternative beep path: an <audio> element playing a generated WAV (iOS may route/process it differently).
let beepEl = null, beepElKey = '';
function primeBeepElement() {
  const key = S.hz + '/' + S.blen; if (!beepEl) beepEl = new Audio();
  if (key !== beepElKey) {
    const sr = 48000, n = Math.round(S.blen / 1000 * sr), x = new Float32Array(n), r = Math.round(0.003 * sr);
    for (let i = 0; i < n; i++) x[i] = BEEP_GAIN * Math.sin(2 * Math.PI * S.hz * i / sr) * Math.min(1, i / r, (n - i) / r);
    beepEl.src = URL.createObjectURL(wavBlob(x, sr)); beepElKey = key;
  }
  // Unlock the element inside the tap with a SILENT clip (iOS ignores .muted, so priming with the beep itself was audible).
  if (!primeBeepElement.silent) primeBeepElement.silent = URL.createObjectURL(wavBlob(new Float32Array(2400), 48000));
  const beepUrl = beepEl.src; beepEl.src = primeBeepElement.silent;
  const p = beepEl.play(); const back = () => { beepEl.pause(); beepEl.src = beepUrl; beepEl.load(); };
  if (p) p.then(back).catch(back); else back();
}

function scheduleBeep(at, ms) {
  const c = audio.ctx, o = c.createOscillator(), g = c.createGain();
  o.type = 'sine'; o.frequency.value = S.hz;
  const d = ms / 1000;
  g.gain.setValueAtTime(0, at); g.gain.linearRampToValueAtTime(BEEP_GAIN, at + 0.003);
  g.gain.setValueAtTime(BEEP_GAIN, at + d - 0.01); g.gain.linearRampToValueAtTime(0, at + d);
  o.connect(g); g.connect(audio.gain); o.start(at); o.stop(at + d + 0.02);
  return o;
}

// ---------- timer state machine ----------
// idle -> standby (waiting for random beep) -> live (listening) -> done (review)
const BEEP_GAIN = 0.9;
const T = { beepGain: BEEP_GAIN, beepOut: 'webaudio', genPeak: null, sessAtSchedule: '', sessAtBeep: '', state: 'idle', beepAt: 0, pending: [], raf: 0, beepFrame: null, acoustic: false, shots: [], oscs: [], lastActivity: 0, delay: 0, autoTimer: null, wakeLock: null };

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
  T.beepOut = 'webaudio'; T.genPeak = null; T.sessAtSchedule = sessType(); T.sessAtBeep = '';
  clearTimeout(T.elTimer);
  if (false) {   // audio-element beep removed: on iOS it could cut off the microphone
    primeBeepElement(); T.oscs = [];
    T.elTimer = setTimeout(() => { beepEl.currentTime = 0; beepEl.play().catch((e) => console.warn('beep element', e)); },
      Math.max(0, (beepAt - audio.ctx.currentTime) * 1000));
  } else T.oscs = [scheduleBeep(beepAt, S.blen)];
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
    if (T.beepOut === 'webaudio' && now - T.beepAt < S.blen / 1000 + 0.1) {      // measure the generated beep signal
      const buf = audio.tdBuf || (audio.tdBuf = new Float32Array(audio.an.fftSize)); audio.an.getFloatTimeDomainData(buf);
      let pk = 0; for (const v of buf) pk = Math.max(pk, Math.abs(v)); T.genPeak = Math.max(T.genPeak || 0, pk);
    }
  }
  if (T.state === 'standby' || T.state === 'live') T.raf = requestAnimationFrame(tick);
}

function goLive() {
  T.sessAtBeep = sessType();
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
  T.lastActivity = performance.now(); renderShots(); renderStats(); renderDiag();
}

function cancel() {
  clearTimeout(T.elTimer); if (beepEl) beepEl.pause();
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
  if (m.type === 'level') { micHealth(m.db); return drawMeter(m.db); }
  if (m.type === 'beepdiag') return onBeepDiag(m);
  if (m.type === 'beep' && (T.state === 'standby' || T.state === 'live') && T.beepFrame == null) {
    // The worklet located the beep in the mic stream: that is t=0 for every shot.
    T.beepFrame = m.frame; T.acoustic = m.acoustic;
    const off = ((m.frame - m.expected) / audio.sr * 1000).toFixed(0);
    $('beepinfo').textContent = m.acoustic ? 'Start beep heard by mic ✓ — timing from the beep' : 'Beep not heard by mic — using estimated timing';
    const p = T.pending; T.pending = []; for (const q of p) addShot(q.frame, q.db);
    return;
  }
  if (m.type === 'shot' && T.state === 'live') {
    if (T.beepFrame == null) T.pending.push({ frame: m.frame, db: m.peakDb });   // beep timing not confirmed yet
    else addShot(m.frame, m.peakDb);
  }
}

// ---------- beep diagnostics ----------
// Re-analyses the raw mic audio captured from START until 2 s after the beep and reports what the mic heard.
let lastDiag = null;
function highpass200(x, sr) {
  const w0 = 2 * Math.PI * 200 / sr, al = Math.sin(w0) / (2 * Math.SQRT1_2), c = Math.cos(w0), a0 = 1 + al;
  const b0 = (1 + c) / 2 / a0, b1 = -(1 + c) / a0, a1 = -2 * c / a0, a2 = (1 - al) / a0, y = new Float32Array(x.length);
  let x1 = 0, x2 = 0, y1 = 0, y2 = 0;
  for (let i = 0; i < x.length; i++) { const v = b0 * x[i] + b1 * x1 + b0 * x2 - a1 * y1 - a2 * y2; x2 = x1; x1 = x[i]; y2 = y1; y1 = v; y[i] = v; }
  return y;
}
const dbs = (p) => 10 * Math.log10(p + 1e-20);
function median(a) { const b = a.slice().sort((u, v) => u - v); return b.length ? b[b.length >> 1] : -120; }
// Level in the beep's band (±50 Hz, 10 ms Goertzel blocks) over the whole recording.
function bandScan(y, sr, hz) {
  const N = Math.round(sr / 100), g = (b, f) => { const c = 2 * Math.cos(2 * Math.PI * f / sr); let s1 = 0, s2 = 0;
    for (let k = 0; k < N; k++) { const s0 = y[b + k] + c * s1 - s2; s2 = s1; s1 = s0; } return dbs((s1 * s1 + s2 * s2 - c * s1 * s2) / (N * N / 4)); };
  const out = [];
  for (let b = 0; b + N <= y.length; b += N) {
    const db = g(b, hz), nb = Math.max(g(b, hz - 600), g(b, hz - 300), g(b, hz + 300), g(b, hz + 600));
    out.push({ b, db, contrast: db - nb });
  }
  return out;
}
// Strongest STEADY tone anywhere in 300–8000 Hz (same FFT bin wins ≥3 frames in a row, ≥20 dB above that frame's median).
function steadyTone(y, sr) {
  const n = 4096, hop = 2048, re = new Float64Array(n), im = new Float64Array(n), lo = Math.ceil(300 * n / sr), hi = Math.floor(8000 * n / sr);
  const frames = [];
  for (let s = 0; s + n <= y.length; s += hop) {
    for (let k = 0; k < n; k++) { re[k] = y[s + k] * (0.5 - 0.5 * Math.cos(2 * Math.PI * k / (n - 1))); im[k] = 0; }
    ShotDetector.fft(re, im);
    let bk = lo, bp = 0; const ps = [];
    for (let k = lo; k <= hi; k++) { const p = re[k] * re[k] + im[k] * im[k]; ps.push(p); if (p > bp) { bp = p; bk = k; } }
    frames.push({ s, bk, db: dbs(bp / (n * n / 16)), prom: dbs(bp) - dbs(median(ps)) });
  }
  let best = null;
  for (let i = 2; i < frames.length; i++) {
    const f = frames[i], ok = [frames[i - 1], frames[i - 2]].every((g) => Math.abs(g.bk - f.bk) <= 1 && g.prom > 20) && f.prom > 20;
    if (ok && (!best || f.db > best.db)) best = { hz: f.bk * sr / n, db: f.db, s: f.s };
  }
  return best;
}
function onBeepDiag(m) {
  const sr = m.sampleRate, y = highpass200(m.buf, sr), lat = m.latency;
  const band = bandScan(y, sr, m.hz);
  const expRel = m.exp - m.from;                                   // expected beep position in the recording (samples)
  const pre = band.filter((c) => c.b < expRel - 0.2 * sr).map((c) => c.db);
  const bandBg = pre.length ? median(pre) : median(band.map((c) => c.db));
  const win = band.filter((c) => c.b >= expRel - 0.15 * sr && c.b <= expRel + 1.0 * sr);
  const tonalWin = win.filter((c) => c.contrast > 10);         // blocks where the band beats its neighbours (tone-like)
  const bp = (tonalWin.length ? tonalWin : win).reduce((a, c) => (c.db > a.db ? c : a), (tonalWin[0] || win[0]) || { db: -120, b: 0, contrast: 0 });
  const tone = steadyTone(y, sr);
  let rms = 0; for (let i = 0; i < y.length; i++) rms += y[i] * y[i];
  const trk = audio.trackInfo || {};
  lastDiag = {
    at: new Date().toLocaleTimeString(), heard: m.acoustic, sr, hz: m.hz,
    bandPeakDb: bp.db, bandContrast: bp.contrast, bandTonal: tonalWin.length > 0, bandBgDb: bandBg, bandSnr: bp.db - bandBg, bandAtMs: (bp.b - expRel) / sr * 1000,
    tone, levelDb: dbs(rms / y.length),
    vsPredictedMs: m.acoustic ? (m.found - m.exp) / sr * 1000 : null,
    reported: audio.reportedLatency || {},
    recLen: m.buf.length / sr, beepOffset: (expRel - lat * sr) / sr, beepOffsetWithLat: expRel / sr,
    gain: T.beepGain, out: T.beepOut, genPeak: T.genPeak, sessAtSchedule: T.sessAtSchedule, sessAtBeep: T.sessAtBeep,
    trk, ua: navigator.userAgent.replace(/^Mozilla\/5.0 /, ''), raw: m.buf,
  };
  renderDiag();
  if (!m.acoustic) $('beepinfo').textContent = lastDiag.bandTonal ? `Beep not heard by mic — only a faint tone, ${lastDiag.bandSnr.toFixed(0)} dB above background. Settings › Diagnostics` : 'Beep not heard by mic — no beep tone in the recording. Settings › Diagnostics';
}
function renderDiag() {
  const d = lastDiag, el = $('diag'); if (!el) return;
  if (!d) { el.textContent = 'Run one string on the Timer tab, then come back here.'; return; }
  const f1 = (v, u = '') => (v == null || !isFinite(v)) ? 'n/a' : v.toFixed(1) + u;
  const yn = (v) => v === undefined ? '?' : String(v);
  const t = d.trk, r = d.reported;
  el.textContent = [
    `Last string ${d.at}: beep ${d.heard ? 'HEARD by mic ✓' : 'NOT heard ✗'}`,
    `— Beep played —`,
    `Pitch ${d.hz} Hz · gain ${d.gain} · output ${d.out} · generated peak ${d.genPeak == null ? 'n/a' : d.genPeak.toFixed(2)}`,
    `Session at schedule: ${d.sessAtSchedule} · at beep: ${d.sessAtBeep}`,
    `Beep at ${d.beepOffset.toFixed(3)} s into the ${d.recLen.toFixed(2)} s recording (${d.beepOffsetWithLat.toFixed(3)} s incl. latency guess)`,
    `— What the mic heard (after 200 Hz high-pass) —`,
    `Beep band ${d.hz}±50 Hz: ${d.bandTonal ? 'tone-like' : 'NO tone (loudest non-tonal)'} peak ${f1(d.bandPeakDb, ' dB')} at ${d.bandAtMs >= 0 ? '+' : ''}${d.bandAtMs.toFixed(0)} ms`,
    `   SNR vs band background ${f1(d.bandSnr, ' dB')} (need 15) · above neighbour bands ${f1(d.bandContrast, ' dB')} (need 10)`,
    `Strongest steady tone: ${d.tone ? `${d.tone.hz.toFixed(0)} Hz at ${d.tone.db.toFixed(1)} dB, ${(d.tone.s / d.sr).toFixed(2)} s in` : 'none'}`,
    `Overall level ${f1(d.levelDb, ' dB')}`,
    `Beep found vs predicted: ${d.vsPredictedMs == null ? 'n/a (beep not detected)' : (d.vsPredictedMs >= 0 ? '+' : '') + d.vsPredictedMs.toFixed(1) + ' ms (timing uses the detected beep)'}`,
    `Reported by browser: output ${f1(r.output, ' ms')} · base ${f1(r.base, ' ms')} · input ${f1(r.input, ' ms')}`,
    `— Microphone (applied by iOS) —`,
    `echoCancellation ${yn(t.ec)} · noiseSuppression ${yn(t.ns)} · autoGainControl ${yn(t.agc)}`,
    `requested all false · first grant: EC ${yn(t.ec0)} NS ${yn(t.ns0)} AGC ${yn(t.agc0)} · applyConstraints: ${t.apply || 'not needed'}`,
    `track rate ${yn(t.sampleRate)} · channels ${yn(t.channelCount)} · context rate ${d.sr} · EC options ${yn(t.ecCaps)}`,
    `— Shots the app logged (s after beep) —`,
    T.shots.length ? T.shots.map((q, i) => `${i + 1}: ${q.t.toFixed(3)} (${q.db.toFixed(1)} dB)${q.removed ? ' removed' : ''}`).join('  ') : 'none',
    d.ua,
  ].join('\n');
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
