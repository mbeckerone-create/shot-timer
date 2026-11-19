import SwiftUI
import AVFoundation

enum Appearance: String, CaseIterable, Identifiable {
    case system = "System", light = "Light", grey = "Grey", dark = "Dark"
    var id: String { rawValue }
}

enum BitDepth: Int, CaseIterable, Identifiable {
    case int16 = 16, int24 = 24, float32 = 32
    var id: Int { rawValue }
    var label: String {
        switch self { case .int16: "16-bit"; case .int24: "24-bit"; case .float32: "32-bit float" }
    }
    var bytesPerSample: Int { rawValue / 8 }
}

/// App-wide preferences, persisted with UserDefaults.
final class AppSettings: ObservableObject {
    static let shared = AppSettings()

    @AppStorage("appearance") var appearanceRaw = Appearance.system.rawValue { willSet { objectWillChange.send() } }
    @AppStorage("bitDepth") var bitDepthRaw = BitDepth.int24.rawValue { willSet { objectWillChange.send() } }
    @AppStorage("recordFolder") var recordFolderPath = AppSettings.defaultFolder.path { willSet { objectWillChange.send() } }
    @AppStorage("sessionPrefix") var sessionPrefix = "Service" { willSet { objectWillChange.send() } }
    @AppStorage("preferredDeviceUID") var preferredDeviceUID = "" { willSet { objectWillChange.send() } }
    @AppStorage("filePerTrackPrefixNumber") var numberFiles = true { willSet { objectWillChange.send() } }
    @AppStorage("meterHoldPeaks") var meterHoldPeaks = true { willSet { objectWillChange.send() } }
    @AppStorage("splitHours") var splitHours = 0 { willSet { objectWillChange.send() } }   // 0 = never

    var appearance: Appearance {
        get { Appearance(rawValue: appearanceRaw) ?? .system }
        set { appearanceRaw = newValue.rawValue }
    }
    var bitDepth: BitDepth {
        get { BitDepth(rawValue: bitDepthRaw) ?? .int24 }
        set { bitDepthRaw = newValue.rawValue }
    }
    var recordFolder: URL { URL(fileURLWithPath: recordFolderPath, isDirectory: true) }

    static var defaultFolder: URL {
        FileManager.default.urls(for: .musicDirectory, in: .userDomainMask)[0]
            .appendingPathComponent("MultiTrack Recordings", isDirectory: true)
    }

    // Track names are stored per input device so each rig keeps its own labels.
    func trackNames(for deviceUID: String) -> [String] {
        UserDefaults.standard.stringArray(forKey: "names.\(deviceUID)") ?? []
    }
    func setTrackNames(_ names: [String], for deviceUID: String) {
        UserDefaults.standard.set(names, forKey: "names.\(deviceUID)")
    }
    func armedTracks(for deviceUID: String) -> [Bool]? {
        (UserDefaults.standard.array(forKey: "armed.\(deviceUID)") as? [Bool])
    }
    func setArmedTracks(_ armed: [Bool], for deviceUID: String) {
        UserDefaults.standard.set(armed, forKey: "armed.\(deviceUID)")
    }
}

/// Grey-tone palette. Each appearance maps to a color scheme plus surface colors.
struct Palette {
    let scheme: ColorScheme?
    let window: Color
    let panel: Color
    let row: Color
    let rowAlt: Color
    let stroke: Color
    let secondaryText: Color

    static func forAppearance(_ a: Appearance, system: ColorScheme) -> Palette {
        switch a {
        case .light: return .light
        case .dark: return .dark
        case .grey: return .grey
        case .system: return system == .dark ? .dark : .light
        }
    }

    static let light = Palette(scheme: .light,
                               window: Color(white: 0.94), panel: Color(white: 0.98),
                               row: Color(white: 1.0), rowAlt: Color(white: 0.965),
                               stroke: Color(white: 0.84), secondaryText: Color(white: 0.42))
    static let grey = Palette(scheme: .dark,
                              window: Color(white: 0.34), panel: Color(white: 0.29),
                              row: Color(white: 0.38), rowAlt: Color(white: 0.355),
                              stroke: Color(white: 0.25), secondaryText: Color(white: 0.78))
    static let dark = Palette(scheme: .dark,
                              window: Color(white: 0.11), panel: Color(white: 0.145),
                              row: Color(white: 0.175), rowAlt: Color(white: 0.155),
                              stroke: Color(white: 0.06), secondaryText: Color(white: 0.6))
}

private struct PaletteKey: EnvironmentKey { static let defaultValue = Palette.dark }
extension EnvironmentValues {
    var palette: Palette {
        get { self[PaletteKey.self] }
        set { self[PaletteKey.self] = newValue }
    }
}

/// Applies the chosen appearance to any view tree.
struct Themed: ViewModifier {
    @ObservedObject var settings = AppSettings.shared
    @Environment(\.colorScheme) private var systemScheme

    func body(content: Content) -> some View {
        let p = Palette.forAppearance(settings.appearance, system: systemScheme)
        content
            .environment(\.palette, p)
            .preferredColorScheme(settings.appearance == .system ? nil : p.scheme)
    }
}
extension View { func themed() -> some View { modifier(Themed()) } }
