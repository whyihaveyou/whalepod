// swift-tools-version:5.9
import PackageDescription

let package = Package(
    name: "HarnessShell",
    platforms: [
        .macOS(.v13)
    ],
    targets: [
        .executableTarget(
            name: "HarnessShell",
            path: "Sources/HarnessShell",
            exclude: ["Info.plist"],
            linkerSettings: [
                .linkedFramework("AppKit"),
                .linkedFramework("WebKit")
            ]
        )
    ]
)
