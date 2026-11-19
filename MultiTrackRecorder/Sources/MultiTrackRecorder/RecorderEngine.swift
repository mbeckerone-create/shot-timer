import AVFoundation
import AudioToolbox
import CoreAudio
import Combine

struct Track: Identifiable, Equatable {
    let id: Int            // zero-based input channel
    var name: String
    var armed: Bool
    var level: Float = 0   // linear peak 0...1
    var peakHold: Float = 0
    var clipped = false
}

enum RecorderState: Equatable { case idle, monitoring, recording }

/// Captures every input channel of a Core Audio device (Dante Virtual Soundcard,
/// Dante Via, USB/Thunderbolt interfaces, built-in mic) and writes one mono WAV per armed track.
final class RecorderEngine: ObservableObject {
    @Published private(set) var devices: [AudioInputDevice] = []
    @Published var selectedDeviceID: AudioDeviceID? { didSet { if oldValue != selectedDeviceID { startMonitoring() } } }
    @Published var tracks: [Track] = []
    @Published private(set) var state: RecorderState = .idle
    @Published private(set) var elapsed: TimeInterval = 0
    @Published private(set) var sampleRate: Double = 0
    @Published private(set) var lastSessionFolder: URL?
    @Published var errorMessage: String?
    @Published private(set) var freeDiskBytes: Int64 = 0

    private var engine: AVAudioEngine?
    private let writeQueue = DispatchQueue(label: "recorder.write", qos: .userInitiated)
    private var files: [Int: AVAudioFile] = [:]          // channel -> file (touched only on writeQueue)
    private var framesWritten: AVAudioFramePosition = 0  // writeQueue only
    private var isWriting = false                        // writeQueue only
    private var segment = 1
    private var sleepActivity: NSObjectProtocol?
    private var sessionFolder: URL?
    private var sessionName = ""

    private let levelLock = NSLock()
    private var levels: [Float] = []
    private var uiTimer: Timer?
    private let settings = AppSettings.shared

    var selectedDevice: AudioInputDevice? { devices.first { $0.id == selectedDeviceID } }
    var armedCount: Int { tracks.filter(\.armed).count }

    init() {
        refreshDevices()
        AudioDevices.observeDeviceChanges { [weak self] in self?.refreshDevices() }
        uiTimer = Timer.scheduledTimer(withTimeInterval: 1.0 / 30.0, repeats: true) { [weak self] _ in self?.tickUI() }
        AVCaptureDevice.requestAccess(for: .audio) { _ in }
    }

    // MARK: Devices

    func refreshDevices() {
        let list = AudioDevices.inputDevices()
        devices = list
        if let id = selectedDeviceID, list.contains(where: { $0.id == id }) { return }
        if state == .recording { errorMessage = "The recording device disappeared. Recording was stopped."; stopRecording() }
        let preferred = list.first { $0.uid == settings.preferredDeviceUID }
            ?? list.first { $0.isDante }
            ?? list.first { $0.id == AudioDevices.defaultInputDeviceID() }
            ?? list.first
        selectedDeviceID = preferred?.id
    }

    func setDeviceSampleRate(_ rate: Double) {
        guard let id = selectedDeviceID, state != .recording else { return }
        AudioDevices.setSampleRate(id, rate)
        startMonitoring()
    }

    // MARK: Monitoring (meters run whenever a device is selected)

    func startMonitoring() {
        guard state != .recording else { return }
        stopEngine()
        guard let device = selectedDevice else { state = .idle; tracks = []; return }
        settings.preferredDeviceUID = device.uid

        let engine = AVAudioEngine()
        let input = engine.inputNode
        guard let unit = input.audioUnit else { errorMessage = "Could not open the audio input."; return }
        var devID = device.id
        let err = AudioUnitSetProperty(unit, kAudioOutputUnitProperty_CurrentDevice, kAudioUnitScope_Global, 0,
                                       &devID, UInt32(MemoryLayout<AudioDeviceID>.size))
        if err != noErr { errorMessage = "Could not select \(device.name) (error \(err))."; return }

        let format = input.outputFormat(forBus: 0)
        let channels = Int(format.channelCount)
        guard channels > 0, format.sampleRate > 0 else { errorMessage = "\(device.name) reports no input channels."; return }
        sampleRate = format.sampleRate
        buildTracks(count: channels, deviceUID: device.uid)
        levelLock.lock(); levels = Array(repeating: 0, count: channels); levelLock.unlock()

        input.installTap(onBus: 0, bufferSize: 4096, format: format) { [weak self] buffer, _ in
            self?.process(buffer)
        }
        do {
            engine.prepare()
            try engine.start()
            self.engine = engine
            state = .monitoring
            errorMessage = nil
        } catch {
            errorMessage = "Audio engine failed to start: \(error.localizedDescription)"
            state = .idle
        }
    }

    private func stopEngine() {
        engine?.inputNode.removeTap(onBus: 0)
        engine?.stop()
        engine = nil
    }

    private func buildTracks(count: Int, deviceUID: String) {
        let names = settings.trackNames(for: deviceUID)
        let armed = settings.armedTracks(for: deviceUID)
        tracks = (0..<count).map { i in
            Track(id: i,
                  name: i < names.count && !names[i].isEmpty ? names[i] : "Input \(i + 1)",
                  armed: armed.map { i < $0.count ? $0[i] : true } ?? true)
        }
    }

    func saveTrackSetup() {
        guard let uid = selectedDevice?.uid else { return }
        settings.setTrackNames(tracks.map(\.name), for: uid)
        settings.setArmedTracks(tracks.map(\.armed), for: uid)
    }

    func setAllArmed(_ armed: Bool) {
        guard state != .recording else { return }
        for i in tracks.indices { tracks[i].armed = armed }
        saveTrackSetup()
    }

    // MARK: Audio thread

    private func process(_ buffer: AVAudioPCMBuffer) {
        guard let data = buffer.floatChannelData else { return }
        let n = Int(buffer.frameLength), chCount = Int(buffer.format.channelCount)

        var peaks = [Float](repeating: 0, count: chCount)
        for c in 0..<chCount {
            var p: Float = 0
            let ptr = data[c]
            for i in 0..<n { let v = abs(ptr[i]); if v > p { p = v } }
            peaks[c] = p
        }
        levelLock.lock()
        if levels.count == chCount { for c in 0..<chCount { levels[c] = max(levels[c], peaks[c]) } }
        levelLock.unlock()

        // Copy each armed channel so the writer thread owns its data.
        levelLock.lock(); let capturing = captureActive; levelLock.unlock()
        guard capturing else { return }
        let copies = makeCopies(buffer)
        guard !copies.isEmpty else { return }
        writeQueue.async { [weak self] in self?.write(copies, frames: AVAudioFramePosition(n)) }
    }

    private var captureActive = false        // guarded by levelLock
    private var fileNames: [Int: String] = [:]  // channel -> base name, fixed at record start

    private var armedSnapshot: [Int] = []   // read on audio thread, set before writing starts
    private var monoFormat: AVAudioFormat?

    private func makeCopies(_ buffer: AVAudioPCMBuffer) -> [Int: AVAudioPCMBuffer] {
        guard let mono = monoFormat, let src = buffer.floatChannelData else { return [:] }
        var out: [Int: AVAudioPCMBuffer] = [:]
        let n = buffer.frameLength
        for c in armedSnapshot where c < Int(buffer.format.channelCount) {
            guard let b = AVAudioPCMBuffer(pcmFormat: mono, frameCapacity: n) else { continue }
            b.frameLength = n
            memcpy(b.floatChannelData![0], src[c], Int(n) * MemoryLayout<Float>.size)
            out[c] = b
        }
        return out
    }

    private func write(_ buffers: [Int: AVAudioPCMBuffer], frames: AVAudioFramePosition) {
        guard isWriting else { return }
        for (c, b) in buffers {
            do { try files[c]?.write(from: b) }
            catch { DispatchQueue.main.async { self.errorMessage = "Write error on track \(c + 1): \(error.localizedDescription)" } }
        }
        framesWritten += frames
        let splitFrames = AVAudioFramePosition(Double(settings.splitHours) * 3600 * sampleRate)
        if splitFrames > 0, framesWritten >= splitFrames * AVAudioFramePosition(segment) {
            segment += 1
            openFiles()   // next segment, same session folder
        }
    }

    // MARK: Recording

    func startRecording() {
        guard state == .monitoring, let device = selectedDevice else { return }
        let armed = tracks.filter(\.armed).map(\.id)
        guard !armed.isEmpty else { errorMessage = "Arm at least one track to record."; return }
        saveTrackSetup()

        let stamp = DateFormatter()
        stamp.dateFormat = "yyyy-MM-dd HHmm"
        sessionName = "\(settings.sessionPrefix.isEmpty ? "Session" : settings.sessionPrefix) \(stamp.string(from: Date()))"
        let folder = settings.recordFolder.appendingPathComponent(sessionName, isDirectory: true)
        do { try FileManager.default.createDirectory(at: folder, withIntermediateDirectories: true) }
        catch { errorMessage = "Can't create folder: \(error.localizedDescription)"; return }

        sessionFolder = folder
        monoFormat = AVAudioFormat(commonFormat: .pcmFormatFloat32, sampleRate: sampleRate, channels: 1, interleaved: false)
        armedSnapshot = armed
        fileNames = Dictionary(uniqueKeysWithValues: armed.map { ($0, tracks[$0].name) })
        segment = 1
        writeQueue.sync {
            framesWritten = 0
            openFiles()
            isWriting = !files.isEmpty
        }
        guard !files.isEmpty else { return }
        levelLock.lock(); captureActive = true; levelLock.unlock()
        writeSessionInfo(device: device, armed: armed)
        elapsed = 0
        sleepActivity = ProcessInfo.processInfo.beginActivity(
            options: [.idleSystemSleepDisabled, .userInitiated], reason: "Multitrack recording in progress")
        state = .recording
    }

    /// writeQueue only.
    private func openFiles() {
        files.values.forEach { $0.close() }
        files = [:]
        guard let folder = sessionFolder else { return }
        let depth = settings.bitDepth
        let fileSettings: [String: Any] = [
            AVFormatIDKey: kAudioFormatLinearPCM,
            AVSampleRateKey: sampleRate,
            AVNumberOfChannelsKey: 1,
            AVLinearPCMBitDepthKey: depth.rawValue,
            AVLinearPCMIsFloatKey: depth == .float32,
            AVLinearPCMIsBigEndianKey: false,
            AVLinearPCMIsNonInterleaved: false,
        ]
        for c in armedSnapshot {
            let url = folder.appendingPathComponent(fileName(channel: c))
            do {
                files[c] = try AVAudioFile(forWriting: url, settings: fileSettings,
                                           commonFormat: .pcmFormatFloat32, interleaved: false)
            } catch {
                DispatchQueue.main.async { self.errorMessage = "Can't create \(url.lastPathComponent): \(error.localizedDescription)" }
            }
        }
    }

    private func fileName(channel c: Int) -> String {
        let name = fileNames[c] ?? "Input \(c + 1)"
        let safe = name.replacingOccurrences(of: "[/:\\\\]", with: "-", options: .regularExpression)
        let number = settings.numberFiles ? String(format: "%02d ", c + 1) : ""
        let seg = segment > 1 ? " (part \(segment))" : ""
        return "\(number)\(safe)\(seg).wav"
    }

    func stopRecording() {
        guard state == .recording else { return }
        levelLock.lock(); captureActive = false; levelLock.unlock()
        writeQueue.sync {
            isWriting = false
            files.values.forEach { $0.close() }
            files = [:]
        }
        if let a = sleepActivity { ProcessInfo.processInfo.endActivity(a); sleepActivity = nil }
        lastSessionFolder = sessionFolder
        state = .monitoring
        if engine == nil { startMonitoring() }
    }

    private func writeSessionInfo(device: AudioInputDevice, armed: [Int]) {
        guard let folder = sessionFolder else { return }
        var text = "Session: \(sessionName)\nDevice: \(device.name)\nSample rate: \(Int(sampleRate)) Hz\n"
        text += "Format: WAV \(settings.bitDepth.label) mono per track\nStarted: \(Date())\n\nTracks:\n"
        for c in armed { text += "  \(fileName(channel: c))\n" }
        try? text.write(to: folder.appendingPathComponent("Session Info.txt"), atomically: true, encoding: .utf8)
    }

    // MARK: UI tick

    private func tickUI() {
        levelLock.lock()
        let snapshot = levels
        for i in levels.indices { levels[i] = 0 }
        levelLock.unlock()

        if snapshot.count == tracks.count {
            for i in tracks.indices {
                let v = snapshot[i]
                var t = tracks[i]
                t.level = max(v, t.level * 0.82)               // smooth fall-off
                t.peakHold = v >= t.peakHold ? v : max(0, t.peakHold - 0.004)
                if v >= 0.999 { t.clipped = true }
                if t != tracks[i] { tracks[i] = t }
            }
        }
        if state == .recording {
            let frames = writeQueue.sync { framesWritten }
            elapsed = sampleRate > 0 ? Double(frames) / sampleRate : 0
        }
        updateDiskSpace()
    }

    private var diskTick = 0
    private func updateDiskSpace() {
        diskTick += 1
        guard diskTick % 30 == 1 else { return }
        let folder = settings.recordFolder
        try? FileManager.default.createDirectory(at: folder, withIntermediateDirectories: true)
        if let v = try? folder.resourceValues(forKeys: [.volumeAvailableCapacityForImportantUsageKey]),
           let cap = v.volumeAvailableCapacityForImportantUsage {
            freeDiskBytes = cap
        }
    }

    func clearClips() { for i in tracks.indices { tracks[i].clipped = false } }

    /// Hours of recording left on disk at the current settings.
    var hoursRemaining: Double {
        let bytesPerSecond = Double(max(armedCount, 1)) * sampleRate * Double(settings.bitDepth.bytesPerSample)
        return bytesPerSecond > 0 ? Double(freeDiskBytes) / bytesPerSecond / 3600 : 0
    }
}
