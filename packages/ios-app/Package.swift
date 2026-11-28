// swift-tools-version: 5.9
import PackageDescription

let package = Package(
    name: "EnsoCore",
    platforms: [
        .iOS(.v16),
        .macOS(.v13),
    ],
    products: [
        .library(
            name: "EnsoCore",
            targets: ["EnsoCore"]
        ),
    ],
    targets: [
        .target(
            name: "EnsoCore",
            path: "Sources/EnsoCore"
        ),
        .testTarget(
            name: "EnsoCoreTests",
            dependencies: ["EnsoCore"],
            path: "Tests/EnsoCoreTests"
        ),
    ]
)
