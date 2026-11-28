import CoreMedia
import CoreVideo
import Foundation
import SwiftUI
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

    func testPiPSnapshotDecodesFrontendJsonWithNullsAndIntegerTimestamps() throws {
        let json = """
        {
          "sessionId": "s-9",
          "title": "修复画中画",
          "projectName": "enso-code",
          "status": "pending",
          "pendingHint": null,
          "runningCount": 1,
          "pendingCount": 1,
          "connectionState": "online",
          "updatedAt": 1700000000123,
          "messages": [
            { "id": "m1", "role": "user", "text": "跑一下测试", "toolName": null, "isStreaming": false, "isError": false, "timestamp": 1700000000000 },
            { "id": "m2", "role": "assistant", "text": "好的", "isStreaming": true, "timestamp": 1700000000100 }
          ]
        }
        """
        let snapshot = try JSONDecoder().decode(EnsoPiPSnapshot.self, from: Data(json.utf8))
        XCTAssertEqual(snapshot.sessionId, "s-9")
        XCTAssertNil(snapshot.pendingHint)
        XCTAssertEqual(snapshot.updatedAt, 1_700_000_000_123)
        XCTAssertEqual(snapshot.messages.count, 2)
        XCTAssertNil(snapshot.messages[0].toolName)
        XCTAssertEqual(snapshot.messages[0].timestamp, 1_700_000_000_000)
        XCTAssertTrue(snapshot.messages[1].isStreaming)
        XCTAssertFalse(snapshot.messages[1].isError)

        let roundTripped = try JSONDecoder().decode(
            EnsoPiPSnapshot.self,
            from: JSONEncoder().encode(snapshot)
        )
        XCTAssertEqual(roundTripped, snapshot)

        let minimal = try JSONDecoder().decode(EnsoPiPSnapshot.self, from: Data("{\"sessionId\":null}".utf8))
        XCTAssertNil(minimal.sessionId)
        XCTAssertEqual(minimal.status, "idle")
        XCTAssertEqual(minimal.connectionState, "offline")
        XCTAssertTrue(minimal.messages.isEmpty)

        XCTAssertThrowsError(
            try JSONDecoder().decode(EnsoPiPMessage.self, from: Data("{\"role\":\"user\",\"text\":\"x\"}".utf8))
        )
    }

    func testPiPSnapshotSanitizedForDisplayFiltersCapsAndTruncates() {
        func msg(_ id: String, _ role: String, _ text: String, tool: String? = nil, streaming: Bool = false) -> EnsoPiPMessage {
            EnsoPiPMessage(id: id, role: role, text: text, toolName: tool, isStreaming: streaming, timestamp: 0)
        }
        var messages = [
            msg("blank", "assistant", "  \n\t "),
            msg("tool", "tool", " ", tool: "bash"),
            msg("stream", "assistant", "", streaming: true),
            msg("blank-tool-name", "tool", "", tool: "   "),
        ]
        messages += (0..<20).map { msg("m\($0)", "assistant", "  第 \($0) 条\n") }
        messages.append(msg("long", "assistant", String(repeating: "长", count: 1_000)))
        messages.append(msg("emoji", "user", String(repeating: "👨‍👩‍👧", count: 700)))

        let snapshot = EnsoPiPSnapshot(
            sessionId: "   ",
            title: " \n ",
            projectName: "enso-code",
            status: "running",
            pendingHint: "  ",
            runningCount: -2,
            pendingCount: 0,
            connectionState: "online",
            messages: messages,
            updatedAt: 42
        )

        let short = snapshot.sanitizedForDisplay(maxMessages: 30)
        let ids = short.messages.map(\.id)
        XCTAssertFalse(ids.contains("blank"))
        XCTAssertFalse(ids.contains("blank-tool-name"))
        XCTAssertTrue(ids.contains("tool"))
        XCTAssertTrue(ids.contains("stream"))
        XCTAssertEqual(short.messages.first(where: { $0.id == "tool" })?.toolName, "bash")
        XCTAssertEqual(short.messages.first(where: { $0.id == "m3" })?.text, "第 3 条")
        XCTAssertNil(short.sessionId)
        XCTAssertNil(short.pendingHint)
        XCTAssertEqual(short.title, EnsoPiPSnapshot.placeholder.title)
        XCTAssertEqual(short.runningCount, 0)

        let long = short.messages.first(where: { $0.id == "long" })!
        XCTAssertEqual(long.text.count, 1000)
        let veryLong = EnsoPiPSnapshot(
            sessionId: "s",
            title: "t",
            projectName: "p",
            status: "running",
            pendingHint: nil,
            runningCount: 1,
            pendingCount: 0,
            connectionState: "online",
            messages: [msg("emoji", "user", String(repeating: "👨‍👩‍👧", count: 1500))],
            updatedAt: 1
        ).sanitizedForDisplay()
        XCTAssertEqual(veryLong.messages.first?.text, String(repeating: "👨‍👩‍👧", count: 1400) + "…")

        let capped = snapshot.sanitizedForDisplay()
        XCTAssertEqual(capped.messages.count, 18)
        XCTAssertEqual(capped.messages.last?.id, "emoji")
        XCTAssertEqual(capped.messages.first?.id, "m4")

        XCTAssertTrue(snapshot.sanitizedForDisplay(maxMessages: 0).messages.isEmpty)
        XCTAssertTrue(snapshot.sanitizedForDisplay(maxMessages: -1).messages.isEmpty)
        XCTAssertEqual(EnsoPiPSnapshot.placeholder.sanitizedForDisplay(), EnsoPiPSnapshot.placeholder)
    }

    func testPiPStatusPayloadEncodesStableShape() throws {
        let idle = EnsoPiPStatusPayload(supported: true, active: false, auto: true, error: nil)
        let idleObj = try XCTUnwrap(
            JSONSerialization.jsonObject(with: JSONEncoder().encode(idle)) as? [String: Any]
        )
        XCTAssertEqual(Set(idleObj.keys), ["supported", "active", "auto", "aspect", "error"])
        XCTAssertTrue(idleObj["error"] is NSNull)
        XCTAssertEqual(idleObj["supported"] as? Bool, true)
        XCTAssertEqual(idleObj["auto"] as? Bool, true)
        XCTAssertEqual(idleObj["aspect"] as? String, "portrait")

        let failed = EnsoPiPStatusPayload(supported: false, active: false, auto: false, error: "画中画不可用")
        let decoded = try JSONDecoder().decode(EnsoPiPStatusPayload.self, from: JSONEncoder().encode(failed))
        XCTAssertEqual(decoded, failed)
        XCTAssertEqual(
            try JSONDecoder().decode(EnsoPiPStatusPayload.self, from: JSONEncoder().encode(idle)),
            idle
        )

        XCTAssertEqual(EnsoPiPAspect(rawOrDefault: "square"), .square)
        XCTAssertEqual(EnsoPiPAspect(rawOrDefault: "invalid"), .portrait)
        XCTAssertGreaterThan(EnsoPiPAspect.portrait.preferredContentSize.height, EnsoPiPAspect.portrait.preferredContentSize.width)
        XCTAssertGreaterThan(EnsoPiPAspect.landscape.preferredContentSize.width, EnsoPiPAspect.landscape.preferredContentSize.height)
    }

    @MainActor
    func testPiPFrameEncoderProducesRightSideUpIOSurfaceDisplayImmediatelySampleBuffer() throws {
        let odd = EnsoPiPFrameEncoder.pixelDimensions(for: CGSize(width: 101, height: 51), scale: 1)
        XCTAssertEqual(odd.width, 102)
        XCTAssertEqual(odd.height, 52)

        let view = VStack(spacing: 0) {
            Color(red: 1, green: 0, blue: 0)
            Color(red: 0, green: 0, blue: 1)
        }
        let sample = try XCTUnwrap(
            EnsoPiPFrameEncoder.encode(view: view, size: CGSize(width: 60, height: 80), scale: 2)
        )

        let imageBuffer = try XCTUnwrap(CMSampleBufferGetImageBuffer(sample))
        XCTAssertEqual(CVPixelBufferGetWidth(imageBuffer), 120)
        XCTAssertEqual(CVPixelBufferGetHeight(imageBuffer), 160)
        XCTAssertNotNil(CVPixelBufferGetIOSurface(imageBuffer))

        let attachments = try XCTUnwrap(
            CMSampleBufferGetSampleAttachmentsArray(sample, createIfNecessary: false) as? [[CFString: Any]]
        )
        XCTAssertEqual(attachments.first?[kCMSampleAttachmentKey_DisplayImmediately] as? Bool, true)

        CVPixelBufferLockBaseAddress(imageBuffer, .readOnly)
        defer { CVPixelBufferUnlockBaseAddress(imageBuffer, .readOnly) }
        let base = try XCTUnwrap(CVPixelBufferGetBaseAddress(imageBuffer)).assumingMemoryBound(to: UInt8.self)
        let bpr = CVPixelBufferGetBytesPerRow(imageBuffer)

        // 32BGRA: byte 0 = B, byte 1 = G, byte 2 = R, byte 3 = A
        // Row 10 (top half) must be red; row 150 (bottom half) must be blue.
        let topOffset = 10 * bpr + 60 * 4
        let topB = base[topOffset]
        let topR = base[topOffset + 2]
        XCTAssertGreaterThan(topR, 200, "top half should be red (R=\(topR), B=\(topB))")
        XCTAssertLessThan(topB, 40, "top half should not be blue (R=\(topR), B=\(topB))")

        let botOffset = 150 * bpr + 60 * 4
        let botB = base[botOffset]
        let botR = base[botOffset + 2]
        XCTAssertGreaterThan(botB, 200, "bottom half should be blue (R=\(botR), B=\(botB))")
        XCTAssertLessThan(botR, 40, "bottom half should not be red (R=\(botR), B=\(botB))")
    }
}
