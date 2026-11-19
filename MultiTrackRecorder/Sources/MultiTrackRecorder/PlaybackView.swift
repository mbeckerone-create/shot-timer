import SwiftUI
import AppKit
import UniformTypeIdentifiers

struct PlaybackView: View {
    @EnvironmentObject var player: SessionPlayer
    @Environment(\.palette) var palette
    @State private var scrub: Double?

    var body: some View {
        VStack(spacing: 0) {
            HStack(spacing: 14) {
                Button { player.stop() } label: { Image(systemName: "backward.end.fill") }
                Button { player.togglePlay() } label: {
                    Image(systemName: player.isPlaying ? "pause.fill" : "play.fill").frame(width: 20)
                }
                .keyboardShortcut(.space, modifiers: [])
                Text(timecode(scrub ?? player.position, tenths: true))
                    .font(.system(size: 22, weight: .light, design: .monospaced))
                Slider(value: Binding(get: { scrub ?? player.position }, set: { scrub = $0 }),
                       in: 0...max(player.duration, 0.1)) { editing in
                    if !editing, let s = scrub { player.seek(to: s); scrub = nil }
                }
                Text(timecode(player.duration)).font(.system(.caption, design: .monospaced))
                    .foregroundStyle(palette.secondaryText)
                Divider().frame(height: 22)
                Image(systemName: "speaker.wave.2").foregroundStyle(palette.secondaryText)
                Slider(value: $player.masterVolume, in: 0...1).frame(width: 90)
                Button("Open Session…", action: openFolder)
            }
            .buttonStyle(.borderless)
            .padding(.horizontal, 20).padding(.vertical, 14)
            .background(palette.panel)

            Divider().overlay(palette.stroke)

            if player.tracks.isEmpty {
                VStack(spacing: 10) {
                    Image(systemName: "music.note.list").font(.system(size: 38)).foregroundStyle(palette.secondaryText)
                    Text("No session loaded").font(.title3)
                    Text("Your last recording loads here automatically, or open any session folder of WAV files.")
                        .foregroundStyle(palette.secondaryText)
                    Button("Open Session…", action: openFolder)
                }
                .frame(maxWidth: .infinity, maxHeight: .infinity)
            } else {
                ScrollView {
                    LazyVStack(spacing: 0) {
                        ForEach(Array(player.tracks.indices), id: \.self) { i in
                            PlaybackRow(index: i)
                                .background(i % 2 == 0 ? palette.row : palette.rowAlt)
                        }
                    }
                }
                Divider().overlay(palette.stroke)
                HStack {
                    if let f = player.folder {
                        Label(f.lastPathComponent, systemImage: "folder")
                            .onTapGesture { NSWorkspace.shared.open(f) }
                    }
                    Spacer()
                    Text("\(player.tracks.count) tracks")
                }
                .font(.caption).foregroundStyle(palette.secondaryText)
                .padding(.horizontal, 20).padding(.vertical, 8)
                .background(palette.panel)
            }
        }
    }

    private func openFolder() {
        let panel = NSOpenPanel()
        panel.canChooseDirectories = true
        panel.canChooseFiles = false
        panel.directoryURL = AppSettings.shared.recordFolder
        panel.prompt = "Open Session"
        if panel.runModal() == .OK, let url = panel.url { player.load(folder: url) }
    }
}

struct PlaybackRow: View {
    @EnvironmentObject var player: SessionPlayer
    @Environment(\.palette) var palette
    let index: Int

    var body: some View {
        let t = player.tracks[index]
        HStack(spacing: 12) {
            Text(t.name).lineLimit(1).frame(width: 220, alignment: .leading)
            toggle("M", on: t.muted, color: .orange) { player.tracks[index].muted.toggle(); player.applyMix() }
            toggle("S", on: t.solo, color: .yellow) { player.tracks[index].solo.toggle(); player.applyMix() }
            Image(systemName: "slider.horizontal.3").foregroundStyle(palette.secondaryText)
            Slider(value: Binding(get: { Double(t.volume) },
                                  set: { player.tracks[index].volume = Float($0); player.applyMix() }), in: 0...1.5)
            Text(String(format: "%+.1f dB", dB(t.volume)))
                .font(.system(.caption2, design: .monospaced))
                .foregroundStyle(palette.secondaryText).frame(width: 60)
            Text("Pan").font(.caption2).foregroundStyle(palette.secondaryText)
            Slider(value: Binding(get: { Double(t.pan) },
                                  set: { player.tracks[index].pan = Float($0); player.applyMix() }), in: -1...1)
                .frame(width: 90)
        }
        .padding(.horizontal, 20).padding(.vertical, 6)
    }

    private func toggle(_ label: String, on: Bool, color: Color, action: @escaping () -> Void) -> some View {
        Button(action: action) {
            Text(label).font(.caption.bold())
                .frame(width: 22, height: 18)
                .background(RoundedRectangle(cornerRadius: 4).fill(on ? color : Color.primary.opacity(0.1)))
                .foregroundStyle(on ? Color.black : Color.primary)
        }
        .buttonStyle(.plain)
    }
}
