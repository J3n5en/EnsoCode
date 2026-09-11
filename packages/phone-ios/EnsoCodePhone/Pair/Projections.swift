import Foundation

enum SyncState: String, Equatable {
  case syncing, synced
}

struct SyncTracking: Equatable {
  var state: SyncState = .synced
  var knownIds: Set<String> = []
}

enum SyncProjection {
  static func applySubscribe(_ t: SyncTracking, sessionId: String?, fresh: Bool) -> SyncTracking {
    var next = t
    next.state = (sessionId != nil && !fresh) ? .syncing : .synced
    return next
  }

  static func applySnapshot(_ t: SyncTracking, subscribedId: String?, snapshotIds: [String]) -> SyncTracking {
    guard let subscribedId, snapshotIds.contains(subscribedId) else { return t }
    var next = t
    next.state = .synced
    return next
  }

  static func applyCatalog(_ t: SyncTracking, subscribedId: String?, catalogIds: [String]) -> (SyncTracking, Bool) {
    let ghost = subscribedId != nil && t.knownIds.contains(subscribedId!) && !catalogIds.contains(subscribedId!)
    var next = t
    next.state = ghost ? .synced : t.state
    next.knownIds = Set(catalogIds)
    return (next, ghost)
  }
}

enum GuestProjection {
  static func maxIndex(_ messages: [Int: ProjectedMessage]) -> Int {
    messages.keys.max() ?? -1
  }

  static func applyRetry(_ current: RetryInfo?, event: [String: Any], now: Int64) -> RetryInfo? {
    switch JSONUtil.string(event["type"]) {
    case "turn-retry":
      guard let attempt = JSONUtil.int(event["attempt"]),
        let maxAttempts = JSONUtil.int(event["maxAttempts"]),
        let delayMs = JSONUtil.int(event["delayMs"]),
        let error = JSONUtil.string(event["error"]), !error.isEmpty
      else { return current }
      return RetryInfo(attempt: attempt, maxAttempts: maxAttempts, delayMs: delayMs, error: error, at: now)
    case "status", "turn-completed", "turn-failed":
      return nil
    default:
      return current
    }
  }

  static func applyTask(_ view: GuestSessionView, event: [String: Any]) -> GuestSessionView? {
    switch JSONUtil.string(event["type"]) {
    case "task-started":
      guard let taskObj = JSONUtil.dict(event["task"]), let task = BackgroundTaskInfo.parse(taskObj) else { return nil }
      if view.tasks.contains(where: { $0.taskId == task.taskId }) { return view }
      var next = view
      next.tasks.append(task)
      return next
    case "task-output":
      guard let taskId = JSONUtil.string(event["taskId"]) else { return nil }
      var next = view
      next.tasks = view.tasks.map { t in
        guard t.taskId == taskId else { return t }
        var copy = t
        copy.tail = JSONUtil.string(event["tail"]) ?? t.tail
        copy.status = JSONUtil.string(event["status"]) ?? t.status
        return copy
      }
      return next
    case "task-ended":
      guard let taskId = JSONUtil.string(event["taskId"]) else { return nil }
      var next = view
      next.tasks = view.tasks.map { t in
        guard t.taskId == taskId else { return t }
        var copy = t
        copy.status = JSONUtil.string(event["status"]) ?? "done"
        copy.exitCode = JSONUtil.int(event["exitCode"])
        if let tail = JSONUtil.string(event["tail"]) { copy.tail = tail }
        return copy
      }
      return next
    case "subagent-update":
      guard let obj = JSONUtil.dict(event["agent"]),
        let info = SubagentInfo.parse(obj)
      else { return nil }
      var next = view
      if let idx = next.subagents.firstIndex(where: { $0.id == info.id }) {
        next.subagents[idx] = info
      } else {
        next.subagents.append(info)
      }
      return next
    default:
      return nil
    }
  }

  struct EventResult {
    var view: GuestSessionView
    var lastIndex: Int?
  }

  static func applyEvent(_ current: GuestSessionView, event: [String: Any], now: Int64 = Int64(Date().timeIntervalSince1970 * 1000)) -> EventResult {
    var view = current
    view.retry = applyRetry(view.retry, event: event, now: now)
    if let tasked = applyTask(view, event: event) {
      return EventResult(view: tasked, lastIndex: nil)
    }
    switch JSONUtil.string(event["type"]) {
    case "message-upsert":
      if let index = JSONUtil.int(event["index"]), let msg = JSONUtil.dict(event["message"]) {
        view.messages[index] = ProjectedMessage.parse(msg)
        return EventResult(view: view, lastIndex: maxIndex(view.messages))
      }
    case "messages-truncated":
      if let length = JSONUtil.int(event["length"]) {
        view.messages = view.messages.filter { $0.key < length }
        return EventResult(view: view, lastIndex: length - 1)
      }
    case "status":
      view.status = JSONUtil.string(event["status"]) ?? view.status
    case "turn-completed":
      view.status = "idle"
    case "turn-failed":
      view.status = "failed"
    case "approval-request":
      let src = JSONUtil.dict(event["request"]) ?? event
      if let approval = ApprovalRequestInfo.parse(src) { view.approvals.append(approval) }
    case "approval-resolved":
      if let id = JSONUtil.string(event["requestId"]) {
        view.approvals.removeAll { $0.requestId == id }
      }
    case "ask-request":
      let src = JSONUtil.dict(event["ask"]) ?? event
      if let ask = AskRequestInfo.parse(src) { view.asks.append(ask) }
    case "ask-resolved":
      if let id = JSONUtil.string(event["requestId"]) {
        view.asks.removeAll { $0.requestId == id }
      }
    case "compaction":
      let state = JSONUtil.string(event["state"])
      if state == "queued" { view.compaction = "queued" }
      else if state == "start" { view.compaction = "running" }
      else { view.compaction = nil }
      if state == "end", JSONUtil.bool(event["error"]) != true, JSONUtil.bool(event["abandoned"]) != true {
        view.compactionNoticeAt = maxIndex(view.messages) + 1
      }
    default:
      break
    }
    return EventResult(view: view, lastIndex: nil)
  }

  struct SnapshotResult {
    var id: String
    var view: GuestSessionView
    var lastIndex: Int?
  }

  static func applySnapshot(sessions: [String: GuestSessionView], event: [String: Any]) -> [SnapshotResult] {
    var out: [SnapshotResult] = []
    for snapAny in JSONUtil.array(event["sessions"]) ?? [] {
      guard let snap = JSONUtil.dict(snapAny) else { continue }
      let identity = JSONUtil.dict(snap["identity"])
      guard let id = JSONUtil.string(snap["sessionId"]) ?? JSONUtil.string(identity?["sessionId"]) else { continue }
      let base = JSONUtil.int(snap["baseIndex"]) ?? 0
      let existing = sessions[id]?.messages
      let prevMax = existing.flatMap { $0.keys.max() } ?? -1
      var messages = (existing != nil && base <= prevMax + 1) ? existing! : [:]
      let incoming = JSONUtil.array(snap["messages"]) ?? []
      for key in messages.keys where key >= base + incoming.count { messages.removeValue(forKey: key) }
      for (i, item) in incoming.enumerated() {
        if let obj = JSONUtil.dict(item) { messages[base + i] = ProjectedMessage.parse(obj) }
      }
      let view = GuestSessionView(
        messages: messages,
        status: JSONUtil.string(snap["status"]) ?? "idle",
        approvals: (JSONUtil.array(snap["pendingApprovals"]) ?? []).compactMap { JSONUtil.dict($0).flatMap(ApprovalRequestInfo.parse) },
        asks: (JSONUtil.array(snap["pendingAsks"]) ?? []).compactMap { JSONUtil.dict($0).flatMap(AskRequestInfo.parse) },
        tasks: (JSONUtil.array(snap["backgroundTasks"]) ?? []).compactMap { JSONUtil.dict($0).flatMap(BackgroundTaskInfo.parse) },
        subagents: (JSONUtil.array(snap["subagents"]) ?? []).compactMap { JSONUtil.dict($0).flatMap(SubagentInfo.parse) },
        retry: nil,
        compaction: JSONUtil.string(snap["compaction"]),
        compactionNoticeAt: JSONUtil.int(snap["compactionNoticeAt"]) ?? sessions[id]?.compactionNoticeAt
      )
      out.append(SnapshotResult(id: id, view: view, lastIndex: base + incoming.count - 1))
    }
    return out
  }

  static func applyHistory(_ view: GuestSessionView, baseIndex: Int, messages: [Any]) -> GuestSessionView {
    if messages.isEmpty { return view }
    var next = view
    for (i, item) in messages.enumerated() {
      if let obj = JSONUtil.dict(item) { next.messages[baseIndex + i] = ProjectedMessage.parse(obj) }
    }
    return next
  }

  static func markAllFailed(_ sessions: [String: GuestSessionView]) -> [String: GuestSessionView] {
    var out: [String: GuestSessionView] = [:]
    for (id, view) in sessions {
      var copy = view
      copy.status = "failed"
      out[id] = copy
    }
    return out
  }

  static func localCompactionNoticeIndex(indices: [Int], noticeAt: Int?) -> Int? {
    guard let noticeAt else { return nil }
    return indices.filter { $0 < noticeAt }.count
  }
}
