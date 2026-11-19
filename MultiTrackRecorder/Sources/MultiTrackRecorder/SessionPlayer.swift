import AVFoundation
import Combine

struct PlaybackTrack: Identifiable {
    let id = UUID()
    let url: URL
    let file: AVAudioFile
    let node = AVAudioPlayerNode()
    var name: String { url.deletingPathExtension().lastPathComponent }
    var volume: Float = 1
    var pan: Float = 0
    var muted = false
    var solo = false
}

/// Plays back every WAV in a session folder in sync, with per-track volume / pan / mute / solo.
final class SessionPlayer: ObservableObject {
    @Published private(set) var folder: URL?
    @Published var tracks: [PlaybackTrack] = []
    @Published private(set) var isPlaying = false
    @Published private(set) var position: TimeInterval = 0
    @Published private(set) var duration: TimeInterval = 0
    @Published var masterVolume: Float = 1 { didSet { engine.mainMixerNode.outputVolume = masterVolume } }

    private let engine = AVAudioEngine()
    private var startOffset: TimeInterval = 0
    private var timer: Timer?

    func load(folder: URL) {
        stop()
        tracks.forEach { engine.detach($0.node) }
        tracks = []
        let urls = ((try? FileManager.default.contentsOfDirectory(at: folder, includingPropertiesForKeys: nil)) ?? [])
            .filter { $0.pathExtension.lowercased() == "wav" }
            .sorted { $0.lastPathComponent.localizedStandardCompare($1.lastPathComponent) == .orderedAscending }
        var loaded: [PlaybackTrack] = []
        for url in urls {
            guard let file = try? AVAudioFile(forReading: url) else { continue }
            let t = PlaybackTrack(url: url, file: file)
            engine.attach(t.node)
            engine.connect(t.node, to: engine.mainMixerNode, format: file.processingFormat)
            loaded.append(t)
        }
        tracks = loaded
        duration = loaded.map { Double($0.file.length) / $0.file.processingFormat.sampleRate }.max() ?? 0
        position = 0
        startOffset = 0
        self.folder = folder
        applyMix()
    }

    func togglePlay() { isPlaying ? pause() : play() }

    func play() {
        guard !tracks.isEmpty, !isPlaying else { return }
        do { if !engine.isRunning { try engine.start() } } catch { return }
        if startOffset >= duration { startOffset = 0 }
        let host = mach_absolute_time() + AVAudioTime.hostTime(forSeconds: 0.1)
        let when = AVAudioTime(hostTime: host)
        for t in tracks {
            let sr = t.file.processingFormat.sampleRate
            let startFrame = AVAudioFramePosition(startOffset * sr)
            guard startFrame < t.file.length else { continue }
            t.node.scheduleSegment(t.file, startingFrame: startFrame,
                                   frameCount: AVAudioFrameCount(t.file.length - startFrame), at: nil)
        }
        tracks.forEach { $0.node.play(at: when) }
        isPlaying = true
        timer = Timer.scheduledTimer(withTimeInterval: 0.05, repeats: true) { [weak self] _ in self?.tick() }
    }

    func pause() {
        guard isPlaying else { return }
        startOffset = currentTime()
        position = startOffset
        halt()
    }

    func stop() {
        halt()
        startOffset = 0
        position = 0
    }

    func seek(to t: TimeInterval) {
        let wasPlaying = isPlaying
        halt()
        startOffset = min(max(0, t), duration)
        position = startOffset
        if wasPlaying { play() }
    }

    private func halt() {
        timer?.invalidate(); timer = nil
        tracks.forEach { $0.node.stop() }
        isPlaying = false
    }

    private func currentTime() -> TimeInterval {
        guard let t = tracks.first, let nodeTime = t.node.lastRenderTime,
              let pt = t.node.playerTime(forNodeTime: nodeTime) else { return startOffset }
        return startOffset + max(0, Double(pt.sampleTime) / pt.sampleRate)
    }

    private func tick() {
        position = min(currentTime(), duration)
        if position >= duration - 0.01 { stop() }
    }

    func applyMix() {
        let anySolo = tracks.contains(where: \.solo)
        for t in tracks {
            let audible = !t.muted && (!anySolo || t.solo)
            t.node.volume = audible ? t.volume : 0
            t.node.pan = t.pan
        }
    }
}
