#!/usr/bin/env python3
"""Independent check for "is this sound a shot?": a shot makes the gun recoil (and often shakes the camera), an echo
does not. Measures frame-to-frame motion in the video around each detected sound.

usage: python3 tools/motion_at_sounds.py clip.mov scan.json clipname
Prints per sound: time, level relative to the loudest within +-3 s, and the motion jump (peak motion in the 0-120 ms
after the sound divided by the median motion in the 0.5 s before it).
"""
import json, subprocess, sys
import numpy as np


def motion(path, w=96, h=54):
    fps = eval(subprocess.run(['ffprobe', '-v', 'error', '-select_streams', 'v:0', '-show_entries', 'stream=avg_frame_rate', '-of', 'csv=p=0', path],
                              capture_output=True, text=True).stdout.strip().split('\n')[0].strip(','))
    raw = subprocess.run(['ffmpeg', '-v', 'error', '-i', path, '-vf', f'scale={w}:{h},format=gray', '-f', 'rawvideo', '-'], capture_output=True).stdout
    fr = np.frombuffer(raw, np.uint8).reshape(-1, h, w).astype(np.float32)
    df = np.abs(np.diff(fr, axis=0))                             # change from frame i to i+1
    gh, gw = 6, 8                                                # the shooter is small in frame: use the busiest patch
    pt = df[:, :h // gh * gh, :w // gw * gw].reshape(len(df), gh, h // gh, gw, w // gw).mean(axis=(2, 4)).reshape(len(df), -1)
    d = pt.max(axis=1)
    return d, fps


def jumps(d, fps, shots):
    out = []
    for t, db in shots:
        i = int(t * fps)
        pre = d[max(0, i - int(0.5 * fps)):max(1, i - 1)]
        post = d[i:i + max(2, int(0.12 * fps) + 1)]
        base = np.median(pre) if len(pre) else 1.0
        out.append(float(post.max() / (base + 0.05)) if len(post) else 0.0)
    return out


if __name__ == '__main__':
    path, scanf, name = sys.argv[1:4]
    c = next(x for x in json.load(open(scanf)) if x['name'] == name)
    d, fps = motion(path)
    J = jumps(d, fps, c['shots'])
    for (t, db), j in zip(c['shots'], J):
        ref = max(x[1] for x in c['shots'] if abs(x[0] - t) <= 3)
        print(f'{t:8.3f}  {db - ref:6.1f} dB  motion x{j:5.1f}')
