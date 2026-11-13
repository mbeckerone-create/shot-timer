/* AudioWorklet: runs ShotDetector + BeepFinder on the raw mic stream, sample-accurate.
 * Frames are counted on the INPUT stream, so beep and shots share one clock.
 * Around each start beep it also captures the raw mic audio and sends it back for diagnostics. */
const WIN_BEFORE = 0.15, WIN_AFTER = 1.0;          // beep search window around the expected frame (s)
const CAP_AFTER = 2.0, CAP_MAX = 16;              // diagnostic capture: from START press until 2 s after the expected beep
class ShotTimerProcessor extends AudioWorkletProcessor {
  constructor() {
    super();
    this.det = new ShotDetector(sampleRate);
    this.det.onShot = (s) => this.port.postMessage({ type: 'shot', frame: s.frame, peakDb: s.peakDb });
    this.beep = null; this.beepMeta = null; this.offset = null; this.q = 0; this.cap = null;
    this.port.onmessage = (e) => this.onMsg(e.data);
    this.port.postMessage({ type: 'ready', sampleRate });
  }
  onMsg(m) {
    if (m.type === 'params') this.det.setParams(m.params);
    else if (m.type === 'arm') {
      // m.beepAt / m.parAt are AudioContext times (s); convert to expected INPUT frames.
      const toInput = (t) => Math.round(t * sampleRate) - this.offset + Math.round(m.latency * sampleRate);
      const len = Math.round(m.beepMs / 1000 * sampleRate), pad = Math.round(0.15 * sampleRate);
      const exp = toInput(m.beepAt);
      const ranges = [[-Infinity, exp + len + pad]];
      for (const t of m.parAt || []) { const e = toInput(t); ranges.push([e - pad, e + len + pad]); }
      this.det.setBlank(ranges);
      this.beep = new ShotDetector.BeepFinder(sampleRate, m.beepHz);
      this.beep.window(exp - Math.round(WIN_BEFORE * sampleRate), exp + Math.round(WIN_AFTER * sampleRate));
      this.beepMeta = { exp, len, pad, ranges, hz: m.beepHz, latency: m.latency };
      const c0 = this.det.frame, c1 = Math.min(exp + Math.round(CAP_AFTER * sampleRate), c0 + CAP_MAX * sampleRate);
      this.cap = { from: c0, buf: new Float32Array(Math.max(1, c1 - c0)), sent: false, found: null, acoustic: false };
    } else if (m.type === 'disarm') { this.beep = null; this.det.setBlank([[-Infinity, Infinity]]); }
  }
  capture(ch, start) {
    const c = this.cap; if (!c || c.sent) return;
    for (let k = 0; k < ch.length; k++) { const i = start + k - c.from; if (i >= 0 && i < c.buf.length) c.buf[i] = ch[k]; }
    if (start + ch.length >= c.from + c.buf.length) {
      c.sent = true;
      this.port.postMessage({ type: 'beepdiag', buf: c.buf, from: c.from, exp: this.beepMeta.exp, found: c.found, acoustic: c.acoustic,
        hz: this.beepMeta.hz, latency: this.beepMeta.latency, sampleRate, offset: this.offset, beepLen: this.beepMeta.len,
        best: this.bestStats || null, foundDb: c.foundDb ?? null }, [c.buf.buffer]);
    }
  }
  process(inputs) {
    const ch = inputs[0] && inputs[0][0];
    if (!ch) return true;
    if (this.offset === null) this.offset = currentFrame - this.det.frame;
    const start = this.det.frame;
    if (this.beep) {
      const f = this.beep.process(ch, start);
      if (f !== null) {
        const r = this.beepMeta.ranges; r[0][1] = Math.max(r[0][1], f + this.beepMeta.len + this.beepMeta.pad);
        if (this.cap) { this.cap.found = f; this.cap.acoustic = true; this.cap.foundDb = this.beep.foundDb; }
        this.bestStats = this.beep.best;
        this.port.postMessage({ type: 'beep', frame: f, acoustic: true, expected: this.beepMeta.exp }); this.beep = null;
      } else if (start > this.beepMeta.exp + WIN_AFTER * sampleRate) {
        if (this.cap) this.cap.found = this.beepMeta.exp;
        this.bestStats = this.beep.best;
        this.port.postMessage({ type: 'beep', frame: this.beepMeta.exp, acoustic: false, expected: this.beepMeta.exp }); this.beep = null;
      }
    }
    this.capture(ch, start);
    this.det.process(ch);
    if (++this.q >= 12) { this.q = 0; this.port.postMessage({ type: 'level', db: this.det.levelAndReset(), frame: this.det.frame }); }
    return true;
  }
}
registerProcessor('shot-timer', ShotTimerProcessor);
