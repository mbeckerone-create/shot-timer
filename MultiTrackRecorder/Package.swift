// swift-tools-version:5.9
import PackageDescription

let package = Package(
    name: "MultiTrackRecorder",
    platforms: [.macOS(.v14)],
    targets: [
        .executableTarget(name: "MultiTrackRecorder", path: "Sources/MultiTrackRecorder")
    ]
)
