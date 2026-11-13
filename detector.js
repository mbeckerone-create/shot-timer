/* ShotDetector — streaming gunshot onset detector.
 * Same algorithm as analysis/detect2.py (reference). Feed raw mono samples in any chunk size;
 * shots are reported with a sample-accurate frame index on the input stream.
 *
 * Per 1 ms block: energy of a 2 kHz high-pass (rejects wind/handling rumble) and full-band energy.
 * A block arms when HP energy exceeds the adaptive floor by armDb. Over the next confirmMs the
 * loudest block is found; it is a shot if it is louder than shotDb AND mostly high-frequency
 * (hpFracDb). The onset is backtracked from that peak to where the burst began, so a bullet crack
 * or tiny precursor still times the shot from its very first sound. After a shot the detector is
 * locked for lockMs, and anything within echoMs that is echoDb quieter than the shot is an echo.
 */
(function (root) {
  const DEFAULTS = {
    hpHz: 2000, armDb: 15, shotDb: -26, hpFracDb: -9, confirmMs: 70, lockMs: 100,
    notchHz: null, floorMs: 300, echoMs: 180, echoDb: 6, backMs: 60, backDb: 20, tonal: 0.6, tonalGapMs: 60,
  };
  const RING = 4096;            // blocks of history (~4 s)
  const SRING = 1 << 15;        // samples of HP history (~0.68 s @48k)

  function fft(re, im) {          // in-place radix-2
    const n = re.length;
    for (let i = 1, j = 0; i < n; i++) { let bit = n >> 1; for (; j & bit; bit >>= 1) j ^= bit; j ^= bit; if (i < j) { [re[i], re[j]] = [re[j], re[i]]; [im[i], im[j]] = [im[j], im[i]]; } }
    for (let len = 2; len <= n; len <<= 1) {
      const ang = -2 * Math.PI / len, wr = Math.cos(ang), wi = Math.sin(ang);
      for (let i = 0; i < n; i += len) {
        let cr = 1, ci = 0;
        for (let k = 0; k < len / 2; k++) {
          const ar = re[i + k + len / 2] * cr - im[i + k + len / 2] * ci, ai = re[i + k + len / 2] * ci + im[i + k + len / 2] * cr;
          re[i + k + len / 2] = re[i + k] - ar; im[i + k + len / 2] = im[i + k] - ai; re[i + k] += ar; im[i + k] += ai;
          const t = cr * wr - ci * wi; ci = cr * wi + ci * wr; cr = t;
        }
      }
    }
  }
  class ShotDetector {
    constructor(sampleRate, params = {}) {
      this.sr = sampleRate; this.p = Object.assign({}, DEFAULTS, params);
      this.B = Math.max(1, Math.round(sampleRate / 1000));
      this._biquad(this.p.hpHz); this._notch(this.p.notchHz);
      this.x1 = this.x2 = this.y1 = this.y2 = 0;
      this.dh = new Float64Array(RING); this.eh = new Float64Array(RING); this.ef = new Float64Array(RING);
      this.hp = new Float32Array(SRING);
      this.frame = 0;               // total samples consumed
      this.nb = 0;                  // complete blocks
      this.accH = 0; this.accF = 0; this.accN = 0;
      this.i = 1; this.lock = 0; this.floor = null; this.shots = [];
      this.blankRanges = [];        // [[fromFrame,toFrame],...] shots with onset inside are ignored (our own beeps)
      this.onShot = null; this.onLevel = null;
      this.peakSinceReport = -120;
    }
    setParams(p) { Object.assign(this.p, p); if (p.hpHz) this._biquad(p.hpHz); if ('notchHz' in p) this._notch(p.notchHz); }
    // Narrow notch at our own beep pitch so the detector can keep listening WHILE the beep plays
    // (a reaction shot can land inside the beep). Off (null) by default.
    _notch(hz) {
      if (!hz) { this.nt = null; return; }
      const w0 = 2 * Math.PI * hz / this.sr, a = Math.sin(w0) / (2 * 3), c = Math.cos(w0), a0 = 1 + a;
      this.nt = { b0: 1 / a0, b1: -2 * c / a0, b2: 1 / a0, a1: -2 * c / a0, a2: (1 - a) / a0, x1: 0, x2: 0, y1: 0, y2: 0 };
      this.ntf = Object.assign({}, this.nt);   // same notch on the full-band path (the 'mostly high-frequency' test)
    }
    reset() { this.shots = []; this.lastShot = null; }
    setBlank(ranges) { this.blankRanges = ranges; }
    _blanked(f) { for (const r of this.blankRanges) if (f >= r[0] && f <= r[1]) return true; return false; }
    _biquad(fc) {
      const w0 = 2 * Math.PI * fc / this.sr, a = Math.sin(w0) / (2 * Math.SQRT1_2), c = Math.cos(w0), a0 = 1 + a;
      this.b0 = (1 + c) / 2 / a0; this.b1 = -(1 + c) / a0; this.b2 = (1 + c) / 2 / a0;
      this.a1 = -2 * c / a0; this.a2 = (1 - a) / a0;
    }
    process(buf) {
      const B = this.B;
      for (let n = 0; n < buf.length; n++) {
        const x = buf[n];
        let y = this.b0 * x + this.b1 * this.x1 + this.b2 * this.x2 - this.a1 * this.y1 - this.a2 * this.y2;
        this.x2 = this.x1; this.x1 = x; this.y2 = this.y1; this.y1 = y;
        const nt = this.nt;
        let xf = x;
        if (nt) {
          const z = nt.b0 * y + nt.b1 * nt.x1 + nt.b2 * nt.x2 - nt.a1 * nt.y1 - nt.a2 * nt.y2; nt.x2 = nt.x1; nt.x1 = y; nt.y2 = nt.y1; nt.y1 = z; y = z;
          const q = this.ntf, zf = q.b0 * x + q.b1 * q.x1 + q.b2 * q.x2 - q.a1 * q.y1 - q.a2 * q.y2; q.x2 = q.x1; q.x1 = x; q.y2 = q.y1; q.y1 = zf; xf = zf;
        }
        this.hp[this.frame & (SRING - 1)] = y; this.frame++;
        this.accH += y * y; this.accF += xf * xf;
        if (++this.accN === B) {
          const k = this.nb & (RING - 1);
          this.eh[k] = this.accH / B + 1e-14; this.ef[k] = this.accF / B + 1e-14;
          this.dh[k] = 10 * Math.log10(this.eh[k]);
          if (this.dh[k] > this.peakSinceReport) this.peakSinceReport = this.dh[k];
          this.nb++; this.accH = this.accF = 0; this.accN = 0;
        }
      }
      this._scan();
    }
    // Fraction of 1.5–16 kHz energy in the 3 strongest FFT bins (1024-pt, Hann) around sample c. ~1 for a beep, ~0.16 for a shot.
    _top3(c) {
      const n = 1024, re = this._re || (this._re = new Float64Array(n)), im = this._im || (this._im = new Float64Array(n));
      for (let k = 0; k < n; k++) { re[k] = this.hp[(c - n / 4 + k) & (SRING - 1)] * (0.5 - 0.5 * Math.cos(2 * Math.PI * k / (n - 1))); im[k] = 0; }
      fft(re, im);
      let tot = 0, a = 0, b = 0, d = 0;
      for (let k = 0; k <= n / 2; k++) {
        const f = k * this.sr / n; if (f < 1500 || f > 16000) continue;
        const pw = re[k] * re[k] + im[k] * im[k] + 1e-20; tot += pw;
        if (pw > a) { d = b; b = a; a = pw; } else if (pw > b) { d = b; b = pw; } else if (pw > d) d = pw;
      }
      return (a + b + d) / tot;
    }
    levelAndReset() { const v = this.peakSinceReport; this.peakSinceReport = -120; return v; }
    _d(i) { return this.dh[i & (RING - 1)]; }
    _scan() {
      const p = this.p;
      if (this.floor === null) {           // initial floor: median of first floorMs blocks
        if (this.nb < p.floorMs) return;
        const a = []; for (let k = 0; k < p.floorMs; k++) a.push(this._d(k));
        a.sort((u, v) => u - v); this.floor = a[a.length >> 1];
      }
      const alpha = 1 / p.floorMs, C = p.confirmMs;
      while (this.i < this.nb - C - 3 - 90) {      // 90 ms extra look-ahead for the tone check
        const i = this.i, d = this._d(i);
        if (i >= this.lock && d > this.floor + p.armDb) {
          let pk = 0, pv = -1e9;
          for (let m = 0; m < C; m++) { const v = this._d(i + m); if (v > pv) { pv = v; pk = m; } }
          const j = i + pk;
          let sh = 0, sf = 0;
          for (let m = j - 2; m <= j + 2; m++) { sh += this.eh[m & (RING - 1)]; sf += this.ef[m & (RING - 1)]; }
          const hpf = 10 * Math.log10(sh / sf);
          if (pv > p.shotDb && hpf > p.hpFracDb) {
            let k = j;
            while (k > 1 && j - k < p.backMs && this._d(k - 1) > pv - p.backDb) k--;
            const thr = Math.max(4 * Math.sqrt(Math.pow(10, this.floor / 10)), Math.sqrt(Math.pow(10, (pv - p.backDb) / 10)));
            const s0 = (k - 1) * this.B, s1 = (j + 1) * this.B; let on = s0;
            for (let s = s0; s < s1; s++) { if (Math.abs(this.hp[s & (SRING - 1)]) > thr) { on = s; break; } }
            this.lock = j + p.lockMs; this.i = this.lock;
            let pks = on, pa = 0; const n70 = Math.round(0.07 * this.sr);
            for (let s = on; s < on + n70; s++) { const a = Math.abs(this.hp[s & (SRING - 1)]); if (a > pa) { pa = a; pks = s; } }
            const g = Math.round(p.tonalGapMs * this.sr / 1000);
            if (this._top3(pks) > p.tonal && (this._top3(pks + g) > p.tonal || this._top3(pks - g) > p.tonal)) continue;  // sustained tone = a beep
            const last = this.shots[this.shots.length - 1];
            const isEcho = last && (on - last.frame) < p.echoMs * this.sr / 1000 && pv < last.peakDb - p.echoDb;
            if (!isEcho && !this._blanked(on)) {
              const shot = { frame: on, peakDb: pv, hpFracDb: hpf };
              this.shots.push(shot); if (this.onShot) this.onShot(shot);
            }
            continue;
          }
          this.i++; continue;
        }
        if (i >= this.lock) this.floor += alpha * (Math.min(d, this.floor + 6) - this.floor);
        this.i++;
      }
    }
  }
  /* BeepFinder — finds the onset of our own start beep in the mic stream.
   * Timing the string from the beep *as heard by the mic* cancels the phone's output+input latency,
   * because shots and beep then share one clock: input sample frames.
   * Signal is high-passed at 200 Hz (rumble/handling can't win), then a Goertzel filter over 10 ms blocks
   * listens only within about ±50 Hz of the beep pitch. Three tonal blocks in a row = beep; the onset is then
   * refined to the first sample of the tone. */
  class BeepFinder {
    constructor(sampleRate, hz) {
      this.sr = sampleRate; this.hz = hz; this.N = Math.round(sampleRate / 100);    // 10 ms blocks ≈ 100 Hz wide bin
      this.coef = 2 * Math.cos(2 * Math.PI * hz / sampleRate);
      // neighbour bands: a real tone stands out from them, a broadband bang or rumble does not
      this.nc = [-600, -300, 300, 600].map((d) => 2 * Math.cos(2 * Math.PI * (hz + d) / sampleRate)); this.ns1 = [0, 0, 0, 0]; this.ns2 = [0, 0, 0, 0];
      const w0 = 2 * Math.PI * 200 / sampleRate, al = Math.sin(w0) / (2 * Math.SQRT1_2), c = Math.cos(w0), a0 = 1 + al;
      this.hb = [(1 + c) / 2 / a0, -(1 + c) / a0, (1 + c) / 2 / a0, -2 * c / a0, (1 - al) / a0];
      this.hx1 = this.hx2 = this.hy1 = this.hy2 = 0;
      // narrow band-pass at the beep pitch (Q=4), used only to pin the onset; its group delay is subtracted
      const Q = 4, w1 = 2 * Math.PI * hz / sampleRate, al1 = Math.sin(w1) / (2 * Q), c1 = Math.cos(w1), a01 = 1 + al1;
      this.bb = [al1 / a01, 0, -al1 / a01, -2 * c1 / a01, (1 - al1) / a01];
      this.bx1 = this.bx2 = this.by1 = this.by2 = 0; this.bpDelay = Math.round(2 * Q / w1);   // samples
      this.bring = new Float32Array(8192);
      this.from = Infinity; this.to = -Infinity; this.found = null; this.foundDb = null; this.run = 0; this.runStart = 0;
      this.s1 = this.s2 = this.en = 0; this.n = 0; this.blockStart = 0;
      this.ring = new Float32Array(8192); this.best = { ratio: 0, toneDb: -120, frame: 0 }; this.bandDb = null;
    }
    window(fromFrame, toFrame) { this.from = fromFrame; this.to = toFrame; this.found = null; this.run = 0; }
    process(buf, startFrame) {
      const [b0, b1, b2, a1, a2] = this.hb, N = this.N;
      for (let k = 0; k < buf.length; k++) {
        const f = startFrame + k, xin = buf[k];
        const x = b0 * xin + b1 * this.hx1 + b2 * this.hx2 - a1 * this.hy1 - a2 * this.hy2;
        this.hx2 = this.hx1; this.hx1 = xin; this.hy2 = this.hy1; this.hy1 = x;
        this.ring[f & 8191] = x;
        const [c0, c1, c2, d1, d2] = this.bb, yb = c0 * xin + c1 * this.bx1 + c2 * this.bx2 - d1 * this.by1 - d2 * this.by2;
        this.bx2 = this.bx1; this.bx1 = xin; this.by2 = this.by1; this.by1 = yb; this.bring[f & 8191] = yb;
        if (this.n === 0) this.blockStart = f;
        const s0 = x + this.coef * this.s1 - this.s2; this.s2 = this.s1; this.s1 = s0; this.en += x * x;
        for (let j = 0; j < 4; j++) { const t = x + this.nc[j] * this.ns1[j] - this.ns2[j]; this.ns2[j] = this.ns1[j]; this.ns1[j] = t; }
        if (++this.n === N) {
          const pw = this.s1 * this.s1 + this.s2 * this.s2 - this.coef * this.s1 * this.s2;
          const ratio = pw / (N / 2 * this.en + 1e-20);                 // 1.0 = all energy is our tone
          const toneDb = 10 * Math.log10(pw / (N * N / 4) + 1e-14);      // level of the tone itself (dBFS, ~amplitude²)
          const inWin = this.blockStart >= this.from && this.blockStart <= this.to;
          let nb = -200;
          for (let j = 0; j < 4; j++) { const a = this.ns1[j], b = this.ns2[j]; nb = Math.max(nb, 10 * Math.log10((a * a + b * b - this.nc[j] * a * b) / (N * N / 4) + 1e-14)); this.ns1[j] = this.ns2[j] = 0; }
          const contrast = toneDb - nb;                                 // dB above the loudest neighbour band
          if (this.bandDb === null) this.bandDb = toneDb;
          const snr = toneDb - this.bandDb;                            // tone vs this band's own background
          if (inWin && toneDb > this.best.toneDb) this.best = { ratio, toneDb, snr, contrast, frame: this.blockStart };
          if (this.found === null && inWin && snr > 15 && contrast > 10 && toneDb > -100) {
            if (this.run++ === 0) this.runStart = this.blockStart;
            if (this.run >= 3) {          // refine to the first sample of the tone (sample-accurate)
              let amp = 0; for (let q = f - N + 1; q <= f; q++) amp = Math.max(amp, Math.abs(this.bring[q & 8191]));
              let on = this.runStart; for (let q = this.runStart - N; q <= f; q++) if (Math.abs(this.bring[q & 8191]) > 0.25 * amp) { on = q; break; }
              // minus band-pass delay, minus 0.75 ms: the app's beep fades in over 3 ms and the 25% threshold is crossed 0.75 ms in
              this.found = on - this.bpDelay - Math.round(0.00075 * this.sr); this.foundDb = toneDb;
            }
          } else {
            this.run = 0;
            if (this.found === null) this.bandDb += 0.05 * (Math.min(toneDb, this.bandDb + 6) - this.bandDb);   // track band background
          }
          this.s1 = this.s2 = this.en = 0; this.n = 0;
        }
      }
      return this.found;
    }
  }
  ShotDetector.BeepFinder = BeepFinder;
  ShotDetector.fft = fft;
  ShotDetector.DEFAULTS = DEFAULTS;
  // Sensitivity 1..10 -> absolute shot threshold (10 = most sensitive)
  ShotDetector.sensitivityToDb = (s) => -14 - (s - 1) * 3;   // 1:-14dB … 5:-26dB … 10:-41dB
  root.ShotDetector = ShotDetector;
  if (typeof module !== 'undefined') module.exports = ShotDetector;
})(typeof globalThis !== 'undefined' ? globalThis : this);
