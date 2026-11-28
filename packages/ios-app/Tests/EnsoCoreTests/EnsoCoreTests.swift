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

    func testWebPushAes128GcmDecryptMatchesNodeWebPushVector() throws {
        // 由 Node `web-push@3` 真实加密生成的 RFC 8291 (aes128gcm) 向量，验证跨语言完全互通
        let privRaw = Data(base64Encoded: "V/e+tQlacuWCtqUdY9Yro2AApuh6gWRNDVbXkoupirk=")!
        let pubX963 = Data(base64Encoded: "BOPaN7SWJ8FSok+CNlm+VQY4MpYDWT/OEOHVtJdKu/jJm6LWB2GJiwDVagQSGb7UimUkuGhaSxFV8Y5RBn5MjCg=")!
        let auth = Data(base64Encoded: "LVdRQGAIMCCW7QPTvTppgA==")!
        let cipherB64 = "H2n3fRbncNzU6sIPppJERwAAEABBBKM6QPoA2/MQfDzXYRoLdP6/QDegWqyES6/oR3EMKy3opDfJJbiv6573XSKhea373E/aeyF3BZf/EB0Ey1xEoaLd+pi3CFKZxkC4CEADUwCPBmHOsUBOIBmCyJjC4p/wIT/LVuuOF2T45I/TrL4wJZ59F0ulM7uxD23xMO4EB50LceUTa309WdA46APhgVTzGzshbq7WBo70jS7N2l4GXafpAt6Ypbf35XJM1f26pKne8CcjPVxgGb5p"
        let material = WebPushKeyMaterial(privateKeyRaw: privRaw, publicKeyX963: pubX963, authSecret: auth)

        let payload = try WebPushCrypto.decryptPushPayload(ciphertextBase64: cipherB64, keys: material)
        XCTAssertEqual(payload.title, "EnsoCode · 测试会话")
        XCTAssertEqual(payload.body, "命令 ls 等待审批")
        XCTAssertEqual(payload.sessionId, "sess-1")
        XCTAssertEqual(payload.pending, true)

        // 篡改密文末字节应抛出解密失败
        var tampered = Data(base64Encoded: cipherB64)!
        tampered[tampered.count - 1] ^= 0xFF
        XCTAssertThrowsError(
            try WebPushCrypto.decryptAes128Gcm(ciphertext: tampered, privateKeyRaw: privRaw, authSecret: auth)
        ) { err in
            XCTAssertEqual(err as? WebPushCryptoError, .decryptFailed)
        }

        // VAPID 公钥指纹校验
        let vHash = try WebPushCrypto.vapidKeyHash(vapidPublicKeyBase64Url: material.p256dhBase64Url)
        XCTAssertEqual(vHash.count, 43)
        XCTAssertThrowsError(try WebPushCrypto.vapidKeyHash(vapidPublicKeyBase64Url: "too-short"))
    }

    func testExtractDeskTunnelPath() {
        XCTAssertNil(LocalWebServer.extractDeskTunnelPath(from: "/desk"))
        XCTAssertNil(LocalWebServer.extractDeskTunnelPath(from: "/desk.html"))
        XCTAssertEqual(
            LocalWebServer.extractDeskTunnelPath(from: "/desk/r/pair-1/v123/assets/index.js"),
            "r/assets/index.js"
        )
        XCTAssertEqual(
            LocalWebServer.extractDeskTunnelPath(from: "/desk/r/pair-1/v123/"),
            "r/index.html"
        )
        XCTAssertEqual(
            LocalWebServer.extractDeskTunnelPath(from: "/desk/li/pair-1/local-image%3A%2F%2Fsecretary-avatar%3Fs%3D1"),
            "li/local-image%3A%2F%2Fsecretary-avatar%3Fs%3D1"
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
        let assetURL = URL(string: "http://127.0.0.1:\(port)/desk/r/p1/v1/assets/app.js")!
        let (a1, r1) = try await URLSession.shared.data(from: assetURL)
        XCTAssertEqual((r1 as? HTTPURLResponse)?.statusCode, 200)
        XCTAssertEqual(String(data: a1, encoding: .utf8), "/*r/assets/app.js*/")
        XCTAssertEqual(fetchCount, 1)

        let (a2, _) = try await URLSession.shared.data(from: assetURL)
        XCTAssertEqual(String(data: a2, encoding: .utf8), "/*r/assets/app.js*/")
        XCTAssertEqual(fetchCount, 1)

        // 模拟 iOS 后台回收后 stop -> ensureRunning() 恢复同一端口
        server.stop()
        XCTAssertFalse(server.isRunning)
        let recoveredPort = try server.ensureRunning()
        XCTAssertTrue(server.isRunning)
        XCTAssertEqual(recoveredPort, port)
        let (a3, resp3) = try await URLSession.shared.data(from: server.baseURL)
        XCTAssertEqual((resp3 as? HTTPURLResponse)?.statusCode, 200)
        XCTAssertEqual(String(data: a3, encoding: .utf8), "<!doctype html><title>Enso</title>")
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

    func testSharedWidgetStoreRoundTripAndMergePushNotification() throws {
        let tmpDir = FileManager.default.temporaryDirectory
            .appendingPathComponent("enso-widget-test-\(UUID().uuidString)", isDirectory: true)
        defer { try? FileManager.default.removeItem(at: tmpDir) }

        let store = SharedWidgetStore(directory: tmpDir)
        XCTAssertNil(store.load())

        let initial = EnsoWidgetSnapshot(
            deviceLabel: "MacBook Pro",
            connectionState: "online",
            transport: "direct",
            rttMs: 14,
            runningCount: 1,
            pendingCount: 0,
            unreadCount: 0,
            activeTitle: "构建 iOS 小组件",
            activeProject: "enso-code",
            activeSessionId: "s-1",
            activeStatus: "running",
            activeDetail: "正在编译",
            startedAt: 1_700_000_000_000,
            sessions: [
                EnsoWidgetSessionItem(
                    id: "s-1",
                    title: "构建 iOS 小组件",
                    projectName: "enso-code",
                    status: "running",
                    pendingCount: 0,
                    unread: false,
                    updatedAt: 1_700_000_000_000
                ),
            ],
            updatedAt: 1_700_000_000_000
        )
        XCTAssertTrue(store.save(initial))
        XCTAssertEqual(store.load(), initial)

        let merged = store.mergePushNotification(
            title: "构建 iOS 小组件",
            body: "请求执行 bash 命令",
            sessionId: "s-1",
            pending: true,
            nowMs: 1_700_000_050_000
        )
        XCTAssertEqual(merged.pendingCount, 1)
        XCTAssertEqual(merged.activeStatus, "pending")
        XCTAssertEqual(merged.activeDetail, "请求执行 bash 命令")
        XCTAssertEqual(merged.sessions.first?.status, "waiting")
        XCTAssertEqual(merged.sessions.first?.pendingCount, 1)
        XCTAssertEqual(store.load(), merged)

        let url = EnsoWidgetSnapshot.deepLinkURL(sessionId: "s-1")
        XCTAssertEqual(url.absoluteString, "enso://open?session=s-1")
    }
}
