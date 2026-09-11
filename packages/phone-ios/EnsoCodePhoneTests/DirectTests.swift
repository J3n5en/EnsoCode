import XCTest
@testable import EnsoCodePhone

final class TimelineBuilderTests: XCTestCase {
  func testMergesToolResultIntoCall() {
    let call = ProjectedMessage.parse([
      "role": "assistant",
      "content": [["type": "toolCall", "id": "c1", "name": "read", "arguments": ["path": "/tmp/a.ts"]]],
    ])
    let result = ProjectedMessage.parse([
      "role": "toolResult",
      "toolCallId": "c1",
      "content": [["type": "text", "text": "ok"]],
    ])
    let items = TimelineBuilder.build(
      messages: [(0, call), (1, result)],
      running: false,
      cwd: "/tmp",
      approvals: [],
      compaction: nil
    )
    XCTAssertEqual(items.map(\.kind), [.tool])
    XCTAssertEqual(items[0].name, "read")
    XCTAssertEqual(items[0].summary, "a.ts")
    XCTAssertEqual(items[0].state, "ok")
    XCTAssertEqual(items[0].output, "ok")
  }

  func testUserAndAssistantText() {
    let user = ProjectedMessage.parse([
      "role": "user",
      "content": [["type": "text", "text": "hello"]],
    ])
    let asst = ProjectedMessage.parse([
      "role": "assistant",
      "content": [["type": "text", "text": "hi"]],
    ])
    let items = TimelineBuilder.build(
      messages: [(0, user), (1, asst)],
      running: false,
      cwd: nil,
      approvals: [],
      compaction: nil
    )
    XCTAssertEqual(items.map(\.kind), [.user, .text])
    XCTAssertEqual(items[0].text, "hello")
    XCTAssertEqual(items[1].text, "hi")
  }

  func testRunningToolWithoutResult() {
    let call = ProjectedMessage.parse([
      "role": "assistant",
      "content": [["type": "toolCall", "id": "c1", "name": "bash", "arguments": ["command": "ls"]]],
    ])
    let items = TimelineBuilder.build(
      messages: [(0, call)],
      running: true,
      cwd: nil,
      approvals: [],
      compaction: nil
    )
    XCTAssertEqual(items[0].state, "running")
  }
}

final class MarkdownParseTests: XCTestCase {
  func testParagraphsListsAndCode() {
    let src = """
    # Title

    hello
    world

    - a
      - nested
    - b

    ```swift
    let x = 1
    ```
    """
    let blocks = MarkdownParse.parse(src)
    XCTAssertEqual(blocks.count, 4)
    XCTAssertEqual(blocks[0], .heading(1, "Title"))
    XCTAssertEqual(blocks[1], .paragraph("hello world"))
    if case .list(_, let items) = blocks[2] {
      XCTAssertEqual(items.map(\.text), ["a", "nested", "b"])
      XCTAssertEqual(items.map(\.indent), [0, 1, 0])
    } else {
      XCTFail("expected list")
    }
    XCTAssertEqual(blocks[3], .code(lang: "swift", body: "let x = 1"))
  }
}

final class NetworkIdentityTests: XCTestCase {
  func testSameLinkDoesNotChange() {
    let a = NetworkIdentity(online: true, wifi: true, cellular: false, wired: false)
    let b = NetworkIdentity(online: true, wifi: true, cellular: false, wired: false)
    XCTAssertEqual(a, b)
  }

  func testWifiToCellularChanges() {
    let wifi = NetworkIdentity(online: true, wifi: true, cellular: false, wired: false)
    let cell = NetworkIdentity(online: true, wifi: false, cellular: true, wired: false)
    XCTAssertNotEqual(wifi, cell)
  }
}

final class TimelineFoldTests: XCTestCase {
  func testCompactFoldsReadonlyTools() {
    var user = TimelineItem(id: "u0", kind: .user, text: "go")
    let tools = (1...4).map { i -> TimelineItem in
      var t = TimelineItem(id: "t\(i)", kind: .tool)
      t.toolName = i == 2 ? "grep" : "read"
      t.name = t.toolName
      t.summary = "f.ts"
      t.state = "ok"
      return t
    }
    let folded = TimelineFold.fold([user] + tools, running: false, expandedKeys: [], compact: true)
    XCTAssertEqual(folded.map(\.kind), [.user, .toolGroup])
    XCTAssertEqual(folded[1].groupCount, 4)
  }

  func testCompactFoldsSingleReadImmediately() {
    var user = TimelineItem(id: "u0", kind: .user, text: "go")
    var read = TimelineItem(id: "t1", kind: .tool)
    read.toolName = "read"
    read.name = "read"
    read.summary = "a.ts"
    read.state = "ok"
    let folded = TimelineFold.fold([user, read], running: false, expandedKeys: [], compact: true)
    XCTAssertEqual(folded.map(\.kind), [.user, .toolGroup])
    XCTAssertEqual(folded[1].groupCount, 1)
  }

  func testLiveSegmentNotFoldedWhenNotCompact() {
    var user = TimelineItem(id: "u0", kind: .user, text: "go")
    let tools = (1...4).map { i -> TimelineItem in
      var t = TimelineItem(id: "t\(i)", kind: .tool)
      t.toolName = "bash"
      t.name = "bash"
      t.summary = "npm test"
      t.state = "running"
      return t
    }
    let folded = TimelineFold.fold([user] + tools, running: true, expandedKeys: [], compact: false)
    XCTAssertEqual(folded.filter { $0.kind == .tool }.count, 4)
    XCTAssertFalse(folded.contains { $0.kind == .toolGroup })
  }
}
