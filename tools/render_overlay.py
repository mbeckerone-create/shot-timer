#!/usr/bin/env python3
"""Burn the app's decisions onto an exported training clip.

usage: python3 tools/render_overlay.py training-XXXX.mp4 training-XXXX.json out.mp4

The JSON log (from the app's 🎥 Film mode) has, per rep: when the beep was scheduled, the beep the worklet found,
every sound with its fingerprint, how each was judged, and the rep result. Times of judged sounds are relative to
the beep, so we locate each beep in the clip's own audio (2400 Hz Goertzel, refined around the logged estimate)
and place every label exactly. Rendered as ASS subtitles via ffmpeg/libass.
"""
import json, subprocess, sys, tempfile, os, wave
import numpy as np


def audio(path, sr=48000):
    tmp = tempfile.mktemp(suffix='.wav')
    subprocess.run(['ffmpeg', '-v', 'error', '-y', '-i', path, '-vn', '-ac', '1', '-ar', str(sr), tmp], check=True)
    w = wave.open(tmp); x = np.frombuffer(w.readframes(w.getnframes()), np.int16).astype(np.float32) / 32768; os.remove(tmp)
    return x, sr


def find_beep(x, sr, hz, around, span=1.2):
    """First 10 ms block near `around` where the beep tone dominates; returns seconds or None."""
    N = sr // 100; c = 2 * np.cos(2 * np.pi * hz / sr)
    a = max(0, int((around - span) * sr)); b = min(len(x) - N, int((around + span) * sr))
    best = None; run = 0
    for s in range(a, b, N):
        s1 = s2 = 0.0
        blk = x[s:s + N]
        for v in blk: s0 = v + c * s1 - s2; s2 = s1; s1 = s0
        pw = s1 * s1 + s2 * s2 - c * s1 * s2; en = float((blk ** 2).sum()) + 1e-12
        if pw / (N / 2 * en) > 0.5 and en / N > 1e-6:
            run += 1
            if run == 1: best = s
            if run >= 3: return best / sr
        else: run = 0
    return None


def ts(t):
    t = max(0.0, t); h = int(t // 3600); m = int(t % 3600 // 60); s = t % 60
    return f'{h}:{m:02d}:{s:05.2f}'


def main(video, log_path, out):
    log = json.load(open(log_path)); x, sr = audio(video)
    hz = log['settings'].get('beepHz', 2400); t0 = log.get('recStartCtx') or 0
    reps, cur = [], None
    for e in log['events']:
        if e['type'] == 'beep_scheduled': cur = {'sched': e['beepAt'] - t0, 'events': [], 'result': None}; reps.append(cur)
        elif cur is None: continue
        elif e['type'] == 'judged': cur['events'].append(e)
        elif e['type'] in ('rep', 'string'): cur['result'] = e
    style = ('[Script Info]\nScriptType: v4.00+\nPlayResX: 1280\nPlayResY: 720\n\n[V4+ Styles]\n'
             'Format: Name, Fontname, Fontsize, PrimaryColour, OutlineColour, BorderStyle, Outline, Shadow, Alignment, MarginL, MarginR, MarginV\n'
             'Style: Big,DejaVu Sans Mono,54,&H00FFFFFF,&H00000000,1,3,0,7,30,30,24\n'
             'Style: Ev,DejaVu Sans Mono,38,&H00FFFFFF,&H00000000,1,3,0,1,30,30,30\n\n'
             '[Events]\nFormat: Layer, Start, End, Style, Text\n')
    col = {'click': '&H0084DC3D&', 'holster': '&H00FFC47C&', None: '&H00999999&'}
    lines = []
    for i, r in enumerate(reps, 1):
        b = find_beep(x, sr, hz, r['sched'] + 0.05) or r['sched']
        end = b + 6
        lines.append(f'Dialogue: 0,{ts(b)},{ts(b + 0.6)},Big,{{\\c&H003CC9FF&}}BEEP  rep {i}')
        for e in r['events']:
            t = b + e['t']
            lab = (e['kind'] or e['reason'] or '?').upper()
            lines.append(f"Dialogue: 0,{ts(t)},{ts(t + 1.6)},Ev,{{\\c{col.get(e['kind'], col[None])}}}{lab} {e['t']:.3f}  click {e['score']:.2f} hol {e['hol']:.2f}  {e['db']:.0f}dB")
            end = max(end, t + 1.6)
        res = (r['result'] or {}).get('result')
        if res:
            txt = f"SHOT {res['t']:.3f}" + (f"  REACT {res['react']:.3f}  SPLIT {res['split']:.3f}" if res.get('react') is not None else '') + \
                  (f"  RELOAD {res['reload']:.3f}" if res.get('reload') is not None else '')
            lines.append(f'Dialogue: 0,{ts(b + res["t"] + 0.35)},{ts(b + res["t"] + 3.5)},Big,{txt}')
    ass = tempfile.mktemp(suffix='.ass'); open(ass, 'w').write(style + '\n'.join(lines) + '\n')
    subprocess.run(['ffmpeg', '-v', 'error', '-y', '-i', video, '-vf', f'scale=1280:720:force_original_aspect_ratio=decrease,pad=1280:720:(ow-iw)/2:(oh-ih)/2,ass={ass}',
                    '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '23', '-c:a', 'aac', out], check=True)
    os.remove(ass); print(f'{len(reps)} reps rendered -> {out}')


if __name__ == '__main__':
    main(*sys.argv[1:4])
