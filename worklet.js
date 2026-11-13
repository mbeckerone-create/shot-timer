/* AudioWorklet: runs ShotDetector + BeepFinder on the raw mic stream, sample-accurate.
 * Frames are counted on the INPUT stream, so beep and shots share one clock. */
class ShotTimerProcessor extends AudioWorkletProcessor {
  constructor() {
    super();
    this.det = new ShotDetector(sampleRate);
    this.det.onShot = (s) => this.port.postMessage({ type: 'shot', frame: s.frame, peakDb: s.peakDb });
    this.beep = null; this.beepMeta = null; this.offset = null; this.q = 0;
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
      this.beep.window(exp - Math.round(0.08 * sampleRate), exp + Math.round(0.6 * sampleRate));
      this.beepMeta = { exp, len, pad, ranges };
    } else if (m.type === 'disarm') { this.beep = null; this.det.setBlank([[-Infinity, Infinity]]); }
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
        this.port.postMessage({ type: 'beep', frame: f, acoustic: true, expected: this.beepMeta.exp }); this.beep = null;
      } else if (start > this.beepMeta.exp + 0.6 * sampleRate) {
        this.port.postMessage({ type: 'beep', frame: this.beepMeta.exp, acoustic: false, expected: this.beepMeta.exp }); this.beep = null;
      }
    }
    this.det.process(ch);
    if (++this.q >= 12) { this.q = 0; this.port.postMessage({ type: 'level', db: this.det.levelAndReset(), frame: this.det.frame }); }
    return true;
  }
}
registerProcessor('shot-timer', ShotTimerProcessor);
