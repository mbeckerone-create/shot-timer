# MultiTrack Recorder (macOS)

A clean, native SwiftUI multitrack recorder for services. Records every input of a
Core Audio device — **Dante Virtual Soundcard**, Dante Via, or any USB/Thunderbolt
interface — to **one mono WAV per track** (16/24-bit or 32-bit float, at the device's sample rate).

## Features
- Auto-picks Dante Virtual Soundcard when it's running; hot-swaps when devices appear/disappear
- 30, 64, 128+ channels — whatever the device exposes
- Per-track arm, editable names (remembered per device), level meters with peak hold & clip lights
- Big record button / ⌘R, timecode, disk space + hours-remaining estimate
- Session folders: `~/Music/MultiTrack Recordings/Service 2026-11-22 0930/01 Pastor Mic.wav …` plus a `Session Info.txt`
- Optional file splitting (1/2/4 h) for very long recordings
- Keeps the Mac from sleeping while recording
- Playback tab: synced playback of a session with per-track volume, pan, mute, solo, master volume, scrubbing
- Appearance: System, Light, **Grey**, Dark (Settings → General)

## Build (on your Mac)
Needs Xcode or the Xcode Command Line Tools (`xcode-select --install`), macOS 14+.

```bash
cd MultiTrackRecorder
./build_app.sh
```

This produces `build/MultiTrack Recorder.app` and `build/MultiTrackRecorder.zip`.
Drag the app to `/Applications`. First launch: macOS asks for microphone/audio-input permission — allow it.

To develop: `open Package.swift` in Xcode and press Run.

## Install on another Mac
Copy `MultiTrackRecorder.zip` to the other Mac, unzip, move to Applications.
The app is ad-hoc signed (not notarized), so the first time **right-click → Open → Open**
(or System Settings → Privacy & Security → "Open Anyway"). It's a universal binary (Apple Silicon + Intel).

Each push to GitHub also builds the zip via GitHub Actions (Actions tab → MultiTrack Recorder → artifact).

## Using with Dante Virtual Soundcard
1. In DVS, set the channel count (e.g. 32×32 or 64×64) and sample rate to match the Dante network, and start it.
2. In Dante Controller, route your console/stagebox outputs to the DVS receive channels.
3. Open MultiTrack Recorder — "Dante Virtual Soundcard" is selected automatically. Name and arm tracks, hit Record.

Without Dante connected you can test with the built-in mic or any interface.
