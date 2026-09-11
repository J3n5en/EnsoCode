import XCTest
@testable import EnsoCodePhone

final class EncodingTests: XCTestCase {
  func testBase64URLRoundtrip() {
    let data = Data([0, 1, 2, 250, 251, 255])
    let encoded = Base64URL.encode(data)
    XCTAssertFalse(encoded.contains("+"))
    XCTAssertFalse(encoded.contains("/"))
    XCTAssertFalse(encoded.contains("="))
    XCTAssertEqual(Base64URL.decode(encoded), data)
  }
}

final class CryptoTests: XCTestCase {
  func testSealOpenRoundtrip() throws {
    let key = PairCrypto.generateContentKey()
    for payload: Any in [
      ["type": "prompt", "sessionId": "s1", "text": "你好，世界"],
      [1, 2, 3, "a"] as [Any],
      ["nested": ["a": [true, NSNull(), "x"] as [Any]]] as [String: Any],
    ] {
      let frame = try PairCrypto.sealFrame(contentKey: key, payload: payload)
      XCTAssertEqual(frame[0], 1)
      let opened = try PairCrypto.openFrame(contentKey: key, frame: frame)
      let opts: JSONSerialization.WritingOptions = [.sortedKeys, .fragmentsAllowed]
      let a = try JSONSerialization.data(withJSONObject: payload, options: opts)
      let b = try JSONSerialization.data(withJSONObject: opened, options: opts)
      XCTAssertEqual(a, b)
    }
  }

  func testNonceRandom() throws {
    let key = PairCrypto.generateContentKey()
    let a = try PairCrypto.sealFrame(contentKey: key, payload: ["x": 1])
    let b = try PairCrypto.sealFrame(contentKey: key, payload: ["x": 1])
    XCTAssertNotEqual(a, b)
  }

  func testWrongKeyFails() throws {
    let frame = try PairCrypto.sealFrame(contentKey: PairCrypto.generateContentKey(), payload: ["secret": 1])
    XCTAssertThrowsError(try PairCrypto.openFrame(contentKey: PairCrypto.generateContentKey(), frame: frame))
  }

  func testTamperFails() throws {
    let key = PairCrypto.generateContentKey()
    var frame = try PairCrypto.sealFrame(contentKey: key, payload: ["secret": 1])
    frame[frame.count - 1] ^= 0xff
    XCTAssertThrowsError(try PairCrypto.openFrame(contentKey: key, frame: frame))
  }

  func testVersionAndShortFrame() throws {
    let key = PairCrypto.generateContentKey()
    var frame = try PairCrypto.sealFrame(contentKey: key, payload: ["x": 1])
    frame[0] = 9
    XCTAssertThrowsError(try PairCrypto.openFrame(contentKey: key, frame: frame))
    XCTAssertThrowsError(try PairCrypto.openFrame(contentKey: key, frame: Data([1, 2, 3])))
  }

  func testInvalidKeyLength() {
    XCTAssertThrowsError(try PairCrypto.sealFrame(contentKey: Data(count: 16), payload: ["x": 1]))
  }

  func testNaClBoxRoundtrip() throws {
    let host = NaClBox.keypair()
    let contentKey = PairCrypto.generateContentKey()
    let boxed = try PairCrypto.boxContentKey(contentKey, recipientPublicKey: host.publicKey)
    let recovered = try PairCrypto.openBoxedContentKey(boxed, recipientSecretKey: host.secretKey)
    XCTAssertEqual(recovered, contentKey)
  }

  func testWrongSecretUnboxFails() {
    let host = NaClBox.keypair()
    let wrong = NaClBox.keypair()
    let boxed = try? PairCrypto.boxContentKey(PairCrypto.generateContentKey(), recipientPublicKey: host.publicKey)
    XCTAssertNotNil(boxed)
    XCTAssertThrowsError(try PairCrypto.openBoxedContentKey(boxed!, recipientSecretKey: wrong.secretKey))
  }

  func testBoxThenSeal() throws {
    let host = NaClBox.keypair()
    let contentKey = PairCrypto.generateContentKey()
    let boxed = try PairCrypto.boxContentKey(contentKey, recipientPublicKey: host.publicKey)
    let hostKey = try PairCrypto.openBoxedContentKey(boxed, recipientSecretKey: host.secretKey)
    let frame = try PairCrypto.sealFrame(contentKey: contentKey, payload: ["type": "snapshot"])
    let opened = try PairCrypto.openFrame(contentKey: hostKey, frame: frame) as? [String: Any]
    XCTAssertEqual(opened?["type"] as? String, "snapshot")
  }
}

final class URITests: XCTestCase {
  func testParseCustomScheme() throws {
    let pk = Base64URL.encode(Data(count: 32))
    let invite = try PairURI.parse("enso://pair?relay=https%3A%2F%2Fenso-relay.j3.do&pk=\(pk)")
    XCTAssertEqual(invite.relay, "https://enso-relay.j3.do")
    XCTAssertEqual(invite.publicKey.count, 32)
  }

  func testParseHttpsFragment() throws {
    let pk = Base64URL.encode(Data(repeating: 7, count: 32))
    let invite = try PairURI.parse("https://enso-relay.j3.do/#relay=https%3A%2F%2Fenso-relay.j3.do&pk=\(pk)")
    XCTAssertEqual(invite.relay, "https://enso-relay.j3.do")
    XCTAssertEqual(invite.publicKey, Data(repeating: 7, count: 32))
  }

  func testParseHttpsFallbackRelay() throws {
    let pk = Base64URL.encode(Data(repeating: 1, count: 32))
    let invite = try PairURI.parse("https://enso-relay.j3.do/#pk=\(pk)")
    XCTAssertEqual(invite.relay, "https://enso-relay.j3.do")
  }

  func testRejectsGarbage() {
    XCTAssertThrowsError(try PairURI.parse("hello"))
  }
}

final class DeviceListTests: XCTestCase {
  func testUpsertRenameRemovePick() {
    let a = PairedDevice(pairId: "a", token: "t", contentKey: "k", deviceName: "iPhone", relayUrl: "https://r", pairedAt: 1)
    var list = DeviceList.upsert([], a)
    XCTAssertEqual(list[0].label, "电脑 1")
    list = DeviceList.rename(list, pairId: "a", label: "书房")
    XCTAssertEqual(list[0].label, "书房")
    let b = PairedDevice(pairId: "b", token: "t2", contentKey: "k2", deviceName: "iPhone", relayUrl: "https://r", pairedAt: 2)
    list = DeviceList.upsert(list, b)
    XCTAssertEqual(list[1].label, "电脑 1")
    XCTAssertEqual(DeviceList.pickActive(list, activeId: "b")?.pairId, "b")
    list = DeviceList.remove(list, pairId: "b")
    XCTAssertEqual(DeviceList.pickActive(list, activeId: "b")?.pairId, "a")
  }
}

final class ProjectionTests: XCTestCase {
  func testUpsertAndTruncate() {
    var view = GuestSessionView()
    let msg: [String: Any] = ["role": "user", "content": [["type": "text", "text": "hi"]]]
    let r1 = GuestProjection.applyEvent(view, event: ["type": "message-upsert", "index": 0, "message": msg])
    view = r1.view
    XCTAssertEqual(r1.lastIndex, 0)
    let r2 = GuestProjection.applyEvent(view, event: ["type": "messages-truncated", "length": 0])
    XCTAssertEqual(r2.lastIndex, -1)
    XCTAssertTrue(r2.view.messages.isEmpty)
  }

  func testSnapshotGapClears() {
    var sessions: [String: GuestSessionView] = [:]
    var first = GuestSessionView()
    first.messages[0] = ProjectedMessage.parse(["role": "user", "content": []])
    sessions["s"] = first
    let event: [String: Any] = [
      "sessions": [[
        "sessionId": "s",
        "baseIndex": 5,
        "messages": [["role": "assistant", "content": [["type": "text", "text": "later"]]]],
        "status": "idle",
      ]],
    ]
    let out = GuestProjection.applySnapshot(sessions: sessions, event: event)
    XCTAssertEqual(out[0].view.messages.keys.sorted(), [5])
  }

  func testGhostCatalog() {
    var t = SyncTracking(state: .syncing, knownIds: ["a"])
    let (next, ghost) = SyncProjection.applyCatalog(t, subscribedId: "a", catalogIds: ["b"])
    XCTAssertTrue(ghost)
    XCTAssertEqual(next.state, .synced)
  }

  func testSubscribeFreshSkipsSyncing() {
    let t = SyncProjection.applySubscribe(SyncTracking(), sessionId: "new", fresh: true)
    XCTAssertEqual(t.state, .synced)
  }
}

final class CommandTests: XCTestCase {
  func testSubscribeNull() {
    let json = PhoneCommand.subscribe(sessionId: nil, sinceIndex: nil).json()
    XCTAssertTrue(json["sessionId"] is NSNull)
    XCTAssertEqual(json["type"] as? String, "subscribe")
  }

  func testSpawnOmitsReasoningWhenOff() {
    let json = PhoneCommand.spawn(
      sessionId: "s",
      projectId: "p",
      providerId: "prov",
      modelId: "m",
      approvalMode: .full,
      reasoningEnabled: nil,
      thinkingLevel: nil
    ).json()
    XCTAssertNil(json["reasoningEnabled"])
    XCTAssertNil(json["thinkingLevel"])
    XCTAssertEqual(json["approvalMode"] as? String, "full")
  }
}
