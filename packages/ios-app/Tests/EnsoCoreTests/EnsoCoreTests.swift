import Foundation
import XCTest
@testable import EnsoCore

final class EnsoCoreTests: XCTestCase {
    func testQuicFrameCodecRoundTripAndBounds() throws {
        let payload = Data("hello-enso-quic".utf8)
        let framed = try QuicFrameCodec.encodeFrame(payload)
        XCTAssertEqual(framed.count, 4 + payload.count)
        let decodedLen = try QuicFrameCodec.decodeLengthPrefix(framed.prefix(4))
        XCTAssertEqual(decodedLen, payload.count)
        XCTAssertEqual(framed.dropFirst(4), payload)

        let oversized = Data(count: QuicFrameCodec.maxFrameBytes + 1)
        XCTAssertThrowsError(try QuicFrameCodec.encodeFrame(oversized)) { err in
            XCTAssertEqual(err as? EnsoQuicCodecError, .frameTooLarge(QuicFrameCodec.maxFrameBytes + 1))
        }
    }

    func testExtractDeskTunnelPath() {
        XCTAssertNil(LocalWebServer.extractDeskTunnelPath(from: "/desk"))
        XCTAssertNil(LocalWebServer.extractDeskTunnelPath(from: "/desk.html"))
        XCTAssertEqual(
            LocalWebServer.extractDeskTunnelPath(from: "/desk/pair-1/v123/assets/index.js"),
            "r/assets/index.js"
        )
        XCTAssertEqual(
            LocalWebServer.extractDeskTunnelPath(from: "/desk/pair-1/v123/"),
            "r/index.html"
        )
        XCTAssertEqual(
            LocalWebServer.extractDeskTunnelPath(from: "/desk/li/pair-1/avatar.png"),
            "li/avatar.png"
        )
    }

    @available(macOS 13.0, iOS 16.0, *)
    func testLocalWebServerStaticAndDeskProxyCaching() async throws {
        let tmp = FileManager.default.temporaryDirectory
            .appendingPathComponent("enso-localweb-\(UUID().uuidString)")
        let webDir = tmp.appendingPathComponent("web")
        let cacheDir = tmp.appendingPathComponent("cache")
        try FileManager.default.createDirectory(at: webDir, withIntermediateDirectories: true)
        try "<!doctype html><title>Enso</title>".write(
            to: webDir.appendingPathComponent("index.html"),
            atomically: true,
            encoding: .utf8
        )
        try "<!doctype html><title>Desk</title>".write(
            to: webDir.appendingPathComponent("desk.html"),
            atomically: true,
            encoding: .utf8
        )
        defer { try? FileManager.default.removeItem(at: tmp) }

        let server = LocalWebServer(webRoot: webDir, cacheRoot: cacheDir)
        var fetchCount = 0
        server.deskAssetFetcher = { path, done in
            fetchCount += 1
            done(LocalProxyAsset(status: 200, mime: "application/javascript", body: Data("/*\(path)*/".utf8)))
        }
        let port = try server.start()
        defer { server.stop() }
        XCTAssertGreaterThan(port, 0)

        // 1. Static /desk maps to desk.html
        let (deskData, deskResp) = try await URLSession.shared.data(
            from: URL(string: "http://127.0.0.1:\(port)/desk")!
        )
        XCTAssertEqual((deskResp as? HTTPURLResponse)?.statusCode, 200)
        XCTAssertEqual(String(data: deskData, encoding: .utf8), "<!doctype html><title>Desk</title>")

        // 2. Desk tunnel proxy hits fetcher once, second fetch hits disk cache
        let assetURL = URL(string: "http://127.0.0.1:\(port)/desk/p1/v1/assets/app.js")!
        let (a1, r1) = try await URLSession.shared.data(from: assetURL)
        XCTAssertEqual((r1 as? HTTPURLResponse)?.statusCode, 200)
        XCTAssertEqual(String(data: a1, encoding: .utf8), "/*r/assets/app.js*/")
        XCTAssertEqual(fetchCount, 1)

        let (a2, _) = try await URLSession.shared.data(from: assetURL)
        XCTAssertEqual(String(data: a2, encoding: .utf8), "/*r/assets/app.js*/")
        XCTAssertEqual(fetchCount, 1)
    }

    /// 真实跨语言互通验证：Swift `NWProtocolQUIC` 客户端直连 Go `quic-go` 中继（经由环境变量注入端口与凭据）。
    /// 普通 `swift test` 未设置环境变量时自动跳过；由 `scripts/verify-quic-e2e.sh` 驱动执行真机协议联调。
    @available(macOS 13.0, iOS 16.0, *)
    func testLiveQuicInteropWithGoRelay() throws {
        let env = ProcessInfo.processInfo.environment
        guard let portStr = env["ENSO_QUIC_E2E_PORT"],
              let port = UInt16(portStr),
              let pairId = env["ENSO_QUIC_E2E_PAIR_ID"],
              let token = env["ENSO_QUIC_E2E_TOKEN"]
        else {
            throw XCTSkip("Set ENSO_QUIC_E2E_PORT/PAIR_ID/TOKEN to run live Go↔Swift QUIC interop")
        }

        final class Collector: QuicRelayConnectionDelegate {
            let openExp: XCTestExpectation
            let onlineExp: XCTestExpectation
            let pongExp: XCTestExpectation
            let ctrlExp: XCTestExpectation
            let bulkExp: XCTestExpectation
            var ctrlData = Data()
            var bulkData = Data()
            var closeReason: String?

            init(test: XCTestCase) {
                openExp = test.expectation(description: "quic-open")
                onlineExp = test.expectation(description: "host-online")
                pongExp = test.expectation(description: "pong")
                ctrlExp = test.expectation(description: "ctrl-frame")
                bulkExp = test.expectation(description: "bulk-frame")
            }

            func quicConnectionDidOpen(_ id: String) {
                openExp.fulfill()
            }

            func quicConnection(_ id: String, didReceiveControlText text: String) {
                if text.contains("\"host-online\"") {
                    onlineExp.fulfill()
                } else if text.contains("\"pong\"") {
                    pongExp.fulfill()
                }
            }

            func quicConnection(_ id: String, didReceiveBinaryFrame data: Data, lane: EnsoQuicLane) {
                if lane == .ctrl {
                    ctrlData = data
                    ctrlExp.fulfill()
                } else {
                    bulkData = data
                    bulkExp.fulfill()
                }
            }

            func quicConnection(_ id: String, didCloseWithCode code: Int, reason: String) {
                closeReason = "\(code):\(reason)"
            }
        }

        let collector = Collector(test: self)
        let cfg = EnsoQuicConfig(
            id: "e2e-1",
            host: "127.0.0.1",
            port: port,
            alpn: QuicFrameCodec.alpn,
            hello: EnsoQuicHello(pairId: pairId, role: "guest", token: token),
            allowInsecureSelfSigned: true
        )
        let conn = QuicRelayConnection(config: cfg, delegate: collector)
        conn.start()
        defer { conn.close() }

        wait(for: [collector.openExp, collector.onlineExp], timeout: 5.0)

        // 1. Control stream ping -> pong
        conn.sendControlText("{\"type\":\"ping\",\"id\":7}")
        wait(for: [collector.pongExp], timeout: 3.0)

        // 2. Send small ctrl + large bulk payloads; Go test host echoes both back via WS -> QUIC
        let small = Data("swift-nwquic-ctrl".utf8)
        let large = Data(repeating: 0x5A, count: 20_000)
        conn.sendBinary(small, lane: .ctrl)
        conn.sendBinary(large, lane: .bulk)

        wait(for: [collector.ctrlExp, collector.bulkExp], timeout: 5.0)
        XCTAssertEqual(collector.ctrlData, small)
        XCTAssertEqual(collector.bulkData, large)
    }
}
