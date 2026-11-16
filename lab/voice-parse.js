// Voice → drill / score. Pure text rules, runs on the phone: the iPhone keyboard's dictation (or the Web Speech API)
// turns speech into text, these functions turn the text into a drill or a set of hits. No server, no AI.
(function (root) {
  const NUM = { zero: 0, one: 1, won: 1, two: 2, too: 2, three: 3, four: 4, for: 4, five: 5, six: 6, seven: 7, eight: 8, ate: 8, nine: 9, ten: 10,
    eleven: 11, twelve: 12, thirteen: 13, fourteen: 14, fifteen: 15, sixteen: 16, seventeen: 17, eighteen: 18, nineteen: 19, twenty: 20,
    twentyfive: 25, thirty: 30, forty: 40, fifty: 50, single: 1, once: 1, twice: 2, double: 2, doubles: 2, pair: 2 };
  // "to/for/won/ate" only count as numbers right before a shot/zone/target word, so "transition to target 2" stays intact
  const SOFT = new Set(['to', 'too', 'for', 'won', 'ate']);
  function norm(text) {
    let s = ' ' + String(text || '').toLowerCase().replace(/[’']/g, '').replace(/(\d),(\d)/g, '$1.$2') + ' ';
    s = s.replace(/[,;:!?]+/g, ' , ').replace(/\.(?!\d)/g, ' , ').replace(/-/g, ' ');
    s = s.replace(/\b(twenty|thirty|forty|fifty)\s+(one|two|three|four|five|six|seven|eight|nine)\b/g, (m, a, b) => String(NUM[a] + NUM[b]));
    s = s.replace(/\b(zero|one|two|three|four|five|six|seven|eight|nine|ten|eleven|twelve|thirteen|fourteen|fifteen|sixteen|seventeen|eighteen|nineteen|twenty|thirty|forty|fifty)\b/g, (m) => String(NUM[m]));
    s = s.replace(/\b(\d+) and a half\b/g, (m, a) => String(+a + 0.5)).replace(/\b(\d+) point (\d+)\b/g, '$1.$2').replace(/\b(a )?half\b/g, '0.5');
    s = s.replace(/\bt\s*(\d+)\b/g, 'target $1');                                  // "t1" / "T 2"
    return s.split(/\s+/).filter(Boolean);
  }
  function numAt(tok, i, nextOk) {
    const w = tok[i]; if (w == null) return null;
    if (/^\d+(\.\d+)?$/.test(w)) return +w;
    if (SOFT.has(w)) return nextOk && nextOk(tok[i + 1]) ? NUM[w] ?? (w === 'to' ? 2 : null) : null;
    return w in NUM ? NUM[w] : null;
  }
  const isShotWord = (w) => /^(shots?|rounds?|rds?|hits?|times?)$/.test(w || '');
  const ZONE = { a: 'A', alpha: 'A', alphas: 'A', as: 'A', b: 'B', bravo: 'B', bravos: 'B', bs: 'B', c: 'C', charlie: 'C', charlies: 'C', cs: 'C', see: 'C', sea: 'C',
    d: 'D', delta: 'D', deltas: 'D', ds: 'D', m: 'M', mike: 'M', mikes: 'M', miss: 'M', misses: 'M', missed: 'M', ns: 'NS', noshoot: 'NS', noshoots: 'NS' };

  // ---------- drill ----------
  // "From the holster, 2 shots on target 1, transition, 2 on target 2, reload, 2 on target 1. 5 reps under 5 seconds,
  //  6 second reset. Target 1 at 7 yards, target 2 at 10 yards."   → {start, steps, reps, par, reset, targets, name}
  function parseDrill(text) {
    const t = norm(text.replace(/\bno[\s-]?shoots?\b/gi, 'noshoot')), heard = [], d = { steps: [], targets: {} };
    const has = (re) => re.test(' ' + t.join(' ') + ' ');
    if (has(/ low ready /)) d.start = 'low ready'; else if (has(/ (holster|holstered|draw|draws) /)) d.start = 'holster'; else if (has(/ (ready|high ready|from ready) /)) d.start = 'ready';
    if (d.start) heard.push(`start: ${d.start}`);
    let lastTarget = null;
    for (let i = 0; i < t.length; i++) {
      const w = t[i];
      // name: "call it X" / "named X" / "name X"
      if ((w === 'call' && t[i + 1] === 'it') || w === 'named' || (w === 'name' && t[i + 1] !== ',')) {
        const s = i + (w === 'call' ? 2 : 1); const nm = []; for (let k = s; k < t.length && t[k] !== ','; k++) nm.push(t[k]);
        if (nm.length) { d.name = nm.join(' ').replace(/\b\w/g, (c) => c.toUpperCase()); heard.push(`name: ${d.name}`); i = s + nm.length; continue; }
      }
      if (/^(reload|reloads|reloading|mag)$/.test(w) && !(t[i - 1] === 'no')) { d.steps.push({ reload: true }); heard.push('reload'); continue; }
      // "target 2 at 10 yards" / "target 2 is 10 yards" / "10 yard target 2"
      if (w === 'target' || w === 'targets') {
        const n = numAt(t, i + 1); if (n == null) continue;
        let j = i + 2; if (/^(at|is|@|set|from)$/.test(t[j])) j++;
        const dist = numAt(t, j), unit = t[j + 1] || '';
        if (dist != null && /^(yards?|yds?|yd|meters?|metres?|m|feet|foot|ft)$/.test(unit)) {
          const yd = /^(meters?|metres?|m)$/.test(unit) ? Math.round(dist * 1.094) : /^(feet|foot|ft)$/.test(unit) ? Math.max(1, Math.round(dist / 3)) : dist;
          d.targets[n] = yd; heard.push(`target ${n}: ${yd} yd`); i = j + 1; continue;
        }
        lastTarget = n; continue;
      }
      // "under 5 seconds" / "par 4.5" / "in 3 secs" / "within 5"
      if (/^(under|par|in|within|below)$/.test(w)) {
        let j = i + 1; if (/^(time|of|a)$/.test(t[j])) j++; if (t[j] === 'of') j++;
        const v = numAt(t, j); const unit = t[j + 1] || '';
        if (v != null && (w === 'par' || w === 'under' || w === 'within' || /^(s|sec|secs|second|seconds)$/.test(unit))) {
          if (!/^(reset|rest|between)$/.test(t[j + 2] || '')) { d.par = v; heard.push(`par ${v} s`); i = j + 1; continue; }
        }
      }
      // "6 second reset" / "reset 6" / "6 seconds between"
      if (/^(reset|rest)$/.test(w)) { const v = numAt(t, i + 1) ?? numAt(t, i + 2); if (v != null) { d.reset = v; heard.push(`reset ${v} s`); continue; } }
      const n = numAt(t, i, (nx) => isShotWord(nx) || nx === 'on' || nx === 'at');
      if (n == null) continue;
      const nx = t[i + 1] || '', nx2 = t[i + 2] || '';
      if (/^(s|sec|secs|second|seconds)$/.test(nx) && /^(reset|rest|between|break|pause)$/.test(nx2)) { d.reset = n; heard.push(`reset ${n} s`); i += 2; continue; }
      if (/^(reps?|repetitions?|rounds?|sets?|strings?)$/.test(nx) && !/^(on|at)$/.test(nx2) || (nx === 'times' && !/^(on|at)$/.test(nx2))) {
        if (nx === 'rounds' && d.steps.length === 0 && !/^(in|of)$/.test(nx2)) { /* "6 rounds" with no shots yet = shots */ }
        else { d.reps = n; heard.push(`${n} reps`); i += 1; continue; }
      }
      if (/^(yards?|yds?|yd|meters?|m|feet|ft)$/.test(nx)) { const tg = lastTarget ?? 1; d.targets[tg] = n; heard.push(`target ${tg}: ${n} yd`); i++; continue; }
      // shots: "2 shots on target 1" / "2 on target 2" / "2 shots" / "6 rounds"
      let j = i + 1; if (isShotWord(t[j])) j++;
      let tg = null;
      if (/^(on|at|to|into)$/.test(t[j]) && t[j + 1] === 'target') { tg = numAt(t, j + 2); j += 3; }
      else if (t[j] === 'target') { tg = numAt(t, j + 1); j += 2; }
      if (tg != null || isShotWord(t[i + 1])) {
        if (n > 0 && n <= 30) { tg = tg ?? lastTarget ?? 1; d.steps.push({ n, t: String(tg) }); lastTarget = tg; heard.push(`${n} on T${tg}`); i = j - 1; }
      }
    }
    return { drill: d, heard };
  }

  // ---------- score ----------
  // "2 alpha on target 1, 1 bravo 1 alpha on target 2" / "target 1 two alphas, target 2 alpha charlie" / "all alphas"
  function parseScore(text, shotsByTarget) {
    const t = norm(text.replace(/\bno[\s-]?shoots?\b/gi, 'noshoot').replace(/\b([abcd])\s*zones?\b/gi, '$1')), hits = {}, heard = [];
    const add = (tg, z, n) => { tg = String(tg); hits[tg] = hits[tg] || {}; hits[tg][z] = (hits[tg][z] || 0) + n; };
    if (/^(all )?(alphas?|as|a s)( all)?$/.test(t.filter((w) => w !== ',').join(' ')) && shotsByTarget) {
      for (const [tg, n] of Object.entries(shotsByTarget)) add(tg, 'A', n);
      return { hits, heard: ['all A'] };
    }
    let pending = [], cur = null;
    const flush = (tg) => { for (const [z, n] of pending) add(tg, z, n); pending = []; };
    for (let i = 0; i < t.length; i++) {
      const w = t[i];
      if (/^(on|at|for)$/.test(w) && t[i + 1] === 'target') { const n = numAt(t, i + 2); if (n != null) { flush(n); cur = n; i += 2; continue; } }
      if (w === 'target') { const n = numAt(t, i + 1); if (n != null) { if (pending.length) flush(cur ?? n); cur = n; i++; continue; } }
      if (w === ',' || w === 'and' || w === 'then') continue;
      const n = numAt(t, i, (nx) => nx in ZONE);
      if (n != null && t[i + 1] in ZONE) { const z = ZONE[t[i + 1]]; (cur != null && !lookaheadOn(t, i + 2) ? add.bind(null, cur) : (zz, nn) => pending.push([zz, nn]))(z, n); heard.push(`${n}${z}`); i++; continue; }
      if (w in ZONE && w.length > 1) { const z = ZONE[w]; (cur != null && !lookaheadOn(t, i + 1) ? add.bind(null, cur) : (zz, nn) => pending.push([zz, nn]))(z, 1); heard.push(`1${z}`); continue; }
    }
    if (pending.length) flush(cur ?? 1);
    return { hits, heard };
  }
  // true when the hits just read are followed (before the next number+zone) by "on target N": they belong to N
  function lookaheadOn(t, i) {
    for (let k = i; k < Math.min(t.length, i + 12); k++) {
      if (/^(on|at|for)$/.test(t[k]) && t[k + 1] === 'target') return true;
      if (t[k] === 'target' || t[k] === ',') return false;
    }
    return false;
  }
  // USPSA minor scoring: A 5, B/C 3, D 1, miss -10, no-shoot -10
  const PTS = { A: 5, B: 3, C: 3, D: 1, M: -10, NS: -10 };
  function points(hits) { let p = 0, n = 0; for (const z of Object.values(hits)) for (const [k, v] of Object.entries(z)) { p += (PTS[k] || 0) * v; if (k !== 'NS') n += v; } return { points: p, count: n }; }
  root.VoiceParse = { parseDrill, parseScore, points, norm };
  if (typeof module !== 'undefined') module.exports = root.VoiceParse;
})(typeof window !== 'undefined' ? window : globalThis);
