# Shot Timer

A phone shot timer and training log that runs as a web app saved to the iPhone home screen.

## v0.1 — basic timer
- **START → Standby → random beep (2–5 s by default) → shoot.** First shot = draw time; every split after it.
- Shots are detected from the mic in an AudioWorklet, timed to the **sample** (1/48000 s).
- The start beep is located *in the mic recording itself*, so the phone's speaker+mic latency cancels out.
- Optional par-time beep, adjustable sensitivity, echo window, min time between shots, auto-stop.
- Tap × on a shot to remove a false detection. Strings auto-save to History (per shooter + gun). CSV export.
- Settings › *Test with a recording* runs the same detector on any video/audio file.
- Works offline after first load (service worker).

## Detector (detector.js)
2 kHz high-pass (rejects wind/handling) → 1 ms energy blocks → adaptive noise floor → arm at +15 dB →
confirm the loudest block within 70 ms (absolute level + must be mostly high-frequency) → backtrack to
the burst's first sample (so a bullet crack/precursor times the shot from its first sound) →
100 ms lockout + echo rejection (quieter by 6 dB within 180 ms) + beep rejection (a sustained pure tone,
such as another bay's shot timer, is never counted as a shot).

Settings › Diagnostics shows what the mic heard during the last start beep, and can share that recording.
`tools/detect2.py` is the Python reference; `tools/parity.js` proves the JS matches it.

## Tests
- `node test/sim-worklet.js` — fake 90 ms latency + beep + a real 10-shot string through the worklet.
- `node test/e2e.js <fake-mic.wav> <outdir>` — full app in Chromium with a fake microphone.

## Roadmap
Sessions & multi-shooter rotation · drills/presets · voice scoring ("1 alpha, 2 charlie") · gun stats ·
target photo → hit zones.

## Training film (v0.4)
🎥 Film on the Timer screen records the camera + the detector's own mic track, with a live overlay of what the
app hears. Tapping it again offers **Share clip + log**: a video and a `.json` log of every sound, fingerprint,
decision and rep result. `python3 tools/render_overlay.py clip.mp4 clip.json out.mp4` burns those decisions
onto the video (beeps located in the clip's own audio).
