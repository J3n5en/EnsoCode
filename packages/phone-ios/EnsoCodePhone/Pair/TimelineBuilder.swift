import Foundation

enum TimelineKind: Equatable {
  case user
  case text
  case thinking
  case tool
  case toolGroup
  case error
  case compaction
  case compactionProgress
  case taskNote
}

struct TimelineItem: Equatable, Identifiable {
  var id: String
  var kind: TimelineKind
  var text: String = ""
  var images: [(data: String, mimeType: String)] = []
  var streaming: Bool = false
  var name: String = ""
  var toolName: String = ""
  var summary: String = ""
  var output: String = ""
  var state: String = "ok"
  var durationMs: Int? = nil
  var tokensBefore: Int? = nil
  var todos: [TodoItem] = []
  var edits: [(oldText: String, newText: String)] = []
  var writeContent: String? = nil
  var groupCount: Int = 0
  var stats: ToolGroupStats = ToolGroupStats()
  var exploring: Bool = false
  var expanded: Bool = false
  var children: [TimelineItem] = []

  static func == (lhs: TimelineItem, rhs: TimelineItem) -> Bool {
    lhs.id == rhs.id && lhs.kind == rhs.kind && lhs.text == rhs.text && lhs.streaming == rhs.streaming
      && lhs.state == rhs.state && lhs.summary == rhs.summary && lhs.output == rhs.output
      && lhs.todos == rhs.todos && lhs.expanded == rhs.expanded && lhs.groupCount == rhs.groupCount
  }
}

enum TimelineBuilder {
  static func build(
    messages: [(Int, ProjectedMessage)],
    running: Bool,
    cwd: String?,
    approvals: [ApprovalRequestInfo],
    compaction: String?
  ) -> [TimelineItem] {
    var results: [String: (output: String, isError: Bool, todos: [TodoItem], durationMs: Int?, editDiff: (String, String)?)] = [:]
    for (_, message) in messages {
      if message.role == "toolResult", let id = message.toolCallId {
        results[id] = (
          output: partText(message),
          isError: message.isError,
          todos: message.todos,
          durationMs: message.toolDurationMs,
          editDiff: message.editDiff
        )
      }
    }

    var lastTurnIndex = -1
    for (i, pair) in messages.enumerated().reversed() {
      if pair.1.role != "toolResult" {
        lastTurnIndex = i
        break
      }
    }

    let reviewing = Set(approvals.compactMap { $0.phase == "reviewing" ? $0.toolCallId : nil })
    var items: [TimelineItem] = []

    for (messageIndex, pair) in messages.enumerated() {
      let (absIndex, message) = pair
      let isLastMessage = messageIndex == messages.count - 1
      if message.role == "user" {
        let text = partText(message)
        let images = message.content.compactMap { part -> (String, String)? in
          if case .image(let data, let mime) = part { return (data, mime) }
          return nil
        }
        if let note = backgroundNote(text), images.isEmpty {
          items.append(TimelineItem(id: "\(absIndex)", kind: .taskNote, text: note))
          continue
        }
        if !text.isEmpty || !images.isEmpty {
          items.append(TimelineItem(id: "\(absIndex)", kind: .user, text: text, images: images))
        }
        continue
      }
      if message.role == "compactionSummary" {
        items.append(
          TimelineItem(
            id: "\(absIndex)",
            kind: .compaction,
            text: partText(message),
            tokensBefore: message.tokensBefore
          )
        )
        continue
      }
      if message.role == "toolResult" { continue }
      if message.role != "assistant" { continue }

      let lastActive = lastActivePartIndex(message.content)
      for (partIndex, part) in message.content.enumerated() {
        let key = "\(absIndex)-\(partIndex)"
        let settled = message.errorMessage != nil
        let streaming = running && isLastMessage && partIndex == lastActive && !settled
        switch part {
        case .text(let raw):
          let trimmed = raw.trimmingCharacters(in: .whitespacesAndNewlines)
          guard !trimmed.isEmpty else { continue }
          for piece in splitThinkingTags(raw) {
            items.append(
              TimelineItem(
                id: items.count == 0 ? key : "\(key)-\(items.count)",
                kind: piece.thinking ? .thinking : .text,
                text: piece.text,
                streaming: streaming
              )
            )
          }
        case .thinking(let raw):
          if !raw.isEmpty {
            items.append(TimelineItem(id: key, kind: .thinking, text: raw, streaming: streaming))
          }
        case .toolCall(let id, let name, let arguments):
          let result = results[id]
          let state: String
          if let result {
            state = result.isError ? "error" : "ok"
          } else if running && messageIndex == lastTurnIndex {
            state = reviewing.contains(id) ? "reviewing" : "running"
          } else if running {
            state = "ok"
          } else {
            state = "error"
          }
          var edits: [(String, String)] = []
          if result?.isError != true {
            edits = extractEdits(name: name, arguments: arguments)
            if edits.isEmpty, let diff = result?.editDiff { edits = [diff] }
          }
          items.append(
            TimelineItem(
              id: key,
              kind: .tool,
              text: result?.output ?? "",
              name: name == "exec" ? "隔离沙箱" : name,
              toolName: name,
              summary: summarizeArgs(arguments, cwd: cwd),
              output: result?.output ?? "",
              state: state,
              durationMs: result?.durationMs,
              todos: result?.todos ?? [],
              edits: edits,
              writeContent: extractWrite(name: name, arguments: arguments)
            )
          )
        case .image(let data, let mime):
          items.append(TimelineItem(id: key, kind: .user, images: [(data, mime)]))
        case .unknown:
          break
        }
      }
      if let err = message.errorMessage, !err.isEmpty {
        let retried = messageIndex + 1 < messages.count && messages[messageIndex + 1].1.role == "assistant"
        let pendingRetry = running && isLastMessage
        if !retried && !pendingRetry {
          items.append(TimelineItem(id: "\(absIndex)-err", kind: .error, text: err))
        }
      }
    }

    if compaction == "running" {
      items.append(TimelineItem(id: "compaction-progress", kind: .compactionProgress, text: "正在压缩上下文…"))
    } else if compaction == "queued" {
      items.append(TimelineItem(id: "compaction-progress", kind: .compactionProgress, text: "压缩排队中…"))
    }
    return items
  }

  static func partText(_ message: ProjectedMessage) -> String {
    message.content.compactMap { part -> String? in
      if case .text(let t) = part { return t }
      return nil
    }.joined()
  }

  private static func lastActivePartIndex(_ content: [ProjectedPart]) -> Int {
    for i in content.indices.reversed() {
      switch content[i] {
      case .text(let t) where !t.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty: return i
      case .thinking(let t) where !t.isEmpty: return i
      case .toolCall, .image: return i
      default: continue
      }
    }
    return -1
  }

  private static func backgroundNote(_ text: String) -> String? {
    let trimmed = text.trimmingCharacters(in: .whitespacesAndNewlines)
    guard trimmed.hasPrefix("<background-task-update>") else { return nil }
    return trimmed
      .replacingOccurrences(of: "<background-task-update>", with: "")
      .replacingOccurrences(of: "</background-task-update>", with: "")
      .trimmingCharacters(in: .whitespacesAndNewlines)
  }

  private static func splitThinkingTags(_ text: String) -> [(thinking: Bool, text: String)] {
    var pieces: [(Bool, String)] = []
    var i = text.startIndex
    while i < text.endIndex {
      guard let open = text.range(of: "<thinking>", range: i..<text.endIndex) else {
        let rest = String(text[i...]).trimmingCharacters(in: .whitespacesAndNewlines)
        if !rest.isEmpty { pieces.append((false, rest)) }
        break
      }
      let before = String(text[i..<open.lowerBound]).trimmingCharacters(in: .whitespacesAndNewlines)
      if !before.isEmpty { pieces.append((false, before)) }
      let contentStart = open.upperBound
      if let close = text.range(of: "</thinking>", range: contentStart..<text.endIndex) {
        let inner = String(text[contentStart..<close.lowerBound]).trimmingCharacters(in: .whitespacesAndNewlines)
        if !inner.isEmpty { pieces.append((true, inner)) }
        i = close.upperBound
      } else {
        let inner = String(text[contentStart...]).trimmingCharacters(in: .whitespacesAndNewlines)
        if !inner.isEmpty { pieces.append((true, inner)) }
        break
      }
    }
    if pieces.isEmpty, !text.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty {
      return [(false, text)]
    }
    return pieces
  }

  private static let summaryKeys = [
    "path", "file_path", "command", "pattern", "query", "url", "description", "summary", "reason",
  ]

  static func summarizeArgs(_ arguments: String?, cwd: String?) -> String {
    guard let arguments, !arguments.isEmpty else { return "" }
    guard let data = arguments.data(using: .utf8),
      let obj = try? JSONSerialization.jsonObject(with: data) as? [String: Any]
    else { return arguments }
    for key in summaryKeys {
      if let s = obj[key] as? String, !s.isEmpty { return relativize(s, cwd: cwd) }
    }
    return arguments
  }

  private static func relativize(_ path: String, cwd: String?) -> String {
    guard let cwd, !cwd.isEmpty, path.hasPrefix(cwd) else { return path }
    var rest = String(path.dropFirst(cwd.count))
    if rest.hasPrefix("/") { rest = String(rest.dropFirst()) }
    return rest.isEmpty ? path : rest
  }

  private static func extractWrite(name: String, arguments: String?) -> String? {
    guard name == "write", let arguments, let data = arguments.data(using: .utf8),
      let obj = try? JSONSerialization.jsonObject(with: data) as? [String: Any],
      let content = obj["content"] as? String, !content.isEmpty
    else { return nil }
    return content
  }

  private static func extractEdits(name: String, arguments: String?) -> [(String, String)] {
    guard name == "edit", let arguments, let data = arguments.data(using: .utf8),
      let obj = try? JSONSerialization.jsonObject(with: data) as? [String: Any]
    else { return [] }
    if let oldText = obj["oldText"] as? String, let newText = obj["newText"] as? String {
      return [(oldText, newText)]
    }
    var edits = obj["edits"]
    if let s = edits as? String, let parsed = try? JSONSerialization.jsonObject(with: Data(s.utf8)) {
      edits = parsed
    }
    guard let arr = edits as? [[String: Any]] else { return [] }
    return arr.compactMap { e in
      guard let oldText = e["oldText"] as? String, let newText = e["newText"] as? String else { return nil }
      return (oldText, newText)
    }
  }
}
