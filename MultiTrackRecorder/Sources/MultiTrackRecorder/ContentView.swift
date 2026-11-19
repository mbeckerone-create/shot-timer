import SwiftUI
import AppKit
import CoreAudio

enum MainTab: String, CaseIterable { case record = "Record", playback = "Playback" }

struct ContentView: View {
    @EnvironmentObject var recorder: RecorderEngine
    @EnvironmentObject var player: SessionPlayer
    @Environment(\.palette) var palette
    @State private var tab: MainTab = .record

    var body: some View {
        VStack(spacing: 0) {
            if tab == .record { RecordView() } else { PlaybackView() }
        }
        .background(palette.window)
        .toolbar {
            ToolbarItem(placement: .principal) {
                Picker("", selection: $tab) {
                    ForEach(MainTab.allCases, id: \.self) { Text($0.rawValue).tag($0) }
                }
                .pickerStyle(.segmented)
                .frame(width: 200)
            }
            ToolbarItem(placement: .primaryAction) {
                SettingsLink { Image(systemName: "gearshape") }.help("Settings")
            }
        }
        .alert("Audio", isPresented: Binding(get: { recorder.errorMessage != nil },
                                              set: { if !$0 { recorder.errorMessage = nil } })) {
            Button("OK", role: .cancel) {}
        } message: { Text(recorder.errorMessage ?? "") }
        .onChange(of: recorder.lastSessionFolder) { folder in
            if let folder { player.load(folder: folder) }
        }
    }
}

// MARK: - Record

struct RecordView: View {
    @EnvironmentObject var recorder: RecorderEngine
    @Environment(\.palette) var palette

    var body: some View {
        VStack(spacing: 0) {
            TransportBar()
            Divider().overlay(palette.stroke)
            if recorder.tracks.isEmpty {
                EmptyDeviceView()
            } else {
                ScrollView {
                    LazyVStack(spacing: 0) {
                        ForEach($recorder.tracks) { $track in
                            TrackRow(track: $track)
                                .background(track.id % 2 == 0 ? palette.row : palette.rowAlt)
                        }
                    }
                }
            }
            Divider().overlay(palette.stroke)
            StatusBar()
        }
    }
}

struct TransportBar: View {
    @EnvironmentObject var recorder: RecorderEngine
    @Environment(\.palette) var palette

    var body: some View {
        HStack(spacing: 16) {
            RecordButton()
            VStack(alignment: .leading, spacing: 2) {
                Text(timecode(recorder.elapsed, tenths: true))
                    .font(.system(size: 30, weight: .light, design: .monospaced))
                    .foregroundStyle(recorder.state == .recording ? Color.red : Color.primary)
                Text(statusText).font(.caption).foregroundStyle(palette.secondaryText)
            }
            Spacer()
            VStack(alignment: .trailing, spacing: 6) {
                Picker("Input", selection: $recorder.selectedDeviceID) {
                    if recorder.devices.isEmpty { Text("No input devices").tag(Optional<AudioDeviceID>.none) }
                    ForEach(recorder.devices) { d in
                        Text("\(d.name)  ·  \(d.inputChannels) ch").tag(Optional(d.id))
                    }
                }
                .frame(width: 330)
                .disabled(recorder.state == .recording)
                HStack(spacing: 8) {
                    Text("\(Int(recorder.sampleRate)) Hz").monospacedDigit()
                    Text("·")
                    Text("\(AppSettings.shared.bitDepth.label) WAV")
                    Text("·")
                    Text("\(recorder.armedCount) of \(recorder.tracks.count) armed")
                }
                .font(.caption).foregroundStyle(palette.secondaryText)
            }
        }
        .padding(.horizontal, 20).padding(.vertical, 14)
        .background(palette.panel)
    }

    var statusText: String {
        switch recorder.state {
        case .idle: return "No input"
        case .monitoring: return "Ready · monitoring inputs"
        case .recording: return "Recording"
        }
    }
}

struct RecordButton: View {
    @EnvironmentObject var recorder: RecorderEngine
    @State private var pulse = false

    var body: some View {
        let recording = recorder.state == .recording
        Button {
            recording ? recorder.stopRecording() : recorder.startRecording()
        } label: {
            ZStack {
                Circle().fill(Color.primary.opacity(0.08)).frame(width: 54, height: 54)
                if recording {
                    RoundedRectangle(cornerRadius: 4).fill(Color.red).frame(width: 20, height: 20)
                } else {
                    Circle().fill(Color.red).frame(width: 26, height: 26)
                }
            }
            .overlay(Circle().stroke(Color.red.opacity(recording && pulse ? 0.8 : 0), lineWidth: 2))
        }
        .buttonStyle(.plain)
        .disabled(recorder.state == .idle)
        .help(recording ? "Stop (⌘R)" : "Record (⌘R)")
        .onAppear { withAnimation(.easeInOut(duration: 0.8).repeatForever()) { pulse.toggle() } }
    }
}

struct TrackRow: View {
    @EnvironmentObject var recorder: RecorderEngine
    @Environment(\.palette) var palette
    @Binding var track: Track

    var body: some View {
        HStack(spacing: 12) {
            Text("\(track.id + 1)")
                .font(.system(.caption, design: .monospaced))
                .foregroundStyle(palette.secondaryText)
                .frame(width: 26, alignment: .trailing)
            Button { track.armed.toggle(); recorder.saveTrackSetup() } label: {
                Image(systemName: track.armed ? "record.circle.fill" : "record.circle")
                    .font(.system(size: 16))
                    .foregroundStyle(track.armed ? Color.red : palette.secondaryText)
            }
            .buttonStyle(.plain)
            .disabled(recorder.state == .recording)
            .help(track.armed ? "Armed – will record" : "Not armed")
            TextField("Track name", text: $track.name, onCommit: { recorder.saveTrackSetup() })
                .textFieldStyle(.plain)
                .frame(width: 200)
                .disabled(recorder.state == .recording)
            MeterBar(level: track.level, peak: track.peakHold)
                .frame(height: 10)
            Text(track.peakHold > 0.00001 ? String(format: "%.0f", dB(track.peakHold)) : "-∞")
                .font(.system(.caption2, design: .monospaced))
                .foregroundStyle(palette.secondaryText)
                .frame(width: 30, alignment: .trailing)
            Circle()
                .fill(track.clipped ? Color.red : Color.primary.opacity(0.12))
                .frame(width: 8, height: 8)
                .onTapGesture { track.clipped = false }
                .help("Clip indicator – click to clear")
        }
        .padding(.horizontal, 20).padding(.vertical, 6)
        .opacity(track.armed ? 1 : 0.55)
    }
}

struct MeterBar: View {
    var level: Float
    var peak: Float

    var body: some View {
        GeometryReader { geo in
            let w = geo.size.width
            ZStack(alignment: .leading) {
                RoundedRectangle(cornerRadius: 3).fill(Color.primary.opacity(0.1))
                RoundedRectangle(cornerRadius: 3)
                    .fill(LinearGradient(stops: [
                        .init(color: .green, location: 0),
                        .init(color: .green, location: 0.7),
                        .init(color: .yellow, location: 0.88),
                        .init(color: .red, location: 1)], startPoint: .leading, endPoint: .trailing))
                    .mask(alignment: .leading) {
                        Rectangle().frame(width: w * meterPosition(level))
                    }
                if AppSettings.shared.meterHoldPeaks {
                    Rectangle().fill(Color.primary.opacity(0.8))
                        .frame(width: 2)
                        .offset(x: max(0, w * meterPosition(peak) - 2))
                        .opacity(peak > 0.001 ? 1 : 0)
                }
            }
        }
    }
}

struct EmptyDeviceView: View {
    @EnvironmentObject var recorder: RecorderEngine
    @Environment(\.palette) var palette
    var body: some View {
        VStack(spacing: 12) {
            Image(systemName: "waveform.badge.exclamationmark").font(.system(size: 40)).foregroundStyle(palette.secondaryText)
            Text("No audio input").font(.title3)
            Text("Start Dante Virtual Soundcard (or connect an interface), then pick it from the Input menu.")
                .multilineTextAlignment(.center).foregroundStyle(palette.secondaryText).frame(maxWidth: 380)
            Button("Refresh Devices") { recorder.refreshDevices() }
        }
        .frame(maxWidth: .infinity, maxHeight: .infinity)
    }
}

struct StatusBar: View {
    @EnvironmentObject var recorder: RecorderEngine
    @ObservedObject var settings = AppSettings.shared
    @Environment(\.palette) var palette

    var body: some View {
        HStack(spacing: 14) {
            Button("Arm All") { recorder.setAllArmed(true) }.disabled(recorder.state == .recording)
            Button("Disarm All") { recorder.setAllArmed(false) }.disabled(recorder.state == .recording)
            Button("Clear Clips") { recorder.clearClips() }
            Spacer()
            Label(settings.recordFolder.path, systemImage: "folder")
                .lineLimit(1).truncationMode(.middle)
                .onTapGesture { NSWorkspace.shared.open(settings.recordFolder) }
                .help("Open recordings folder")
            Text(ByteCountFormatter.string(fromByteCount: recorder.freeDiskBytes, countStyle: .file) + " free")
            Text(String(format: "≈ %.1f h left", recorder.hoursRemaining))
                .foregroundStyle(recorder.hoursRemaining < 2 ? Color.orange : palette.secondaryText)
        }
        .controlSize(.small)
        .font(.caption)
        .foregroundStyle(palette.secondaryText)
        .padding(.horizontal, 20).padding(.vertical, 8)
        .background(palette.panel)
    }
}
