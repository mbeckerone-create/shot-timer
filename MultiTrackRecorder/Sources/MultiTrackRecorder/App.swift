import SwiftUI
import AppKit

@main
struct MultiTrackRecorderApp: App {
    @NSApplicationDelegateAdaptor(AppDelegate.self) var delegate
    @StateObject private var recorder = RecorderEngine()
    @StateObject private var player = SessionPlayer()

    var body: some Scene {
        WindowGroup("MultiTrack Recorder") {
            ContentView()
                .environmentObject(recorder)
                .environmentObject(player)
                .themed()
                .frame(minWidth: 900, minHeight: 560)
        }
        .windowToolbarStyle(.unifiedCompact)
        .commands {
            CommandGroup(replacing: .newItem) {}
            CommandMenu("Transport") {
                Button(recorder.state == .recording ? "Stop Recording" : "Record") {
                    recorder.state == .recording ? recorder.stopRecording() : recorder.startRecording()
                }
                .keyboardShortcut("r", modifiers: [.command])
                Button("Arm All Tracks") { recorder.setAllArmed(true) }
                Button("Disarm All Tracks") { recorder.setAllArmed(false) }
                Divider()
                Button("Clear Clip Indicators") { recorder.clearClips() }
                    .keyboardShortcut("k", modifiers: [.command])
                Button("Refresh Audio Devices") { recorder.refreshDevices() }
            }
        }

        Settings {
            SettingsView()
                .environmentObject(recorder)
                .themed()
        }
    }
}

final class AppDelegate: NSObject, NSApplicationDelegate {
    func applicationDidFinishLaunching(_ notification: Notification) {
        NSApp.setActivationPolicy(.regular)
        NSApp.activate(ignoringOtherApps: true)
    }
    func applicationShouldTerminateAfterLastWindowClosed(_ sender: NSApplication) -> Bool { true }
}
