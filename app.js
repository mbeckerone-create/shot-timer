/* Shot Timer — app logic. Timing lives in the AudioWorklet (worklet.js + detector.js);
 * this file runs the UI, the start/par beeps, and history. */
'use strict';
const BUILD = 'v0.8.2';
const $ = (id) => document.getElementById(id);
const fmt = (t) => (t == null || !isFinite(t)) ? '—' : t.toFixed(3);

// ---------- settings & storage ----------
const DEFAULT_SETTINGS = {
  dmin: 2, dmax: 5, hz: 2400, blen: 300, par: 0,
  sens: 5, echo: 180, lock: 100, auto: 4,
  audioMode: 'play-and-record', beepOut: 'webaudio',
  mode: 'range',                                   // 'range' (live fire) | 'dry' (dry fire draws)
  gate: 10, rangeRepeat: false, rangeReset: 5,      // gate: ignore sounds this many dB quieter than your own shots (0 = off)
  drySens: 7, dryRepeat: false, dryReholster: 5, dryTimeout: 5, clickMatch: 0.9, clickTpl: null, clickInfo: null,
  dryDrill: 'trigger',                             // 'trigger' (click only) | 'draw' (holster snap → click) | 'reload' (click → reload → click)
  holTpl: null, holInfo: null, reloadTimeout: 10,
  camFacing: 'user',                               // training film: 'user' (front, you can see the overlay) | 'environment'
  shooters: ['Me'], guns: ['Pistol'], shooter: 'Me', gun: 'Pistol',
};
const store = {
  get(k, d) { try { const v = localStorage.getItem(k); return v ? JSON.parse(v) : d; } catch { return d; } },
  set(k, v) { try { localStorage.setItem(k, JSON.stringify(v)); } catch {} },
};
let S = Object.assign({}, DEFAULT_SETTINGS, store.get('st.settings', {}));
if (!S.shooters.includes(S.shooter)) S.shooter = S.shooters[0] || '';
if (!S.guns.includes(S.gun)) S.gun = S.guns[0] || '';
// v0.2.2 changed the click fingerprint (32 full-band bands): older templates must be re-taught
if (S.clickTpl && S.clickTpl.length !== 32) { S.clickTpl = null; S.clickInfo = null; }
if (S.clickMatch === 0.75) S.clickMatch = 0.9;
let history = store.get('st.history', []);
let sessions = store.get('st.sessions', []);                 // [{id, name, start, end, cfgStart, cfgEnd}]
let activeSession = store.get('st.activeSession', null);    // id or null
const saveSettings = () => store.set('st.settings', S);
const saveHistory = () => store.set('st.history', history);
const saveSessions = () => { store.set('st.sessions', sessions); store.set('st.activeSession', activeSession); };
// settings that shape a result: stored on every record made in a session, and on the session itself
const cfgSnap = () => ({ mode: S.mode, drill: S.dryDrill, sens: S.sens, drySens: S.drySens, clickMatch: S.clickMatch, echo: S.echo, lock: S.lock, par: S.par, dmin: S.dmin, dmax: S.dmax,
  beepHz: S.hz, beepMs: S.blen, repeat: S.mode === 'dry' ? S.dryRepeat : S.rangeRepeat, gate: S.gate, shooter: S.shooter, gun: S.gun, clickLearned: S.clickInfo ? S.clickInfo.at : null, holsterLearned: S.holInfo ? S.holInfo.at : null });
function tagRecord(r) { if (activeSession) { r.session = activeSession; r.cfg = cfgSnap(); } return r; }

const isDry = () => S.mode === 'dry';
const repeatOn = () => (isDry() ? S.dryRepeat : S.rangeRepeat);
const drySensToDb = (s) => -30 - (s - 1) * 3;          // dry fire: 1:-30 dB … 7:-48 dB … 10:-57 dB (just above room noise)
function detParams() {
  if (isDry()) return { shotDb: drySensToDb(S.drySens), echoMs: 0, lockMs: 60 };   // short lock: see both halves of a rack
  return { shotDb: ShotDetector.sensitivityToDb(S.sens), echoMs: S.echo, lockMs: S.lock };
}
// ---------- dry fire: trigger-click fingerprint ----------
// Each detected sound carries 24 band energies (2–20 kHz). We compare its SHAPE (level removed) with the learned
// trigger click by cosine similarity: ~0.9+ for the same click, ~0 for a holster clack or a tap.
const shape = (b) => { const m = b.reduce((a, c) => a + c, 0) / b.length; return b.map((v) => v - m); };
function cosSim(a, b) { let s = 0, na = 0, nb = 0; for (let i = 0; i < a.length; i++) { s += a[i] * b[i]; na += a[i] * a[i]; nb += b[i] * b[i]; } return s / Math.sqrt(na * nb + 1e-12); }
function clickScore(bands) { return S.clickTpl && bands ? cosSim(shape(bands), S.clickTpl) : 1; }
// A trigger click is ONE snap. A rack is two or more (pull back, slam forward) within a fraction of a second,
// so a sound only counts if no similar-loudness sound is within 0.25 s of it. It must also sound like the learned
// click and be about as loud (speech is far quieter). Verified on a labelled recording: 4/4 clicks, 0 racks/speech.
// Tuned on a 2nd recording at ~3 ft: the click's own room echo arrives < 80 ms after it (not a 2nd snap), and a
// click drilled at 3 ft is far quieter than one taught at < 1 ft, so the loudness window is wide.
const ISO_S = 0.25, ISO_MIN = 0.08, ISO_DB = 15, LEVEL_DB = 30;
// A Kydex holster releases with its own single snap that sounds a lot like the click (a hands-on-gun draw was being
// timed at 0.3 s). On a labelled recording, a learned holster fingerprint separated holster snap from trigger click
// 16/17 times: the click has ~10 dB more 8–16 kHz energy. So each single snap goes to whichever template it is closer to.
function judgeSound(c, all) {
  const sh = shape(c.bands), score = clickScore(c.bands), hol = S.holTpl ? cosSim(sh, S.holTpl) : -1;
  const loudEnough = !S.clickInfo || c.db >= S.clickInfo.db - LEVEL_DB;
  const neighbor = all.find((o) => o !== c && Math.abs(o.t - c.t) >= ISO_MIN && Math.abs(o.t - c.t) < ISO_S && o.db > c.db - ISO_DB);
  let kind = null, reason = '';
  if (neighbor) reason = 'double'; else if (!loudEnough) reason = 'quiet';
  else if (hol >= S.clickMatch && hol > score) kind = 'holster';
  else if (score >= S.clickMatch) kind = 'click';
  else reason = 'sound';
  return { kind, score, hol, reason };
}
// Build the template from the learned sounds: keep the ones most like each other (drops a slide rack or a bump).
function buildTemplate(list) {
  const sh = list.map((q) => shape(q.bands));
  const avgSim = sh.map((a, i) => sh.reduce((t, b, j) => t + (i === j ? 0 : cosSim(a, b)), 0) / Math.max(1, sh.length - 1));
  const cut = median(avgSim) - 0.05, keep = sh.filter((_, i) => avgSim[i] >= cut);
  const tpl = keep[0].map((_, k) => keep.reduce((t, v) => t + v[k], 0) / keep.length);
  const cons = keep.reduce((t, v) => t + cosSim(v, tpl), 0) / keep.length;
  return { tpl: tpl.map((v) => +v.toFixed(2)), used: keep.length, of: list.length, consistency: cons, db: median(list.map((q) => q.db)) };
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
const T = { preset: null, drillRes: [], series: [], seriesOn: false, nextTimer: null, repTimer: null, learning: null, beepGain: BEEP_GAIN, beepOut: 'webaudio', genPeak: null, sessAtSchedule: '', sessAtBeep: '', state: 'idle', beepAt: 0, pending: [], raf: 0, beepFrame: null, acoustic: false, shots: [], oscs: [], lastActivity: 0, delay: 0, autoTimer: null, wakeLock: null };

// A drill run (from the Range screen): T.preset = {name, steps, shots, reps, par, reset}. Each rep is one string with
// its own random beep; the string ends once its shots are in; after the last rep the drill is done.
function presetPar() { return T.preset ? T.preset.par : S.par; }
function drillStatus() { return T.preset ? `Rep ${Math.min(T.drillRes.length + 1, T.preset.reps)} of ${T.preset.reps}` : ''; }
async function onMain() {
  if (T.learning) return finishLearn();
  if (T.preset) {
    if (T.state === 'idle' || T.state === 'done') { if (T.drillRes.length >= T.preset.reps) T.drillRes = []; T.seriesOn = true; T.series = []; window.UI && UI.renderPlan(); return start(); }
    return stopSeries();
  }
  if (isDry()) {
    if (T.state === 'idle' || T.state === 'done') { T.seriesOn = S.dryRepeat; T.series = []; return start(); }
    return stopSeries();                                 // standby / live / reholster: end the drill
  }
  if (T.state === 'idle' || T.state === 'done') { T.seriesOn = S.rangeRepeat; T.series = []; return start(); }
  if (T.seriesOn) return stopSeries();                    // repeat strings: STOP ends the whole run
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
  T.shots = []; T.ignored = []; T.dryEvents = []; T.pending = []; T.beepFrame = null; T.saved = false; renderShots(); renderStats();
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
  if (film.on) filmLog('beep_scheduled', { beepAt, mode: S.mode, drill: S.dryDrill, delay: +T.delay.toFixed(3) });
  const parAt = [], par = presetPar();
  if (par > 0) { parAt.push(beepAt + par); T.oscs.push(scheduleBeep(beepAt + par, S.blen)); }
  $('p-res').textContent = par > 0 ? `Par ${par.toFixed(2)} s` : ''; $('p-res').className = 'p-res p-par';
  audio.node.port.postMessage({ type: 'params', params: detParams() });
  audio.node.port.postMessage({ type: 'arm', beepAt, parAt, beepMs: S.blen, beepHz: S.hz, latency: latencyEstimate() });
  T.state = 'standby'; setStatus(T.preset ? `${drillStatus()} · standby` : T.seriesOn ? `${isDry() ? 'Rep' : 'String'} ${T.series.length + 1} · standby` : 'Standby', 'standby'); $('big').textContent = '0.000';
  window.UI && UI.renderPlan();
  $('beepinfo').textContent = '';
  setMain(T.seriesOn ? 'STOP' : 'CANCEL', 'standby'); if (!isDry()) $('btn-review').disabled = true;
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
    if (window.UI) UI.gauge(Math.max(0, now - T.beepAt));
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
  if (isDry()) {                                       // dry fire: wait for one trigger click, give up after the rep timeout
    T.rep = { holster: null, clicks: [], snaps: [], tentative: null, tTimer: null, rackT: null };
    clearTimeout(T.repTimer); T.repTimer = setTimeout(repTimeout, (S.dryTimeout + ISO_S + 0.1) * 1000);
    return;
  }
  T.autoTimer = setInterval(() => {
    if (T.state !== 'live') return clearInterval(T.autoTimer);
    const quiet = (performance.now() - T.lastActivity) / 1000;
    const lim = S.auto > 0 ? S.auto : T.seriesOn ? 4 : 120;          // repeat strings always end on their own
    if (quiet > lim && (liveShots().length || quiet > (T.seriesOn ? 15 : 30))) stop();
  }, 250);
}

function addShot(frame, db, bands) {
  if (frame <= T.beepFrame) return;
  if (film.on && !isDry()) camEvent(`SHOT ${fmt((frame - T.beepFrame) / audio.sr)}`, 'click');
  if (isDry()) {
    // decide 0.3 s later, once we know whether another snap followed (a rack) — the time is still the click's onset
    const c = { t: (frame - T.beepFrame) / audio.sr, db, bands }; T.dryEvents.push(c);
    setTimeout(() => { if (T.state === 'live') onDrySound(c, judgeSound(c, T.dryEvents)); }, (ISO_S + 0.05) * 1000);
    return;
  }
  const shot = { t: (frame - T.beepFrame) / audio.sr, db, removed: false }; T.shots.push(shot);
  T.shots.sort((a, b) => a.t - b.t); applyGate();
  if (!shot.removed) T.lastActivity = performance.now();   // quiet bangs (other lanes) don't keep the string open
  renderShots(); renderStats(); renderDiag();
  if (T.preset) {
    const n = liveShots().length; window.UI && UI.renderPlan(n);
    setStatus(`Shot ${Math.min(n, T.preset.shots)} of ${T.preset.shots}`, 'live');
    if (n >= T.preset.shots) { clearTimeout(T.doneTimer); T.doneTimer = setTimeout(() => { if (T.state === 'live') stop(); }, 700); }   // all shots in: end the string
  }
}

// Own-gun gate: your gun is by far the loudest thing the phone hears (about -3 dB on the range clip of Nov 14);
// other lanes and echoes were 11-40 dB quieter. Sounds more than S.gate dB below the loudest shot of the string are
// struck out (tap ↺ to keep one). Checked on 30 filmed reps: keeps every shot of yours, drops the rest.
function applyGate() {
  if (!(S.gate > 0)) { for (const q of T.shots) if (q.auto === 'quiet') { q.removed = false; delete q.auto; } return; }
  const top = Math.max(...T.shots.map((q) => q.db));
  for (const q of T.shots) {
    if (q.keep) continue;
    const quiet = q.db < top - S.gate;
    if (quiet && !q.removed) { q.removed = true; q.auto = 'quiet'; } else if (!quiet && q.auto === 'quiet') { q.removed = false; delete q.auto; }
  }
}
function cancel() {
  clearTimeout(T.elTimer); if (beepEl) beepEl.pause();
  for (const o of T.oscs) { try { o.stop(); } catch {} }
  audio.node.port.postMessage({ type: 'disarm' });
  cancelAnimationFrame(T.raf); $('big').textContent = '0.000';
  T.state = 'idle'; setStatus('Ready'); setMain('START'); releaseWake();
}

function stop() {
  if (film.on) filmLog('string', { shots: T.shots.map((q) => ({ t: +q.t.toFixed(4), db: +q.db.toFixed(1), gated: q.auto === 'quiet' || undefined })) });
  audio.node.port.postMessage({ type: 'disarm' });
  for (const o of T.oscs) { try { o.stop(); } catch {} }
  clearInterval(T.autoTimer); cancelAnimationFrame(T.raf);
  const n = liveShots().length; clearTimeout(T.doneTimer);
  T.state = 'done'; renderStats(); setStatus(n ? 'String done' : 'No shots heard');
  setMain('START'); $('btn-review').disabled = !n; $('btn-review').textContent = 'Score…';
  autoSaveIfNeeded();
  const par = presetPar(), s0 = summarize(liveShots());
  if (par > 0 && n) { const d = s0.total - par; $('p-res').innerHTML = d <= 0 ? `${IC.ok} ${Math.abs(d).toFixed(2)} under par ${par.toFixed(2)}` : `${IC.no} ${d.toFixed(2)} over par ${par.toFixed(2)}`; $('p-res').className = 'p-res' + (d > 0 ? ' over' : ''); }
  if (T.preset) {                                        // a drill: record the rep, then reset or finish
    T.drillRes.push({ v: n ? s0.total : null, ok: n > 0 && s0.total <= par, rec: T.saved });
    window.UI && UI.renderPlan();
    if (T.drillRes.length >= T.preset.reps) return drillDone();
    T.state = 'reholster'; setMain('STOP', 'stop'); let left = T.preset.reset;
    const tickDown = () => { if (T.state !== 'reholster') return; if (left <= 0) return start();
      $('beepinfo').textContent = `Reset · rep ${T.drillRes.length + 1} in ${left} s`; left--; T.nextTimer = setTimeout(tickDown, 1000); };
    tickDown(); return;
  }
  window.UI && UI.nextShooter();
  if (T.seriesOn) {                                      // repeat strings: reset, then the next random beep
    const s = summarize(liveShots()); T.series.push({ t: n ? s.total : null, n });
    if (n) setStatus(`String ${T.series.length} · ${n} shot${n > 1 ? 's' : ''} · ${fmt(s.total)}`);
    T.state = 'reholster'; setMain('STOP', 'stop'); let left = S.rangeReset;
    const tickDown = () => { if (T.state !== 'reholster') return; if (left <= 0) return start();
      $('beepinfo').textContent = `Reset… next string in ${left} s`; left--; T.nextTimer = setTimeout(tickDown, 1000); };
    tickDown(); return;
  }
  releaseWake();
}

// ---------- dry fire reps ----------
// trigger: beep → click.   draw: beep → holster snap (reaction) → click (shot).   reload: beep → click → reload → click.
// Draw / reload first shot use ORDER as well as fingerprints (checked on 16 filmed reps): the holster snap always
// comes before the click. A click-like snap with nothing before it is held for up to 1.4 s: if another click-like
// snap follows, the first was the holster. The holster is the loudest snap 0.25–2.0 s before the click.
// With no holster fingerprint at all this times 14/14 filmed reps right (the old rule: 0/14).
const PROMOTE_S = 1.4, MIN_SPLIT = 0.35, MIN_SNAP_S = 0.25, MIN_SHOT_S = 0.5, SLAM_DB = 8;   // filmed holster→click splits: 0.57–1.0 s
function onDrySound(c, j) {
  if (film.on) { filmLog('judged', { t: +c.t.toFixed(4), db: +c.db.toFixed(1), kind: j.kind, score: +j.score.toFixed(3), hol: +j.hol.toFixed(3), reason: j.reason }); camEvent(j.kind ? `${j.kind.toUpperCase()} ${fmt(c.t)}` : `${{ sound: 'not the click', quiet: 'too quiet', double: 'double snap' }[j.reason] || j.reason} ${fmt(c.t)}`, j.kind || 'no'); }
  const rep = T.rep, drill = S.dryDrill;
  const note = (reason) => { T.ignored.push({ t: c.t, db: c.db, score: j.score, reason }); renderShots(); };
  if (!j.kind) return note(j.reason);
  if (drill === 'trigger') return j.kind === 'click' ? acceptShot(c, j.score) : note('holster');
  const timingFirst = !rep.clicks.length;                            // draw shot, or reload shot 1
  // Physically impossible timings (filmed rep: gun still in hand at the beep, a handling click at 0.15 s):
  // nothing under 0.25 s counts, and a draw/first shot under 0.5 s is rejected.
  if (timingFirst && c.t < MIN_SNAP_S) return note('too early');
  if (timingFirst && j.kind === 'click' && c.t < MIN_SHOT_S && !rep.tentative && !rep.snaps.length) return note('too fast');
  if (!timingFirst) {                                                // reload: waiting for shot 2
    // Filmed reload reps: the mag going in is a single snap that sounds just like the click, so shot 2 only counts
    // AFTER the rack — a double snap, a near-simultaneous pair, or the slide slam (much louder than shot 1, never a shot).
    // On 11 filmed reps this takes reload timing from 3/11 to 10/11 correct.
    const s1 = rep.clicks[0];
    if (c.t - s1.t < 0.25) return note('too soon');
    const doublet = T.dryEvents.some((o) => o !== c && Math.abs(o.t - c.t) < 0.08 && Math.abs(o.db - c.db) <= 6);
    if (c.db >= s1.db + SLAM_DB || j.reason === 'double' || doublet) {
      rep.rackT = c.t; T.ignored.push({ t: c.t, reason: 'rack', mark: true }); renderShots(); setStatus(`Racked ${fmt(c.t)} · fire`, 'live'); return;
    }
    if (rep.rackT == null) return note(j.kind ? 'before rack' : (j.reason || 'sound'));
    if (c.t - rep.rackT < 0.25) return note('too soon');
    if (!j.kind) return note(j.reason || 'sound');                     // shot 2 may fingerprint as click or holster
    return acceptShot(c, j.score);
  }
  rep.snaps.push({ t: c.t, db: c.db, kind: j.kind, score: j.score });
  if (j.kind === 'holster') { T.ignored.push({ t: c.t, reason: 'holster?', mark: true }); renderShots(); return; }
  if (rep.tentative && c.t - rep.tentative.t >= MIN_SPLIT) {         // 2nd click-like snap: the 1st was the holster
    clearTimeout(rep.tTimer); rep.holster = rep.tentative; rep.tentative = null; return acceptShot(c, j.score);
  }
  const pri = rep.snaps.filter((p) => p.t < c.t - 0.25 && p.t > c.t - 2.0);
  if (pri.length) { rep.holster = pri.reduce((a, p) => (p.db > a.db ? p : a)); return acceptShot(c, j.score); }
  rep.tentative = { t: c.t, db: c.db, score: j.score };            // nothing before it: maybe this IS the holster
  T.ignored.push({ t: c.t, reason: 'snap…', mark: true }); renderShots();
  clearTimeout(rep.tTimer);
  rep.tTimer = setTimeout(() => { if (T.state === 'live' && rep.tentative) { const tv = rep.tentative; rep.tentative = null; acceptShot(tv, tv.score); } }, PROMOTE_S * 1000);
}
function acceptShot(c, score) {
  const rep = T.rep; rep.clicks.push({ t: c.t, score, db: c.db });
  if (S.dryDrill === 'reload' && rep.clicks.length === 1) {         // first shot: now time the reload
    setStatus(`Shot ${fmt(c.t)} · RELOAD`, 'live'); T.ignored.push({ t: c.t, reason: 'shot 1', mark: true }); renderShots();
    clearTimeout(rep.tTimer); clearTimeout(T.repTimer); T.repTimer = setTimeout(repTimeout, (S.reloadTimeout + ISO_S + 0.1) * 1000);
    return;
  }
  endRep(repResult());
}
function repResult() {
  const rep = T.rep, c1 = rep.clicks[0], c2 = rep.clicks[1];
  if (!c1) return null;
  const react = rep.holster ? rep.holster.t : null;
  return { t: c1.t, score: c1.score, react, split: react != null ? c1.t - react : null, t2: c2 ? c2.t : null, reload: c2 ? c2.t - c1.t : null };
}
function repTimeout() {
  if (T.state !== 'live') return;
  const rep = T.rep; clearTimeout(rep.tTimer);
  if (rep.tentative && !rep.clicks.length) { const tv = rep.tentative; rep.tentative = null; return acceptShot(tv, tv.score); }
  endRep(repResult());
}   // reload with only one shot keeps the shot, no reload time
function endRep(hit) {
  if (film.on) { filmLog('rep', { drill: S.dryDrill, result: hit }); if (hit) camEvent(`REP · shot ${fmt(hit.t)}${hit.react != null ? ` · react ${fmt(hit.react)}` : ''}${hit.reload != null ? ` · reload ${fmt(hit.reload)}` : ''}`, 'rep'); }
  clearTimeout(T.repTimer); if (T.rep) clearTimeout(T.rep.tTimer); audio.node.port.postMessage({ type: 'disarm' });
  for (const o of T.oscs) { try { o.stop(); } catch {} }
  cancelAnimationFrame(T.raf);
  T.series.push(hit ? Object.assign({ drill: S.dryDrill }, hit) : { t: null });
  if (hit) saveDryRep(hit);
  T.state = 'done'; renderStats(); renderShots();
  setStatus(!hit ? 'No click heard' : S.dryDrill === 'reload' ? (hit.reload != null ? `Reload ${fmt(hit.reload)}` : 'No 2nd shot heard') :
    S.dryDrill === 'draw' ? `Shot ${fmt(hit.t)}${hit.react != null ? ` · react ${fmt(hit.react)}` : ''}` : `Draw ${fmt(hit.t)}`, hit ? '' : 'err');
  if (T.seriesOn) {                                    // repeat drill: reholster, then the next random beep
    T.state = 'reholster'; setMain('STOP', 'stop');
    let left = S.dryReholster;
    const tickDown = () => {
      if (T.state !== 'reholster') return;
      if (left <= 0) return start();
      $('beepinfo').textContent = `Reholster… next rep in ${left} s`; left--; T.nextTimer = setTimeout(tickDown, 1000);
    };
    tickDown();
  } else { setMain('START'); releaseWake(); }
}
function drillDone() {
  T.seriesOn = false; T.state = 'done'; setMain('START'); releaseWake();
  const rr = T.drillRes, ok = rr.filter((x) => x.ok).length, vs = rr.map((x) => x.v).filter((v) => v != null);
  setStatus(`${ok} of ${rr.length} under par`);
  if (vs.length) { $('big').textContent = fmt(Math.min(...vs)); $('p-res').textContent = `Best ${fmt(Math.min(...vs))} · avg ${fmt(vs.reduce((a, b) => a + b, 0) / vs.length)}`; $('p-res').className = 'p-res'; }
  $('beepinfo').textContent = 'Press Start to run it again';
  window.UI && (UI.renderPlan(), UI.nextShooter(), UI.renderHub());
}
function stopSeries() {
  if (T.preset) {
    clearTimeout(T.nextTimer); clearTimeout(T.doneTimer); T.seriesOn = false;
    if (T.state === 'standby' || T.state === 'live') { for (const o of T.oscs) { try { o.stop(); } catch {} } audio.node.port.postMessage({ type: 'disarm' }); cancelAnimationFrame(T.raf); }
    if (T.state === 'live' && liveShots().length) autoSaveIfNeeded();
    clearInterval(T.autoTimer); T.state = 'done'; setMain('START'); releaseWake(); $('beepinfo').textContent = '';
    setStatus(T.drillRes.length ? `Stopped after ${T.drillRes.length} of ${T.preset.reps} reps` : 'Ready'); window.UI && UI.renderPlan(); return;
  }
  clearTimeout(T.nextTimer); clearTimeout(T.repTimer); if (T.rep) clearTimeout(T.rep.tTimer); T.seriesOn = false;
  if (T.state === 'standby' || T.state === 'live') {
    for (const o of T.oscs) { try { o.stop(); } catch {} }
    audio.node.port.postMessage({ type: 'disarm' }); cancelAnimationFrame(T.raf);
  }
  if (!isDry()) {
    if (T.state === 'live' && liveShots().length) autoSaveIfNeeded();
    clearInterval(T.autoTimer); T.state = 'done'; setMain('START'); releaseWake(); $('beepinfo').textContent = '';
    const done = T.series.filter((r) => r.n), best = done.length ? Math.min(...done.map((r) => r.t)) : null;
    setStatus(done.length ? `Done · ${done.length} strings · best ${fmt(best)}` : 'Ready'); renderStats(); return;
  }
  T.state = 'done'; setMain('START'); releaseWake();
  const s = drySummary(); setStatus(s.n ? `Drill done · ${s.n} reps · best ${fmt(S.dryDrill === 'reload' ? s.bestReload : s.best)}` : 'Ready'); $('beepinfo').textContent = '';
  renderStats();
}
function drySummary() {
  const ok = T.series.filter((r) => r.t != null), ts = ok.map((r) => r.t), mn = (a) => (a.length ? Math.min(...a) : null);
  const avg = (a) => (a.length ? a.reduce((x, y) => x + y, 0) / a.length : null), last = ok[ok.length - 1] || {};
  const rl = ok.map((r) => r.reload).filter((v) => v != null), rc = ok.map((r) => r.react).filter((v) => v != null);
  return { n: ok.length, misses: T.series.length - ok.length, last: last.t, lastR: last, best: mn(ts), avg: avg(ts),
    bestReload: mn(rl), avgReload: avg(rl), avgReact: avg(rc) };
}
function saveDryRep(hit) {
  const shots = [{ t: +hit.t.toFixed(4) }]; if (hit.t2 != null) shots.push({ t: +hit.t2.toFixed(4) });
  history.unshift(clipTag(tagRecord({ id: Date.now().toString(36) + Math.random().toString(36).slice(2, 5), mode: 'dry', drill: S.dryDrill, at: new Date().toISOString(),
    shooter: S.shooter, gun: S.gun, delay: +T.delay.toFixed(2), acoustic: T.acoustic, match: +hit.score.toFixed(2),
    react: hit.react != null ? +hit.react.toFixed(4) : undefined, reload: hit.reload != null ? +hit.reload.toFixed(4) : undefined, shots })));
  saveHistory(); renderSession();
}
// ---------- dry fire: teach the trigger click (guided) ----------
// 5 rounds: beep → user dry-fires once → we listen ONLY for 2 s after that beep and keep the strongest sound.
// Then "Rack now" while the mic is ignored, so racking the slide can never be learned as the click.
const LEARN_ROUNDS = 5, LEARN_WIN = 2.0, LEARN_GAP = 4000;
async function startLearn(what = 'click') {
  try { await ensureAudio(); } catch { setStatus('Mic blocked', 'err'); return; }
  if (T.state === 'standby' || T.state === 'live' || T.state === 'reholster') stopSeries();
  T.learning = { what, list: [], round: 0, cands: [], beepFrame: null, timers: [] };
  setMain('CANCEL', 'standby'); requestWake(); learnRound();
}
function learnRound() {
  const L = T.learning; if (!L) return;
  L.round++; L.cands = []; L.beepFrame = null;
  const beepAt = audio.ctx.currentTime + 0.8;
  T.oscs = [scheduleBeep(beepAt, S.blen)];
  audio.node.port.postMessage({ type: 'params', params: detParams() });
  audio.node.port.postMessage({ type: 'arm', beepAt, parAt: [], beepMs: S.blen, beepHz: S.hz, latency: latencyEstimate() });
  const hol = L.what === 'holster';
  setStatus(`Teach ${hol ? 'holster' : 'click'} ${L.round} / ${LEARN_ROUNDS}`, 'live'); $('big').textContent = `${L.list.length} / ${LEARN_ROUNDS}`;
  $('beepinfo').textContent = hol ? 'On the beep: DRAW from the holster. Do NOT fire.' : 'On the beep: dry fire ONCE. Don\'t rack yet.';
  L.timers.push(setTimeout(learnRoundEnd, (0.8 + LEARN_WIN + 0.3) * 1000));
}
function learnSound(m) {                               // sound reported while teaching
  T.learning.cands.push({ frame: m.frame, bands: m.bands, db: m.peakDb });   // filtered against the beep at round end
}
function learnRoundEnd() {
  const L = T.learning; if (!L) return;
  audio.node.port.postMessage({ type: 'disarm' });
  const bf = L.beepFrame, win = L.cands.filter((c) => bf != null && c.frame > bf && c.frame - bf <= LEARN_WIN * audio.sr);
  L.cands = win;
  if (win.length) L.list.push(win.reduce((a, c) => (c.db > a.db ? c : a)));    // the click = loudest sound in the window
  $('big').textContent = `${L.list.length} / ${LEARN_ROUNDS}`;
  if (L.round >= LEARN_ROUNDS) return finishLearn();
  const hol = L.what === 'holster';
  setStatus(L.cands.length ? (hol ? 'Got it — reholster now' : 'Got it — rack now') : (hol ? 'Nothing heard — reholster' : 'No click heard — rack and get ready'), 'standby');
  $('beepinfo').textContent = hol ? 'Reholster now, hand at your side or on the gun. Next beep in a few seconds…' : 'Rack / reset the trigger now. Next beep in a few seconds…';
  L.timers.push(setTimeout(learnRound, LEARN_GAP));
}
function finishLearn() {
  const L = T.learning; if (!L) return; L.timers.forEach(clearTimeout); T.learning = null;
  for (const o of T.oscs) { try { o.stop(); } catch {} }
  audio.node.port.postMessage({ type: 'disarm' }); releaseWake(); setMain('START'); $('big').textContent = '0.000';
  const hol = L.what === 'holster', noun = hol ? 'draws' : 'clicks';
  if (L.list.length < 3) { setStatus(`Not enough ${noun}`, 'err'); $('beepinfo').textContent = `Heard ${L.list.length} ${noun}. Try again closer to the phone, or raise Dry fire sensitivity.`; return; }
  const r = buildTemplate(L.list), info = { used: r.used, of: r.of, consistency: +r.consistency.toFixed(2), db: +r.db.toFixed(1), at: new Date().toISOString() };
  if (hol) { S.holTpl = r.tpl; S.holInfo = info; } else { S.clickTpl = r.tpl; S.clickInfo = info; }
  saveSettings();
  setStatus(hol ? 'Holster learned' : 'Click learned'); $('beepinfo').textContent = `Learned from ${r.used} of ${r.of} ${noun} (consistency ${r.consistency.toFixed(2)}).`;
  renderClickInfo();
}
function renderClickInfo() {
  const el = $('click-info'), eh = $('hol-info'); if (!el) return; const c = S.clickInfo, h = S.holInfo;
  el.textContent = S.clickTpl && c ? `Learned ${new Date(c.at).toLocaleDateString()} from ${c.used}/${c.of} clicks · consistency ${c.consistency} · level ${c.db} dB`
    : 'Not learned yet: any sharp sound after the beep will count as the click.';
  if (eh) eh.textContent = S.holTpl && h ? `Learned ${new Date(h.at).toLocaleDateString()} from ${h.used}/${h.of} draws · consistency ${h.consistency}`
    : 'Not learned yet. Needed for Draw / Reload drills (reaction time), and stops the holster snap counting as the click.';
}
function teachMenu() {
  if (T.learning) return finishLearn();
  pick('Teach which sound?', ['Trigger click', 'Holster draw'], '', (v) => startLearn(v === 'Holster draw' ? 'holster' : 'click'));
}

// ---------- training film: camera + the detector's own mic + a log of every decision ----------
// The video records the SAME mic track the detector analyses, so its audio is exactly what the app heard.
// The overlay is live on screen only (burning it into the file would load the phone mid-drill); the JSON log has
// every sound, fingerprint and decision, so the overlay can be rendered onto the video afterwards.
const film = { on: false, cam: null, rec: null, chunks: [], log: null, mime: '', name: '' };
// Clips are written to the phone's storage (IndexedDB) the moment recording stops, so closing the dialog, leaving the
// app or a crash can't lose one. They stay until you delete them (History › session › Clips).
const clipDB = {
  open() { return this.p || (this.p = new Promise((ok, bad) => { const r = indexedDB.open('st-clips', 1); r.onupgradeneeded = () => r.result.createObjectStore('clips', { keyPath: 'name' }); r.onsuccess = () => ok(r.result); r.onerror = () => bad(r.error); })); },
  async tx(mode, fn) { const db = await this.open(); return new Promise((ok, bad) => { const t = db.transaction('clips', mode), st = t.objectStore('clips'); const r = fn(st); t.oncomplete = () => ok(r && r.result); t.onerror = () => bad(t.error); }); },
  put(c) { return this.tx('readwrite', (st) => st.put(c)); },
  get(name) { return this.tx('readonly', (st) => st.get(name)); },
  del(name) { return this.tx('readwrite', (st) => st.delete(name)); },
  async list() { return (await this.tx('readonly', (st) => st.getAll())) || []; },
};
// One name stem per session, shared by its export and its clips: ST-2026-11-14-1431 (session start, local time).
function sessionStem(ses) { const d = ses ? new Date(ses.start) : new Date(), z = (n) => String(n).padStart(2, '0'); return `ST-${d.getFullYear()}-${z(d.getMonth() + 1)}-${z(d.getDate())}-${z(d.getHours())}${z(d.getMinutes())}`; }
function nextClipName() { const ses = sessions.find((x) => x.id === activeSession); const n = ses ? (ses.clips = ses.clips || []).length + 1 : 1; return `${sessionStem(ses)}-clip${n}`; }
// Records made while filming carry the clip's name and where their beep sits in it, so data and video pair up.
function clipTag(r) { if (film.on && film.log && film.log.recStartCtx != null) { r.clip = film.name; r.clipT = +(T.beepAt - film.log.recStartCtx).toFixed(2); } return r; }
function filmLog(type, data) { if (!film.log) return; film.log.events.push(Object.assign({ type, ctx: +(audio.ctx.currentTime).toFixed(4), wall: Date.now() }, data)); }
async function startFilm() {
  try { await ensureAudio(); } catch { setStatus('Mic blocked', 'err'); return; }
  try {
    film.cam = await navigator.mediaDevices.getUserMedia({ video: { facingMode: S.camFacing, width: { ideal: 1280 }, height: { ideal: 720 }, frameRate: { ideal: 30 } }, audio: false });
  } catch (e) { setStatus('Camera blocked', 'err'); $('beepinfo').textContent = 'Allow camera access to film training clips.'; return; }
  const v = $('cam'); v.srcObject = film.cam; v.classList.toggle('mirror', S.camFacing === 'user'); v.play().catch(() => {});
  document.body.classList.add('filming');
  const stream = new MediaStream([...film.cam.getVideoTracks(), ...audio.stream.getAudioTracks()]);
  film.mime = ['video/mp4;codecs=avc1', 'video/mp4', 'video/webm;codecs=vp9,opus', 'video/webm'].find((m) => window.MediaRecorder && MediaRecorder.isTypeSupported && MediaRecorder.isTypeSupported(m)) || '';
  film.chunks = []; film.rec = new MediaRecorder(stream, film.mime ? { mimeType: film.mime, videoBitsPerSecond: 2500000 } : undefined);
  film.rec.ondataavailable = (e) => { if (e.data && e.data.size) film.chunks.push(e.data); };
  film.log = { kind: 'shot-timer-training', version: 1, build: BUILD, created: new Date().toISOString(), sampleRate: audio.sr, ua: navigator.userAgent,
    settings: { mode: S.mode, drill: S.dryDrill, sens: S.sens, drySens: S.drySens, clickMatch: S.clickMatch, beepHz: S.hz, beepMs: S.blen, camFacing: S.camFacing,
      clickTpl: S.clickTpl, clickInfo: S.clickInfo, holTpl: S.holTpl, holInfo: S.holInfo, shooter: S.shooter, gun: S.gun },
    session: activeSession, recStartCtx: null, events: [] };
  film.rec.onstart = () => { film.log.recStartCtx = +audio.ctx.currentTime.toFixed(4); film.log.recStartWall = Date.now(); };
  film.name = nextClipName(); film.log.clip = film.name;
  const ses = sessions.find((x) => x.id === activeSession); if (ses) { ses.clips.push({ name: film.name, start: new Date().toISOString() }); saveSessions(); }
  film.rec.start(1000); film.on = true; renderFilmChip(); camStatus($('status').textContent, '');
}
function stopFilm() {
  if (!film.on) return; film.on = false; renderFilmChip();
  const done = () => {
    try { film.cam.getTracks().forEach((t) => t.stop()); } catch {}
    document.body.classList.remove('filming'); $('cam').srcObject = null;
    const type = (film.mime || 'video/mp4').split(';')[0], ext = type.includes('webm') ? 'webm' : 'mp4';
    film.result = { video: new Blob(film.chunks, { type }), ext, type, log: film.log, name: film.name, session: film.log.session, at: new Date().toISOString(), saved: false };
    const ses = sessions.find((x) => x.id === film.log.session), c = ses && (ses.clips || []).find((x) => x.name === film.name);
    if (c) { c.end = new Date().toISOString(); saveSessions(); }
    film.chunks = []; film.log = null;
    clipDB.put(film.result).then(() => { $('film-kept').textContent = 'Kept on this phone — find it later in History › session.'; })
      .catch(() => { $('film-kept').textContent = 'Could not keep a copy on the phone: save it now.'; });
    showFilmReady();
  };
  if (film.rec && film.rec.state !== 'inactive') { film.rec.onstop = done; film.rec.stop(); } else done();
}
function toggleFilm() { if (film.on) stopFilm(); else startFilm(); }
function renderFilmChip() { const c = $('chip-film'); if (c) { c.classList.toggle('rec', film.on); $('lbl-film').textContent = film.on ? '● REC' : 'Off'; } }
function camStatus(txt, cls) { const o = $('cam-status'); if (o) { o.textContent = txt; o.className = 'cam-status' + (cls ? ' ' + cls : ''); } }
function camEvent(txt, kind) {
  const box = $('cam-events'); if (!box) return;
  const d = document.createElement('div'); d.className = 'cam-ev ' + kind; d.textContent = txt; box.prepend(d);
  while (box.children.length > 3) box.lastChild.remove();
}
function showFilmReady() {
  const r = film.result; if (!r) return;
  const mb = (r.video.size / 1048576).toFixed(1), reps = r.log.events.filter((e) => e.type === 'rep' || e.type === 'string').length;
  $('film-info').textContent = `${r.name}\n${mb} MB video · ${reps} reps/strings · ${r.log.events.filter((e) => e.type === 'sound').length} sounds logged`;
  $('film-dlg').showModal();
}
// Camera roll: the share sheet's "Save Video" (video alone; with the log attached iOS doesn't offer it).
// Files / Dropbox: video + log, keeping the clip's name.
async function shareClip(r, withLog) {
  if (!r) return;
  const files = [new File([r.video], `${r.name}.${r.ext}`, { type: r.type })];
  if (withLog) files.push(new File([JSON.stringify(r.log)], `${r.name}.json`, { type: 'application/json' }));
  try {
    if (navigator.canShare && navigator.canShare({ files })) { await navigator.share({ files, title: r.name }); r.saved = true; clipDB.put(r).catch(() => {}); return; }
  } catch (e) { if (e.name === 'AbortError') return; }
  for (const f of files) { const a = document.createElement('a'); a.href = URL.createObjectURL(f); a.download = f.name; a.click(); }
}
function shareFilm(withLog) { return shareClip(film.result, withLog); }

function onWorklet(m) {
  if (film.on && (m.type === 'shot' || m.type === 'beep')) filmLog(m.type === 'beep' ? 'beep' : 'sound', m.type === 'beep' ? { frame: m.frame, acoustic: m.acoustic, expected: m.expected } : { frame: m.frame, db: +m.peakDb.toFixed(1), bands: m.bands });
  if (m.type === 'level') { micHealth(m.db); return drawMeter(m.db); }
  if (m.type === 'beepdiag') return onBeepDiag(m);
  if (m.type === 'beep' && T.learning) { T.learning.beepFrame = m.frame; return; }
  if (m.type === 'beep' && (T.state === 'standby' || T.state === 'live') && T.beepFrame == null) {
    // The worklet located the beep in the mic stream: that is t=0 for every shot.
    T.beepFrame = m.frame; T.acoustic = m.acoustic;
    const off = ((m.frame - m.expected) / audio.sr * 1000).toFixed(0);
    $('beepinfo').textContent = m.acoustic ? 'Start beep heard by mic — timing from the beep' : 'Beep not heard by mic — using estimated timing';
    const p = T.pending; T.pending = []; for (const q of p) { if (T.state !== 'live') break; addShot(q.frame, q.db, q.bands); }
    return;
  }
  if (m.type === 'shot' && T.learning) return learnSound(m);
  if (m.type === 'shot' && T.state === 'live') {
    if (T.beepFrame == null) T.pending.push({ frame: m.frame, db: m.peakDb, bands: m.bands });   // beep timing not confirmed yet
    else addShot(m.frame, m.peakDb, m.bands);
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
    `Last string ${d.at}: beep ${d.heard ? 'HEARD by mic' : 'NOT heard'}`,
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
function setStatus(txt, cls) { const s = $('status'); s.textContent = txt; s.className = 'p-status' + (cls ? ' ' + cls : ''); document.querySelector('.readout').classList.toggle('go', cls === 'live'); camStatus(txt, cls); }
function setMain(txt, cls) { const b = $('btn-main'); b.textContent = txt; b.className = 'p-btn' + (cls ? ' ' + cls : ''); }

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
  const lab = (ids) => ['k-count', 'k-first', 'k-split', 'k-avg'].forEach((k, i) => { $(k).textContent = ids[i]; });
  if (isDry()) {
    const d = drySummary(), L = d.lastR, live = T.state === 'live', big = (v) => { if (!live) $('big').textContent = v != null ? fmt(v) : '0.000'; };
    const set = (a, b, c, e) => { $('s-count').textContent = a; $('s-first').textContent = b; $('s-split').textContent = c; $('s-avg').textContent = e; };
    if (S.dryDrill === 'draw') { lab(['Shot', 'Reaction', 'Draw→shot', 'Best shot']); big(d.last); set(fmt(L.t), fmt(L.react), fmt(L.split), fmt(d.best)); }
    else if (S.dryDrill === 'reload') { lab(['First shot', 'Reload', 'Best reload', 'Avg reload']); big(L.reload ?? d.last); set(fmt(L.t), fmt(L.reload), fmt(d.bestReload), fmt(d.avgReload)); }
    else { lab(['Draws', 'Last', 'Best', 'Avg']); big(d.last); set(d.n + (d.misses ? ` (+${d.misses} missed)` : ''), fmt(d.last), fmt(d.best), fmt(d.avg)); }
    return;
  }
  lab(['Shots', 'First', 'Split', 'Avg split']);
  const s = summarize(liveShots());
  $('big').textContent = s.count ? fmt(s.total) : '0.000';
  $('s-count').textContent = s.count; $('s-first').textContent = fmt(s.first);
  $('s-split').textContent = fmt(s.splits[s.splits.length - 1]); $('s-avg').textContent = fmt(s.avg);
}
function renderShots() {
  const ol = $('shotlist'); ol.innerHTML = '';
  if (isDry()) {
    if (!T.series.length && !(T.ignored || []).length) return;
    const head = document.createElement('li'); head.className = 'head';
    const dr = S.dryDrill;
    head.innerHTML = `<span>Rep</span><span>${dr === 'reload' ? 'Reload' : dr === 'draw' ? 'Shot' : 'Draw'}</span><span class="sp">${dr === 'reload' ? '1st shot' : dr === 'draw' ? 'React · split' : 'Match'}</span><span></span>`; ol.appendChild(head);
    const why = { sound: 'not the click', quiet: 'too quiet', double: 'double snap', holster: 'holster', 'too soon': 'too soon', 'snap…': 'snap… (holster or shot?)', 'too early': 'too early', 'too fast': 'too fast for a draw', rack: 'RACK', 'before rack': 'before rack (mag?)' };
    for (const q of (T.state === 'live' ? T.ignored : [])) {
      const li = document.createElement('li'); li.className = q.mark ? '' : 'removed';
      li.innerHTML = `<span class="n"></span><span class="t">${fmt(q.t)}</span><span class="sp">${why[q.reason] || q.reason}</span><span></span>`; ol.appendChild(li);
    }
    T.series.slice().reverse().forEach((r, i) => {
      const li = document.createElement('li'); if (r.t == null) li.className = 'removed';
      const main = r.t == null ? 'no click' : r.drill === 'reload' ? (r.reload != null ? fmt(r.reload) : '—') : fmt(r.t);
      const side = r.t == null ? '' : r.drill === 'reload' ? fmt(r.t) : r.drill === 'draw' ? (r.react != null ? `${fmt(r.react)} · ${fmt(r.split)}` : 'no holster') : (r.score != null ? r.score.toFixed(2) : '');
      li.innerHTML = `<span class="n">${T.series.length - i}</span><span class="t">${main}</span><span class="sp">${side}</span><span></span>`;
      ol.appendChild(li);
    });
    return;
  }
  if (!T.shots.length) return;
  const head = document.createElement('li'); head.className = 'head';
  head.innerHTML = '<span>#</span><span>Time</span><span class="sp">Split</span><span></span>'; ol.appendChild(head);
  let prev = null, n = 0;
  T.shots.forEach((s, i) => {
    const li = document.createElement('li'); if (s.removed) li.className = 'removed';
    const split = !s.removed && prev != null ? s.t - prev : null;
    if (!s.removed) { n++; prev = s.t; }
    li.innerHTML = `<span class="n">${s.removed ? '' : n}</span><span class="t">${fmt(s.t)}</span><span class="sp">${s.removed ? (s.auto === 'quiet' ? 'quieter · not yours?' : '') : (n === 1 ? 'draw' : fmt(split))}</span>`;
    const x = document.createElement('button'); x.className = 'x'; x.textContent = s.removed ? '↺' : '×';
    x.title = s.removed ? 'Restore shot' : 'Not a shot — remove';
    x.onclick = () => { s.removed = !s.removed; if (!s.removed) { s.keep = true; delete s.auto; } renderShots(); renderStats(); if (T.saved) updateSaved(); };
    li.appendChild(x); ol.prepend(li);
  });
  ol.prepend(head);
}
let meterMax = -10, meterMin = -70;
function drawMeter(db) {
  const pct = (v) => Math.max(0, Math.min(100, (v - meterMin) / (meterMax - meterMin) * 100));
  const f = $('meter-fill'); f.style.width = pct(db) + '%';
  const thr = isDry() ? drySensToDb(S.drySens) : ShotDetector.sensitivityToDb(S.sens);
  f.classList.toggle('hot', db > thr); $('meter-thr').style.left = pct(thr) + '%';
}

// ---------- history ----------
function autoSaveIfNeeded() {
  if (T.saved || !liveShots().length) return;
  const rec = {
    id: Date.now().toString(36), at: new Date().toISOString(), shooter: S.shooter, gun: S.gun,
    delay: +T.delay.toFixed(2), acoustic: T.acoustic, sens: S.sens,
    shots: T.shots.map((s) => ({ t: +s.t.toFixed(4), db: +s.db.toFixed(1), removed: s.removed || undefined, gated: s.auto === 'quiet' || undefined })), gate: S.gate,
    drillName: T.preset ? T.preset.name : undefined, rep: T.preset ? T.drillRes.length + 1 : undefined, par: presetPar() || null,
  };
  clipTag(rec);
  history.unshift(tagRecord(rec)); saveHistory(); T.saved = rec.id; renderSession();
  $('btn-review').textContent = 'Score…'; $('btn-review').disabled = false; renderHistory();
}
function updateSaved() {
  const r = history.find((h) => h.id === T.saved); if (!r) return;
  r.shots = T.shots.map((s) => ({ t: +s.t.toFixed(4), db: +s.db.toFixed(1), removed: s.removed || undefined, gated: s.auto === 'quiet' || undefined })); saveHistory(); renderHistory();
}
function recShots(r) { return r.shots.filter((s) => !s.removed).map((s) => s.t); }

// ---------- History: one card per session (records from before sessions are grouped by day) ----------
const IC = {
  cam: '<svg class="ic" viewBox="0 0 24 24" aria-hidden="true"><rect x="2.5" y="6.5" width="13" height="11" rx="2.5"/><path d="M15.5 10.5l6-3.5v10l-6-3.5z"/></svg>',
  ok: '<svg class="ic" viewBox="0 0 24 24" aria-hidden="true"><path d="M5 12.5l4.5 4.5L19 7.5"/></svg>',
  no: '<svg class="ic" viewBox="0 0 24 24" aria-hidden="true"><path d="M6.5 6.5l11 11M17.5 6.5l-11 11"/></svg>',
};
const ini = (n) => { const w = String(n || '?').trim().split(/\s+/); return (w[0][0] + (w.length > 1 ? w[w.length - 1][0] : '')).toUpperCase(); };
const minOf = (a) => { a = a.filter((x) => x != null && isFinite(x)); return a.length ? Math.min(...a) : null; };
const dryVal = (r) => (r.drill === 'reload' ? r.reload : recShots(r)[0]);
let histFilter = 'all', openSes = null, sesWho = null;
function histGroups() {
  const out = [], byId = {};
  for (const ses of sessions) { const g = { id: ses.id, ses, recs: [], start: ses.start, end: ses.end }; byId[ses.id] = g; out.push(g); }
  for (const r of history) {
    if (r.session && byId[r.session]) { byId[r.session].recs.push(r); continue; }
    const k = `day:${r.at.slice(0, 10)}:${r.mode === 'dry' ? 'dry' : 'range'}`;
    if (!byId[k]) { byId[k] = { id: k, ses: null, recs: [], start: r.at, end: r.at }; out.push(byId[k]); }
    const g = byId[k]; g.recs.push(r); if (r.at < g.start) g.start = r.at; if (r.at > g.end) g.end = r.at;
  }
  for (const g of out) {
    const range = g.recs.filter((r) => r.mode !== 'dry');
    g.kind = range.length ? 'range' : g.recs.length ? 'dry' : (g.ses && /^dry/i.test(g.ses.name) ? 'dry' : 'range');
  }
  return out.filter((g) => g.recs.length || (g.ses && (g.ses.id === activeSession || (g.ses.clips || []).length))).sort((x, y) => (y.start < x.start ? -1 : 1));
}
function groupStats(g) {
  if (g.kind === 'range') {
    const sums = g.recs.filter((r) => r.mode !== 'dry').map((r) => summarize(recShots(r))).filter((q) => q.count);
    return { best: minOf(sums.map((q) => q.first)), bestL: 'Best first', n: sums.length, nL: 'Strings', shots: sums.reduce((a, q) => a + q.count, 0), split: minOf(sums.flatMap((q) => q.splits)) };
  }
  const recs = g.recs.filter((r) => r.mode === 'dry');
  return { best: minOf(recs.map(dryVal)), bestL: 'Best draw', n: recs.length, nL: 'Reps', shots: recs.reduce((a, r) => a + recShots(r).length, 0) };
}
const dayStr = (iso, o) => new Date(iso).toLocaleDateString(undefined, o || { weekday: 'short', month: 'short', day: 'numeric' });
const numS = (v) => (v == null ? '—' : `${v.toFixed(2)}<small>s</small>`);
function renderHistory() {
  if (!$('hs-body')) return;
  const mine = history.filter((h) => h.shooter === S.shooter);
  const rs = mine.filter((h) => h.mode !== 'dry').map((h) => ({ h, q: summarize(recShots(h)) })).filter((x) => x.q.count);
  const bestOf = (arr, f) => { let b = null; for (const x of arr) { const v = f(x); if (v != null && isFinite(v) && (!b || v < b.v)) b = { v, at: x.h.at }; } return b; };
  const bf = bestOf(rs, (x) => x.q.first), bs = bestOf(rs, (x) => minOf(x.q.splits)), bd = bestOf(mine.filter((h) => h.mode === 'dry' && h.drill !== 'reload').map((h) => ({ h })), (x) => recShots(x.h)[0]);
  const cell = (k, b, w) => `<div><i>${k}</i><b>${b ? numS(b.v) : '—'}</b><em>${b ? `${w} · ${dayStr(b.at, { month: 'short', day: 'numeric' })}` : '&nbsp;'}</em></div>`;
  $('hs-best').innerHTML = cell('Best first shot', bf, 'Range') + cell('Best split', bs, 'Range') + cell('Best dry draw', bd, 'Dry');
  $('hs-best').hidden = !history.length;
  document.querySelectorAll('.hs-pills button').forEach((b) => b.classList.toggle('on', b.dataset.f === histFilter));
  const all = histGroups(), live = all.find((g) => g.id === activeSession);
  $('hs-live').hidden = !live;
  if (live) { $('hs-live-t').textContent = `${live.kind === 'dry' ? 'Dry fire' : 'Range'} · today`; const st = groupStats(live); $('hs-live-s').textContent = `In progress · ${st.n} ${st.nL.toLowerCase()}`; }
  const list = all.filter((g) => g !== live && (histFilter === 'all' || g.kind === histFilter));
  const body = $('hs-body'); body.innerHTML = '';
  if (!list.length) { body.innerHTML = `<p class="p-hint" style="text-align:center;margin:24px 0">${history.length ? 'Nothing here for this filter.' : 'No sessions yet. Start one from Train.'}</p>`; return; }
  let month = '', box = null;
  for (const g of list) {
    const m = new Date(g.start).toLocaleDateString(undefined, { month: 'long', year: new Date(g.start).getFullYear() === new Date().getFullYear() ? undefined : 'numeric' });
    if (m !== month) { month = m; body.insertAdjacentHTML('beforeend', `<div class="hs-month">${esc(m)}</div>`); box = document.createElement('div'); box.className = 'hs-list'; body.appendChild(box); }
    const st = groupStats(g), who = [...new Set(g.recs.map((r) => r.shooter))], clips = g.ses ? (g.ses.clips || []).length : 0;
    const whoH = g.kind === 'range' && (who.length || clips) ? `<span class="hs-who">${who.map((w) => `<span title="${esc(w)}">${esc(ini(w))}</span>`).join('')}${clips ? `<span class="hs-film">${IC.cam}${clips}</span>` : ''}</span>` : '';
    const c = document.createElement('div'); c.className = 'hs-card';
    c.innerHTML = `<button class="hs-del" aria-label="Delete session">Delete</button>
      <button class="hs-ses"><div class="hs-top"><span class="hs-ic ${g.kind}"></span><b>${g.kind === 'dry' ? 'Dry fire' : 'Range'}</b><i>${dayStr(g.start)}</i>${whoH}<span class="hs-chev">›</span></div>
      <div class="hs-stats"><div><i>${st.bestL}</i><b>${numS(st.best)}</b></div><div><i>${st.nL}</i><b>${st.n}</b></div><div><i>Shots</i><b>${st.shots}</b></div></div></button>`;
    swipeRow(c, () => openSession(g.id), () => deleteGroup(g));
    box.appendChild(c);
  }
}
// swipe a card left to show Delete; a long swipe asks straight away; a tap opens it
function swipeRow(c, onTap, onDel) {
  const row = c.querySelector('.hs-ses'); let x0 = null, y0 = 0, dx = 0, open = false, moved = false, lock = null;
  const set = (v) => { row.style.transform = v ? `translateX(${v}px)` : ''; };
  row.addEventListener('pointerdown', (e) => { x0 = e.clientX; y0 = e.clientY; dx = 0; moved = false; lock = null; c.classList.add('drag'); });
  row.addEventListener('pointermove', (e) => {
    if (x0 == null) return; const ax = Math.abs(e.clientX - x0), ay = Math.abs(e.clientY - y0);
    if (!lock && (ax > 8 || ay > 8)) { lock = ax > ay ? 'x' : 'y'; if (lock === 'x') try { row.setPointerCapture(e.pointerId); } catch (er) {} }
    if (lock !== 'x') return; moved = true; dx = e.clientX - x0 + (open ? -84 : 0); set(Math.max(-140, Math.min(0, dx)));
  });
  const up = () => {
    if (x0 == null) return; x0 = null; c.classList.remove('drag');
    if (lock === 'y') return;
    if (!moved) { if (open) { open = false; set(0); } else onTap(); return; }
    if (dx < -120) { set(0); open = false; onDel(); return; }
    open = dx < -42; set(open ? -84 : 0);
  };
  row.addEventListener('pointerup', up); row.addEventListener('pointercancel', () => { x0 = null; c.classList.remove('drag'); set(open ? -84 : 0); });
  c.querySelector('.hs-del').onclick = (e) => { e.stopPropagation(); onDel(); };
}
function deleteGroup(g) {
  const st = groupStats(g);
  if (!confirm(`Delete this ${g.kind === 'dry' ? 'dry fire' : 'range'} session from ${dayStr(g.start)} and its ${st.n} ${st.nL.toLowerCase()}? This cannot be undone.`)) { renderHistory(); return; }
  const ids = new Set(g.recs);
  history = history.filter((h) => !ids.has(h));
  if (g.ses) { sessions = sessions.filter((x) => x !== g.ses); if (activeSession === g.ses.id) activeSession = null; }
  saveHistory(); saveSessions(); renderSession(); renderHistory();
  if (screen === 'session') showScreen('history');
}
function esc(s) { return String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c])); }

function csvOf(records) {
  const rows = [['date', 'session', 'mode', 'shooter', 'gun', 'shot', 'time_s', 'split_s', 'reaction_s', 'reload_s', 'par_s', 'delay_s', 'sens', 'click_match']];
  for (const r of records.slice().reverse()) recShots(r).forEach((t, i, a) => rows.push([r.at, r.session ? (sessions.find((x) => x.id === r.session) || {}).name || r.session : '',
    r.mode === 'dry' ? 'dry-' + (r.drill || 'trigger') : 'range', r.shooter, r.gun, i + 1, t.toFixed(4), i ? (t - a[i - 1]).toFixed(4) : '',
    i === 0 && r.react != null ? r.react.toFixed(4) : '', i === 1 && r.reload != null ? r.reload.toFixed(4) : '', r.par || '', r.delay,
    r.cfg ? (r.mode === 'dry' ? r.cfg.drySens : r.cfg.sens) : '', r.cfg && r.mode === 'dry' ? r.cfg.clickMatch : '']));
  return rows.map((r) => r.map((v) => /[",\n]/.test(String(v)) ? `"${String(v).replace(/"/g, '""')}"` : v).join(',')).join('\n');
}
async function shareFiles(files) {
  try { if (navigator.canShare && navigator.canShare({ files })) { await navigator.share({ files }); return; } } catch (e) { if (e.name === 'AbortError') return; }
  for (const f of files) { const a = document.createElement('a'); a.href = URL.createObjectURL(f); a.download = f.name; a.click(); }
}
function exportCsv() { shareFiles([new File([csvOf(history)], `shot-timer-all-${new Date().toISOString().slice(0, 10)}.csv`, { type: 'text/csv' })]); }

// ---------- sessions: everything between Start and End is tagged, and exported on its own ----------
function startSession(auto) {
  const d = new Date(), def = `${d.toLocaleDateString(undefined, { month: 'short', day: 'numeric' })} ${d.toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' })}`;
  const name = auto ? `${auto} · ${def}` : (prompt('Session name', def) || '').trim(); if (!name) return;
  const ses = { id: 's' + Date.now().toString(36), name, start: d.toISOString(), end: null, cfgStart: cfgSnap(), clips: [] };
  sessions.unshift(ses); activeSession = ses.id; saveSessions(); renderSession();
}
function endSession() {
  const ses = sessions.find((x) => x.id === activeSession); activeSession = null;
  if (ses) { ses.end = new Date().toISOString(); ses.cfgEnd = cfgSnap(); }
  if (ses && !sessionRecs(ses.id).length && !(ses.clips || []).length) sessions = sessions.filter((x) => x !== ses);   // nothing saved: drop it quietly
  saveSessions(); renderSession(); renderHistory();
  if (ses && sessions.includes(ses)) { $('ses-dlg-info').textContent = `${ses.name}\n${sessionLine(ses)}`; $('ses-dlg').dataset.id = ses.id; $('ses-dlg').showModal(); }
}
function sessionRecs(id) { return history.filter((h) => h.session === id); }
function sessionLine(ses) {
  const recs = sessionRecs(ses.id), dry = recs.filter((r) => r.mode === 'dry').length;
  const mins = ses.end ? Math.round((new Date(ses.end) - new Date(ses.start)) / 60000) : null;
  return `${recs.length - dry} range strings · ${dry} dry reps${mins != null ? ` · ${mins} min` : ''}`;
}
function exportSession(id) {
  const ses = sessions.find((x) => x.id === id); if (!ses) return;
  const recs = sessionRecs(id), base = `${sessionStem(ses)}-session`;
  const json = { kind: 'shot-timer-session', version: 1, build: BUILD, session: ses, records: recs };
  shareFiles([new File([csvOf(recs)], base + '.csv', { type: 'text/csv' }), new File([JSON.stringify(json, null, 1)], base + '.json', { type: 'application/json' })]);
}
// Session detail: strings grouped by drill, shooter filter, tap a string for its splits.
async function openSession(id) {
  const g = histGroups().find((x) => x.id === id) || (sessions.some((x) => x.id === id) ? { id, ses: sessions.find((x) => x.id === id), recs: [], start: sessions.find((x) => x.id === id).start, kind: 'range' } : null);
  if (!g) return;
  if (openSes !== id) sesWho = null; openSes = id;
  const st = groupStats(g), recs = g.recs.slice().reverse(), d0 = new Date(g.start), d1 = g.ses ? (g.ses.end ? new Date(g.ses.end) : g.ses.id === activeSession ? new Date() : new Date(g.end || g.start)) : new Date(g.end);
  const tm = (d) => d.toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' }), mins = Math.max(0, Math.round((d1 - d0) / 60000));
  $('ses-title-h').textContent = `${g.kind === 'dry' ? 'Dry fire' : 'Range'} · ${dayStr(g.start, { month: 'short', day: 'numeric' })}`;
  $('hd-sub').textContent = `${dayStr(g.start, { weekday: 'short' })} · ${tm(d0)}${mins ? ` – ${tm(d1)} · ${mins >= 60 ? `${Math.floor(mins / 60)} h ${mins % 60} m` : `${mins} min`}` : ''}${g.ses && g.ses.id === activeSession ? ' · in progress' : ''}`;
  const sv = (v) => (v == null ? '—' : v.toFixed(2)), f2 = (v) => (v == null ? '—' : v.toFixed(2));
  $('hd-stats').innerHTML = g.kind === 'range'
    ? `<div><i>Strings</i><b>${st.n}</b></div><div><i>Shots</i><b>${st.shots}</b></div><div><i>Best first</i><b>${sv(st.best)}</b></div><div><i>Best split</i><b>${sv(st.split)}</b></div>`
    : `<div><i>Reps</i><b>${st.n}</b></div><div><i>Shots</i><b>${st.shots}</b></div><div><i>Best draw</i><b>${sv(minOf(recs.filter((r) => r.drill !== 'reload').map(dryVal)))}</b></div><div><i>Best reload</i><b>${sv(minOf(recs.filter((r) => r.drill === 'reload').map((r) => r.reload)))}</b></div>`;
  const main = (r) => (r.mode === 'dry' ? dryVal(r) : summarize(recShots(r)).total);
  const first = (r) => (r.mode === 'dry' ? dryVal(r) : summarize(recShots(r)).first);
  const who = [...new Set(recs.map((r) => r.shooter))];
  const W = $('hd-who'); W.hidden = who.length < 2; W.innerHTML = '';
  if (who.length > 1) {
    const mk = (name) => { const b = document.createElement('button'); b.className = sesWho === name ? 'on' : '';
      b.innerHTML = name == null ? 'All' : `<span>${esc(ini(name))}</span>${sv(minOf(recs.filter((r) => r.shooter === name).map(first)))}`; if (name == null) b.className = sesWho == null ? 'on' : '';
      b.onclick = () => { sesWho = name; openSession(id); }; W.appendChild(b); };
    mk(null); who.forEach(mk);
  }
  const shown = recs.filter((r) => sesWho == null || r.shooter === sesWho);
  const groups = []; const gi = {};
  for (const r of shown) { const k = r.mode === 'dry' ? ({ draw: 'Draw', reload: 'Reload' }[r.drill] || 'Trigger') : (r.drillName || 'Free shooting'); if (!gi[k]) { gi[k] = { name: k, recs: [] }; groups.push(gi[k]); } gi[k].recs.push(r); }
  const box = $('hd-body'); box.innerHTML = shown.length ? '' : '<p class="p-hint" style="text-align:center;margin:20px 0">Nothing saved in this session yet.</p>';
  for (const grp of groups) {
    const par = grp.recs.find((r) => r.par)?.par, n = grp.recs.length;
    const under = par ? grp.recs.filter((r) => main(r) != null && main(r) <= par).length : 0;
    const nShots = grp.recs[0].mode === 'dry' ? null : recShots(grp.recs[0]).length;
    const sub = grp.recs[0].mode === 'dry' ? `${n} rep${n === 1 ? '' : 's'}` : par ? `${nShots} shots · par ${par.toFixed(2)}` : 'no par';
    const right = par ? `${under} / ${n} under par` : `${n} ${grp.recs[0].mode === 'dry' ? (n === 1 ? 'rep' : 'reps') : (n === 1 ? 'string' : 'strings')}`;
    const el = document.createElement('div'); el.className = 'hd-drill';
    el.innerHTML = `<div class="hd-dh"><b>${esc(grp.name)}</b><i>${sub}</i><span class="hd-par">${right}</span></div>`;
    grp.recs.forEach((r, i) => {
      const v = main(r), ok = par && v != null ? v <= par : null, q = r.mode === 'dry' ? null : summarize(recShots(r));
      const side = r.mode === 'dry' ? (r.drill === 'draw' && r.react != null ? `react ${f2(r.react)}` : '') : r.score && r.score.hf != null ? `HF ${r.score.hf.toFixed(1)}` : par ? '—' : `${q.count} shot${q.count === 1 ? '' : 's'}`;
      const row = document.createElement('button'); row.className = 'hd-str';
      row.innerHTML = `<span class="hd-n">${i + 1}</span><span class="hd-i" title="${esc(r.shooter)}">${esc(ini(r.shooter))}</span><b>${v == null ? '—' : f2(v)}</b><span class="${ok == null ? '' : ok ? 'hd-ok' : 'hd-no'}">${ok == null ? '' : ok ? IC.ok : IC.no}</span><span class="hd-hf">${side}</span><span class="hd-cl">${r.clip ? IC.cam : ''}</span>`;
      const sp = document.createElement('div'); sp.className = 'hd-splits';
      let det;
      if (r.mode === 'dry') det = r.drill === 'reload' ? `First ${f2(recShots(r)[0])} · reload ${f2(r.reload)}` : r.drill === 'draw' ? `Shot ${f2(recShots(r)[0])}${r.react != null ? ` · reaction ${f2(r.react)} · draw ${f2(r.split)}` : ''}` : `Click ${f2(recShots(r)[0])}`;
      else { const t = recShots(r); det = t.map((x, j) => (j ? f2(x - t[j - 1]) : `${r.drillName ? 'Draw' : 'First'} ${f2(x)}`)).join(' · '); }
      const sc = r.score ? `${r.score.points} pts · ${Object.entries(r.score.hits || {}).map(([tg, z]) => `T${tg} ` + Object.entries(z).filter(([, c]) => c).map(([k, c]) => `${c} ${k}`).join(' ')).join(' · ')}` : (r.mode !== 'dry' && r.drillName ? 'Not scored' : '');
      const clip = r.clip ? `Clip ${esc(r.clip.replace(/^.*-/, ''))} @ ${Math.floor(r.clipT / 60)}:${String(Math.floor(r.clipT % 60)).padStart(2, '0')}` : '';
      sp.innerHTML = `${det}<br><span>${[new Date(r.at).toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' }), esc(r.gun || ''), sc, clip].filter(Boolean).join(' · ')}</span><button class="hd-x">Delete string</button>`;
      sp.querySelector('.hd-x').onclick = () => { if (confirm('Delete this string?')) { history = history.filter((h) => h !== r); saveHistory(); renderHistory(); openSession(id); } };
      row.onclick = () => row.classList.toggle('open');
      if (i >= 5) { row.hidden = true; sp.dataset.more = '1'; }
      el.append(row, sp);
    });
    if (n > 5) { const m = document.createElement('button'); m.className = 'hd-more'; m.textContent = `+ ${n - 5} more ${grp.recs[0].mode === 'dry' ? 'reps' : par ? 'reps' : 'strings'}`;
      m.onclick = () => { el.querySelectorAll('.hd-str[hidden]').forEach((x) => (x.hidden = false)); m.remove(); }; el.appendChild(m); }
    box.appendChild(el);
  }
  const clips = g.ses ? g.ses.clips || [] : [], kept = (await clipDB.list().catch(() => [])).filter((k) => clips.some((c) => c.name === k.name));
  if (kept.length) {
    const el = document.createElement('div'); el.className = 'hd-drill';
    el.innerHTML = `<div class="hd-dh"><b>Clips</b><i>kept on this phone</i><span class="hd-par">${kept.length}</span></div>` + kept.map((k) => `<div class="hd-clip"><span class="hd-cl">${IC.cam}</span><div><b>${esc(k.name.replace(/^.*-/, ''))}</b><i>${(k.video.size / 1048576).toFixed(0)} MB · ${k.saved ? 'saved' : 'not saved anywhere yet'}</i></div><button data-roll="${esc(k.name)}">Save</button><button data-delclip="${esc(k.name)}">Delete</button></div>`).join('');
    el.querySelectorAll('[data-roll]').forEach((b) => b.onclick = async () => shareClip(await clipDB.get(b.dataset.roll), false).then(() => openSession(id)));
    el.querySelectorAll('[data-delclip]').forEach((b) => b.onclick = async () => { if (confirm(`Delete ${b.dataset.delclip} from this phone? Only do this once it's saved somewhere.`)) { await clipDB.del(b.dataset.delclip); openSession(id); } });
    box.appendChild(el);
  }
  $('ses-exp').onclick = () => (g.ses ? exportSession(g.ses.id) : shareFiles([new File([csvOf(g.recs)], `shot-timer-${g.start.slice(0, 10)}-${g.kind}.csv`, { type: 'text/csv' })]));
  $('ses-clips').hidden = !kept.length;
  $('ses-clips').onclick = async () => {
    const files = kept.map((k) => new File([k.video], `${k.name}.${k.ext}`, { type: k.type }));
    try { if (navigator.canShare && navigator.canShare({ files })) { await navigator.share({ files }); for (const k of kept) { k.saved = true; clipDB.put(k).catch(() => {}); } openSession(id); return; } } catch (e) { if (e.name === 'AbortError') return; }
    for (const k of kept) await shareClip(k, false);
  };
  $('ses-del').onclick = () => deleteGroup(g);
  if (screen !== 'session') showScreen('session');
}
// Clips not shared anywhere yet: a reminder on the home screen.
async function clipReminder() {
  const el = $('clip-note'); if (!el) return;
  const list = (await clipDB.list().catch(() => [])).filter((c) => !c.saved);
  el.hidden = !list.length;
  if (list.length) { el.textContent = `${list.length} clip${list.length > 1 ? 's' : ''} kept on this phone, not saved anywhere yet — tap to see`; el.onclick = () => (list[0].session && sessions.some((x) => x.id === list[0].session) ? openSession(list[0].session) : showScreen('history')); }
}
function renderSession() {
  const el = $('ses-text'); if (!el) return;
  const ses = sessions.find((x) => x.id === activeSession);
  el.textContent = ses ? `● session · ${sessionRecs(ses.id).length} saved` : '';
}
// ---------- menus: Home → (Range | Dry fire → Trigger/Draw/Reload) → drill. Entering a drill starts a session; Back ends it.
const DRILL_NAMES = { range: 'Free shooting', trigger: 'Dry fire · Trigger', draw: 'Dry fire · Draw', reload: 'Dry fire · Reload' };
let screen = 'home';
function showScreen(v) {
  screen = v;
  document.querySelectorAll('.view').forEach((el) => el.classList.toggle('active', el.id === 'view-' + v));
  const train = ['home', 'drymenu', 'range', 'editor', 'timer'].includes(v);
  if (v === 'home') clipReminder();
  if (train) lastTrain = v;
  if (window.UI) UI.onScreen(v);
  document.querySelectorAll('.tab').forEach((el) => el.classList.toggle('active', train ? el.dataset.view === 'train' : el.dataset.view === (v === 'session' ? 'history' : v)));
  if (v === 'history') renderHistory();
}
let lastTrain = 'home';
// Enter the timer: free shooting (preset null), a drill from the Range screen, or a dry-fire drill.
function enterDrill(mode, drill, preset) {
  if (drill) S.dryDrill = drill;
  T.preset = mode === 'range' && preset ? preset : null; T.drillRes = [];
  setMode(mode); saveSettings();
  $('drill-title').textContent = T.preset ? T.preset.name : DRILL_NAMES[mode === 'dry' ? S.dryDrill : 'range'];
  $('seg-rep').style.visibility = T.preset ? 'hidden' : 'visible';
  $('p-plan').hidden = !T.preset; $('p-res').textContent = presetPar() > 0 ? `Par ${presetPar().toFixed(2)} s` : '';
  if (!activeSession) startSession(mode === 'dry' ? 'Dry fire' : 'Range');
  window.UI && (UI.renderPlan(), UI.gauge(0), UI.parMark(presetPar() || null));
  renderSession(); renderChips(); showScreen('timer');
}
// Back from the timer: the session keeps going (one session per trip); only End on the Range / Dry fire screen ends it.
function leaveDrill() {
  if (T.learning) finishLearn();
  if ((isDry() || T.seriesOn || T.preset) && ['standby', 'live', 'reholster'].includes(T.state)) stopSeries();
  else if (T.state === 'standby') cancel(); else if (T.state === 'live') stop();
  const back = isDry() ? 'drymenu' : 'range';
  const finish = () => showScreen(back);
  if (film.on) { $('film-dlg').addEventListener('close', finish, { once: true }); stopFilm(); } else finish();
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
const toast = (t) => { const h = $('toast-host'); if (!h) return; h.innerHTML = ''; const d = document.createElement('div'); d.className = 'toast'; d.textContent = t; h.appendChild(d); clearTimeout(toast.t); toast.t = setTimeout(() => { h.innerHTML = ''; }, 1800); };

// ---------- settings form ----------
const NUMS = { 'set-gate': 'gate', 'set-rreset': 'rangeReset', 'set-rlto': 'reloadTimeout', 'set-dsens': 'drySens', 'set-rehol': 'dryReholster', 'set-rtime': 'dryTimeout', 'set-match': 'clickMatch', 'set-dmin': 'dmin', 'set-dmax': 'dmax', 'set-hz': 'hz', 'set-blen': 'blen', 'set-par': 'par', 'set-echo': 'echo', 'set-lock': 'lock', 'set-auto': 'auto', 'set-sens': 'sens' };
function bindSettings() {
  for (const [id, k] of Object.entries(NUMS)) {
    const el = $(id); el.value = S[k];
    el.addEventListener('input', () => {
      const v = parseFloat(el.value); if (!isFinite(v)) return; S[k] = v; saveSettings();
      if (k === 'sens') $('lbl-sens').textContent = v;
      if (k === 'drySens') $('lbl-dsens').textContent = v;
      if (k === 'clickMatch') $('lbl-match').textContent = v.toFixed(2);
      if (audio.node) audio.node.port.postMessage({ type: 'params', params: detParams() });
    });
  }
  $('lbl-sens').textContent = S.sens; $('lbl-dsens').textContent = S.drySens; $('lbl-match').textContent = S.clickMatch.toFixed(2);
  $('btn-learn2').onclick = () => { enterDrill('dry'); startLearn('click'); };
  $('btn-learn-hol').onclick = () => { enterDrill('dry'); startLearn('holster'); }; renderClickInfo();
  const lines = (el) => el.value.split('\n').map((s) => s.trim()).filter(Boolean);
  $('set-shooters').value = S.shooters.join('\n'); $('set-guns').value = S.guns.join('\n');
  $('set-shooters').addEventListener('change', (e) => { S.shooters = lines(e.target); if (!S.shooters.includes(S.shooter)) S.shooter = S.shooters[0] || ''; saveSettings(); renderChips(); });
  $('set-guns').addEventListener('change', (e) => { S.guns = lines(e.target); if (!S.guns.includes(S.gun)) S.gun = S.guns[0] || ''; saveSettings(); renderChips(); });
  $('btn-clear').onclick = () => { if (confirm('Delete ALL saved strings? This cannot be undone.')) { history = []; saveHistory(); renderHistory(); } };
  $('file-test').addEventListener('change', analyzeFile);
  const am = $('set-audiomode'); am.value = S.audioMode;
  am.addEventListener('change', () => { S.audioMode = am.value; saveSettings(); $('audiomode-note').textContent = 'Close and reopen the app for this to take effect.'; });
  $('btn-diag-share').onclick = shareDiag; renderDiag();
  $('build').textContent = `Build ${BUILD}`; const hb = $('home-build'); if (hb) hb.textContent = BUILD;
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

function setMode(m) {
  if (T.learning || ['standby', 'live', 'reholster'].includes(T.state)) return;     // not mid-string
  S.mode = m; saveSettings(); T.state = 'idle'; T.series = []; T.shots = []; T.ignored = [];
  document.querySelectorAll('#seg-mode button').forEach((b) => b.classList.toggle('on', b.dataset.mode === m));
  document.querySelectorAll('#seg-rep button').forEach((b) => b.classList.toggle('on', (b.dataset.rep === 'repeat') === repeatOn()));
  document.querySelectorAll('#seg-drill button').forEach((b) => b.classList.toggle('on', b.dataset.drill === S.dryDrill));
  document.body.classList.toggle('dry', m === 'dry');
  $('btn-review').textContent = m === 'dry' ? 'Teach…' : 'Score…'; $('btn-review').disabled = m !== 'dry';
  const need = !S.clickTpl ? 'teach your trigger click first' : (S.dryDrill !== 'trigger' && !S.holTpl) ? 'teach your holster draw first' : '';
  setStatus(m === 'dry' ? (need ? `Dry fire · ${need}` : `Dry fire · ${{ trigger: 'trigger', draw: 'draw', reload: 'reload' }[S.dryDrill]} · ready`) : `Range · listening for gunshots${S.rangeRepeat ? ' · repeat' : ''}`); $('beepinfo').textContent = '';
  if (audio.node) audio.node.port.postMessage({ type: 'params', params: detParams() });
  renderShots(); renderStats(); drawMeter(-120);
}
function showView(v) {
  if (v === 'train') return showScreen(lastTrain);
  if (['home', 'drymenu', 'range', 'editor', 'timer', 'history', 'settings'].includes(v)) return showScreen(v);
  document.querySelectorAll('.view').forEach((el) => el.classList.toggle('active', el.id === 'view-' + v));
  document.querySelectorAll('.tab').forEach((el) => el.classList.toggle('active', el.dataset.view === v));
  if (v === 'history') renderHistory();
}

document.addEventListener('DOMContentLoaded', () => {
  $('btn-main').onclick = onMain;
  $('btn-review').onclick = () => (isDry() ? teachMenu() : (autoSaveIfNeeded(), window.UI && UI.openScore()));
  document.querySelectorAll('#seg-drill button').forEach((b) => b.onclick = () => { if (['standby', 'live', 'reholster'].includes(T.state) || T.learning) return; S.dryDrill = b.dataset.drill; saveSettings(); setMode('dry'); });
  document.querySelectorAll('#seg-mode button').forEach((b) => b.onclick = () => setMode(b.dataset.mode));
  // Single/Repeat belongs to the CURRENT mode. (v0.6 switched to dry fire here, so Range + Repeat listened for clicks.)
  document.querySelectorAll('#seg-rep button').forEach((b) => b.onclick = () => { if (T.state === 'standby' || T.state === 'live' || T.state === 'reholster') return; const on = b.dataset.rep === 'repeat'; if (isDry()) S.dryRepeat = on; else S.rangeRepeat = on; saveSettings(); setMode(S.mode); });
  $('btn-export').onclick = exportCsv;
  document.querySelectorAll('[data-drill]').forEach((b) => b.onclick = () => enterDrill('dry', b.dataset.drill));
  document.querySelectorAll('[data-back]').forEach((b) => b.onclick = () => showScreen(b.dataset.back));
  $('btn-back').onclick = leaveDrill;
  $('btn-ses-export').onclick = (e) => { e.preventDefault(); exportSession($('ses-dlg').dataset.id); };
  $('btn-ses-close').onclick = () => $('ses-dlg').close(); renderSession();
  $('chip-film').onclick = toggleFilm;
  $('btn-film-roll').onclick = (e) => { e.preventDefault(); shareFilm(false); };
  $('btn-film-share').onclick = (e) => { e.preventDefault(); shareFilm(true); };
  $('btn-film-close').onclick = () => { film.result = null; $('film-dlg').close(); };
  $('ses-back').onclick = () => showScreen('history');
  document.querySelectorAll('.hs-pills button').forEach((b) => b.onclick = () => { histFilter = b.dataset.f; renderHistory(); });
  $('hs-live').onclick = () => { const g = histGroups().find((x) => x.id === activeSession); showScreen(g && g.kind === 'dry' ? 'drymenu' : 'range'); };
  const cf = $('set-cam'); cf.value = S.camFacing; cf.onchange = () => { S.camFacing = cf.value; saveSettings(); };
  $('chip-shooter').onclick = () => pick('Shooter', S.shooters, S.shooter, (v) => { S.shooter = v; saveSettings(); renderChips(); });
  $('chip-gun').onclick = () => pick('Gun', S.guns, S.gun, (v) => { S.gun = v; saveSettings(); renderChips(); });
  document.querySelectorAll('.tab').forEach((b) => b.onclick = () => showView(b.dataset.view));
  // one session per trip: a session survives the app being closed or reloaded at the range; one left open for more
  // than 8 hours is closed now (its reps stay), and an empty one is dropped
  if (activeSession) { const ses = sessions.find((x) => x.id === activeSession), last = ses ? Math.max(new Date(ses.start), ...sessionRecs(ses.id).map((r) => new Date(r.at))) : 0;
    if (!ses || Date.now() - last > 8 * 3600e3) { if (ses) { ses.end = ses.end || new Date().toISOString(); if (!sessionRecs(ses.id).length) sessions = sessions.filter((x) => x !== ses); } activeSession = null; saveSessions(); } }
  bindSettings(); renderChips(); setMode(S.mode); renderHistory(); showScreen('home');
  document.addEventListener('visibilitychange', () => { if (!document.hidden && audio.ctx && audio.ctx.state !== 'running') audio.ctx.resume(); });
  if ('serviceWorker' in navigator && location.protocol === 'https:') navigator.serviceWorker.register('sw.js').catch(() => {});
});
