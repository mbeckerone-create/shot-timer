#!/bin/bash
# Builds "MultiTrack Recorder.app" and a zip you can copy to any other Mac.
set -euo pipefail
cd "$(dirname "$0")"
swift build -c release --arch arm64 --arch x86_64
BIN=".build/apple/Products/Release/MultiTrackRecorder"
[ -f "$BIN" ] || BIN=".build/release/MultiTrackRecorder"
APP="build/MultiTrack Recorder.app"
rm -rf build && mkdir -p "$APP/Contents/MacOS" "$APP/Contents/Resources"
cp "$BIN" "$APP/Contents/MacOS/MultiTrackRecorder"
cp Support/Info.plist "$APP/Contents/Info.plist"
codesign --force --deep --sign - "$APP"
(cd build && ditto -c -k --keepParent "MultiTrack Recorder.app" "MultiTrackRecorder.zip")
echo "Built: $APP"
echo "Portable zip: build/MultiTrackRecorder.zip"
