import SwiftUI
import AppKit

struct SettingsView: View {
    var body: some View {
        TabView {
            GeneralSettings().tabItem { Label("General", systemImage: "gearshape") }
            AudioSettings().tabItem { Label("Audio", systemImage: "waveform") }
            RecordingSettings().tabItem { Label("Recording", systemImage: "record.circle") }
        }
        .frame(width: 520, height: 330)
    }
}

struct GeneralSettings: View {
    @ObservedObject var settings = AppSettings.shared
    var body: some View {
        Form {
            Picker("Appearance", selection: Binding(get: { settings.appearance }, set: { settings.appearance = $0 })) {
                ForEach(Appearance.allCases) { Text($0.rawValue).tag($0) }
            }
            .pickerStyle(.segmented)
            Toggle("Show peak-hold line on meters", isOn: $settings.meterHoldPeaks)
        }
        .formStyle(.grouped)
    }
}

struct AudioSettings: View {
    @EnvironmentObject var recorder: RecorderEngine
    var body: some View {
        Form {
            Picker("Input device", selection: $recorder.selectedDeviceID) {
                ForEach(recorder.devices) { d in Text("\(d.name) (\(d.inputChannels) ch)").tag(Optional(d.id)) }
            }
            .disabled(recorder.state == .recording)
            if let d = recorder.selectedDevice {
                let rates = AudioDevices.availableSampleRates(d.id)
                Picker("Sample rate", selection: Binding(get: { recorder.sampleRate },
                                                         set: { recorder.setDeviceSampleRate($0) })) {
                    ForEach(rates.isEmpty ? [recorder.sampleRate] : rates, id: \.self) { Text("\(Int($0)) Hz").tag($0) }
                }
                .disabled(recorder.state == .recording)
                if d.isDante {
                    Text("Dante Virtual Soundcard: set the sample rate and channel count in Dante Controller / DVS so it matches your Dante network. Changing it here may be overridden by DVS.")
                        .font(.caption).foregroundStyle(.secondary)
                }
            }
            Button("Refresh device list") { recorder.refreshDevices() }
        }
        .formStyle(.grouped)
    }
}

struct RecordingSettings: View {
    @ObservedObject var settings = AppSettings.shared
    var body: some View {
        Form {
            Picker("Bit depth", selection: Binding(get: { settings.bitDepth }, set: { settings.bitDepth = $0 })) {
                ForEach(BitDepth.allCases) { Text($0.label).tag($0) }
            }
            LabeledContent("Recordings folder") {
                HStack {
                    Text(settings.recordFolder.path).lineLimit(1).truncationMode(.middle)
                    Button("Choose…") {
                        let p = NSOpenPanel()
                        p.canChooseDirectories = true; p.canChooseFiles = false; p.canCreateDirectories = true
                        if p.runModal() == .OK, let url = p.url { settings.recordFolderPath = url.path }
                    }
                }
            }
            TextField("Session name prefix", text: $settings.sessionPrefix)
            Toggle("Number files by input (01 Kick.wav)", isOn: $settings.numberFiles)
            Picker("Split files every", selection: $settings.splitHours) {
                Text("Never").tag(0)
                Text("1 hour").tag(1)
                Text("2 hours").tag(2)
                Text("4 hours").tag(4)
            }
            Text("Each armed track is written as a mono standard PCM WAV file. WAV files are limited to 4 GB (≈8 h at 48 kHz/24-bit), so splitting is only needed for very long recordings.")
                .font(.caption).foregroundStyle(.secondary)
        }
        .formStyle(.grouped)
    }
}
