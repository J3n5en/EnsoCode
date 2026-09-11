import Foundation

enum ThinkingLevel: String, CaseIterable, Equatable {
  case minimal, low, medium, high, xhigh, max
  var label: String {
    switch self {
    case .minimal: return "极低"
    case .low: return "低"
    case .medium: return "中"
    case .high: return "高"
    case .xhigh: return "极高"
    case .max: return "最高"
    }
  }
}

enum ApprovalMode: String, CaseIterable, Equatable {
  case supervised
  case autoEdits = "auto-edits"
  case full
  case assistant
  var label: String {
    switch self {
    case .supervised: return "受监督（每步确认）"
    case .autoEdits: return "自动接受编辑"
    case .full: return "完全放行"
    case .assistant: return "助手代审"
    }
  }
}

enum ApprovalDecision: String, Equatable {
  case allow
  case allowSession
  case deny
}

enum ConnState: String, Equatable {
  case connecting, online, hostOffline = "host-offline", unauthorized, offline
  var label: String {
    switch self {
    case .connecting: return "连接中…"
    case .online: return "已连接"
    case .hostOffline: return "桌面端离线"
    case .unauthorized: return "配对已失效"
    case .offline: return "重连中…"
    }
  }
}

struct AttachedImage: Equatable {
  var data: String
  var mimeType: String
  func json() -> [String: Any] { ["data": data, "mimeType": mimeType] }
}

struct PairedDevice: Equatable {
  var pairId: String
  var token: String
  var contentKey: String
  var deviceName: String
  var relayUrl: String
  var pairedAt: Int64

  func json() -> [String: Any] {
    [
      "pairId": pairId,
      "token": token,
      "contentKey": contentKey,
      "deviceName": deviceName,
      "relayUrl": relayUrl,
      "pairedAt": pairedAt,
    ]
  }

  static func parse(_ obj: [String: Any]) -> PairedDevice? {
    guard let pairId = JSONUtil.string(obj["pairId"]),
      let token = JSONUtil.string(obj["token"]),
      let contentKey = JSONUtil.string(obj["contentKey"]),
      let deviceName = JSONUtil.string(obj["deviceName"]),
      let relayUrl = JSONUtil.string(obj["relayUrl"])
    else { return nil }
    return PairedDevice(
      pairId: pairId,
      token: token,
      contentKey: contentKey,
      deviceName: deviceName,
      relayUrl: relayUrl,
      pairedAt: JSONUtil.int64(obj["pairedAt"]) ?? 0
    )
  }
}

struct StoredDevice: Equatable, Identifiable {
  var id: String { pairId }
  var pairId: String
  var token: String
  var contentKey: String
  var deviceName: String
  var relayUrl: String
  var pairedAt: Int64
  var label: String

  var credentials: PairedDevice {
    PairedDevice(
      pairId: pairId,
      token: token,
      contentKey: contentKey,
      deviceName: deviceName,
      relayUrl: relayUrl,
      pairedAt: pairedAt
    )
  }

  func json() -> [String: Any] {
    var obj = credentials.json()
    obj["label"] = label
    return obj
  }

  static func parse(_ obj: [String: Any]) -> StoredDevice? {
    guard let device = PairedDevice.parse(obj) else { return nil }
    return StoredDevice(
      pairId: device.pairId,
      token: device.token,
      contentKey: device.contentKey,
      deviceName: device.deviceName,
      relayUrl: device.relayUrl,
      pairedAt: device.pairedAt,
      label: JSONUtil.string(obj["label"]) ?? device.deviceName
    )
  }

  static func wrap(_ device: PairedDevice, label: String) -> StoredDevice {
    StoredDevice(
      pairId: device.pairId,
      token: device.token,
      contentKey: device.contentKey,
      deviceName: device.deviceName,
      relayUrl: device.relayUrl,
      pairedAt: device.pairedAt,
      label: label
    )
  }
}

struct QueuedMessage: Equatable, Identifiable {
  var id: String
  var text: String
  var hasImages: Bool
}

struct CatalogEntry: Equatable, Identifiable {
  var id: String
  var title: String
  var projectName: String
  var projectId: String
  var cwd: String?
  var status: String
  var unread: Bool
  var parentId: String?
  var updatedAt: Int64?
  var pinned: Bool
  var archived: Bool
  var providerId: String?
  var modelId: String?
  var reasoningEnabled: Bool?
  var thinkingLevel: ThinkingLevel?
  var queued: [QueuedMessage]

  static func parse(_ obj: [String: Any]) -> CatalogEntry? {
    guard let id = JSONUtil.string(obj["id"]) else { return nil }
    let queued: [QueuedMessage] = JSONUtil.array(obj["queued"])?.compactMap { item in
      guard let d = JSONUtil.dict(item), let qid = JSONUtil.string(d["id"]) else { return nil }
      return QueuedMessage(
        id: qid,
        text: JSONUtil.string(d["text"]) ?? "",
        hasImages: JSONUtil.bool(d["hasImages"]) ?? false
      )
    } ?? []
    return CatalogEntry(
      id: id,
      title: JSONUtil.string(obj["title"]) ?? "",
      projectName: JSONUtil.string(obj["projectName"]) ?? "",
      projectId: JSONUtil.string(obj["projectId"]) ?? "",
      cwd: JSONUtil.string(obj["cwd"]),
      status: JSONUtil.string(obj["status"]) ?? "idle",
      unread: JSONUtil.bool(obj["unread"]) ?? false,
      parentId: JSONUtil.string(obj["parentId"]),
      updatedAt: JSONUtil.int64(obj["updatedAt"]),
      pinned: JSONUtil.bool(obj["pinned"]) ?? false,
      archived: JSONUtil.bool(obj["archived"]) ?? false,
      providerId: JSONUtil.string(obj["providerId"]),
      modelId: JSONUtil.string(obj["modelId"]),
      reasoningEnabled: JSONUtil.bool(obj["reasoningEnabled"]),
      thinkingLevel: JSONUtil.string(obj["thinkingLevel"]).flatMap(ThinkingLevel.init(rawValue:)),
      queued: queued
    )
  }
}

struct ProjectEntry: Equatable, Identifiable {
  var id: String
  var name: String
  var path: String
  var kind: String?
  var sshConnectionName: String?
  var sshHost: String?
  var archived: Bool
  var groupId: String?

  var sshBadge: String? {
    guard kind == "ssh" else { return nil }
    let trimmed = sshConnectionName?.trimmingCharacters(in: .whitespacesAndNewlines)
    if let trimmed, !trimmed.isEmpty { return trimmed }
    return sshHost
  }

  var listLabel: String {
    if let sshBadge { return "\(name) (\(sshBadge))" }
    return name
  }

  static func parse(_ obj: [String: Any]) -> ProjectEntry? {
    guard let id = JSONUtil.string(obj["id"]), let name = JSONUtil.string(obj["name"]) else { return nil }
    return ProjectEntry(
      id: id,
      name: name,
      path: JSONUtil.string(obj["path"]) ?? "",
      kind: JSONUtil.string(obj["kind"]),
      sshConnectionName: JSONUtil.string(obj["sshConnectionName"]),
      sshHost: JSONUtil.string(obj["sshHost"]),
      archived: JSONUtil.bool(obj["archived"]) ?? false,
      groupId: JSONUtil.string(obj["groupId"])
    )
  }
}

struct ProjectGroupEntry: Equatable, Identifiable {
  var id: String
  var name: String
  var emoji: String?
  var color: String?
  var order: Int

  static func parse(_ obj: [String: Any]) -> ProjectGroupEntry? {
    guard let id = JSONUtil.string(obj["id"]), let name = JSONUtil.string(obj["name"]) else { return nil }
    return ProjectGroupEntry(
      id: id,
      name: name,
      emoji: JSONUtil.string(obj["emoji"]),
      color: JSONUtil.string(obj["color"]),
      order: JSONUtil.int(obj["order"]) ?? 0
    )
  }
}

struct ModelEntry: Equatable, Identifiable {
  var id: String
  var label: String?
  var display: String { label ?? id }
}

struct ProviderEntry: Equatable, Identifiable {
  var id: String
  var name: String
  var models: [ModelEntry]

  static func parse(_ obj: [String: Any]) -> ProviderEntry? {
    guard let id = JSONUtil.string(obj["id"]), let name = JSONUtil.string(obj["name"]) else { return nil }
    let models: [ModelEntry] = JSONUtil.array(obj["models"])?.compactMap { item in
      guard let d = JSONUtil.dict(item), let mid = JSONUtil.string(d["id"]) else { return nil }
      return ModelEntry(id: mid, label: JSONUtil.string(d["label"]))
    } ?? []
    return ProviderEntry(id: id, name: name, models: models)
  }
}

enum HostAppearance: String, Equatable {
  case light, dark, system
  case syncTerminal = "sync-terminal"
}

struct TerminalPalette: Equatable {
  var background: String
  var foreground: String
  var brightBlack: String
  var brightBlue: String

  static func parse(_ obj: [String: Any]) -> TerminalPalette? {
    guard let background = JSONUtil.string(obj["background"]),
      let foreground = JSONUtil.string(obj["foreground"])
    else { return nil }
    return TerminalPalette(
      background: background,
      foreground: foreground,
      brightBlack: JSONUtil.string(obj["brightBlack"]) ?? foreground,
      brightBlue: JSONUtil.string(obj["brightBlue"]) ?? "#3B82F6"
    )
  }
}

struct ApprovalRequestInfo: Equatable, Identifiable {
  var requestId: String
  var tool: String
  var kind: String
  var summary: String
  var toolCallId: String?
  var phase: String?
  var id: String { requestId }

  var reviewing: Bool { phase == "reviewing" }

  static func parse(_ obj: [String: Any]) -> ApprovalRequestInfo? {
    guard let requestId = JSONUtil.string(obj["requestId"]) else { return nil }
    return ApprovalRequestInfo(
      requestId: requestId,
      tool: JSONUtil.string(obj["tool"]) ?? "",
      kind: JSONUtil.string(obj["kind"]) ?? "",
      summary: JSONUtil.string(obj["summary"]) ?? "",
      toolCallId: JSONUtil.string(obj["toolCallId"]),
      phase: JSONUtil.string(obj["phase"])
    )
  }
}

struct AskRequestInfo: Equatable, Identifiable {
  var requestId: String
  var question: String
  var options: [String]
  var id: String { requestId }

  static func parse(_ obj: [String: Any]) -> AskRequestInfo? {
    guard let requestId = JSONUtil.string(obj["requestId"]) else { return nil }
    return AskRequestInfo(
      requestId: requestId,
      question: JSONUtil.string(obj["question"]) ?? "",
      options: JSONUtil.stringArray(obj["options"]) ?? []
    )
  }
}

struct BackgroundTaskInfo: Equatable, Identifiable {
  var taskId: String
  var command: String
  var status: String
  var tail: String
  var startedAt: Int64
  var exitCode: Int?
  var id: String { taskId }

  static func parse(_ obj: [String: Any]) -> BackgroundTaskInfo? {
    guard let taskId = JSONUtil.string(obj["taskId"]) else { return nil }
    return BackgroundTaskInfo(
      taskId: taskId,
      command: JSONUtil.string(obj["command"]) ?? "",
      status: JSONUtil.string(obj["status"]) ?? "running",
      tail: JSONUtil.string(obj["tail"]) ?? "",
      startedAt: JSONUtil.int64(obj["startedAt"]) ?? 0,
      exitCode: JSONUtil.int(obj["exitCode"])
    )
  }
}

struct SubagentInfo: Equatable, Identifiable {
  var id: String
  var description: String
  var status: String
  var steps: Int
  var currentActivity: String
  var resultText: String?
  var startedAt: Int64

  static func parse(_ obj: [String: Any]) -> SubagentInfo? {
    guard let id = JSONUtil.string(obj["id"]) else { return nil }
    return SubagentInfo(
      id: id,
      description: JSONUtil.string(obj["description"]) ?? "",
      status: JSONUtil.string(obj["status"]) ?? "running",
      steps: JSONUtil.int(obj["steps"]) ?? 0,
      currentActivity: JSONUtil.string(obj["currentActivity"]) ?? "",
      resultText: JSONUtil.string(obj["resultText"]),
      startedAt: JSONUtil.int64(obj["startedAt"]) ?? 0
    )
  }
}

struct RetryInfo: Equatable {
  var attempt: Int
  var maxAttempts: Int
  var delayMs: Int
  var error: String
  var at: Int64
}

struct TodoItem: Equatable, Identifiable {
  var content: String
  var status: String
  var id: String { content }
}

enum ProjectedPart: Equatable {
  case text(String)
  case thinking(String)
  case toolCall(id: String, name: String, arguments: String?)
  case image(data: String, mimeType: String)
  case unknown

  static func parse(_ obj: [String: Any]) -> ProjectedPart {
    switch JSONUtil.string(obj["type"]) {
    case "text": return .text(JSONUtil.string(obj["text"]) ?? "")
    case "thinking": return .thinking(JSONUtil.string(obj["text"]) ?? "")
    case "toolCall":
      return .toolCall(
        id: JSONUtil.string(obj["id"]) ?? "",
        name: JSONUtil.string(obj["name"]) ?? "",
        arguments: stringify(obj["arguments"])
      )
    case "image":
      return .image(data: JSONUtil.string(obj["data"]) ?? "", mimeType: JSONUtil.string(obj["mimeType"]) ?? "image/png")
    default: return .unknown
    }
  }

  private static func stringify(_ value: Any?) -> String? {
    guard let value, !(value is NSNull) else { return nil }
    if let s = value as? String { return s }
    if JSONSerialization.isValidJSONObject(value),
      let data = try? JSONSerialization.data(withJSONObject: value, options: [.sortedKeys]),
      let s = String(data: data, encoding: .utf8)
    {
      return s
    }
    return String(describing: value)
  }
}

struct TokenUsage: Equatable {
  var input: Int
  var output: Int
}

struct ProjectedMessage: Equatable {
  var role: String
  var content: [ProjectedPart]
  var toolName: String?
  var toolCallId: String?
  var isError: Bool
  var errorMessage: String?
  var timestamp: Int64?
  var usage: TokenUsage?
  var ttft: Int?
  var duration: Int?
  var todos: [TodoItem]
  var toolDurationMs: Int?
  var tokensBefore: Int?
  var editDiff: (oldText: String, newText: String)?

  static func == (lhs: ProjectedMessage, rhs: ProjectedMessage) -> Bool {
    lhs.role == rhs.role && lhs.content == rhs.content && lhs.toolName == rhs.toolName
      && lhs.toolCallId == rhs.toolCallId && lhs.isError == rhs.isError && lhs.errorMessage == rhs.errorMessage
      && lhs.timestamp == rhs.timestamp && lhs.todos == rhs.todos
  }

  static func parse(_ obj: [String: Any]) -> ProjectedMessage {
    let parts: [ProjectedPart] = JSONUtil.array(obj["content"])?.compactMap { item in
      JSONUtil.dict(item).map(ProjectedPart.parse)
    } ?? []
    let todos: [TodoItem] = JSONUtil.array(obj["todos"])?.compactMap { item in
      guard let d = JSONUtil.dict(item) else { return nil }
      return TodoItem(content: JSONUtil.string(d["content"]) ?? "", status: JSONUtil.string(d["status"]) ?? "pending")
    } ?? []
    var usage: TokenUsage?
    if let u = JSONUtil.dict(obj["usage"]) {
      usage = TokenUsage(input: JSONUtil.int(u["input"]) ?? 0, output: JSONUtil.int(u["output"]) ?? 0)
    }
    var editDiff: (String, String)?
    if let d = JSONUtil.dict(obj["editDiff"]),
      let oldText = JSONUtil.string(d["oldText"]),
      let newText = JSONUtil.string(d["newText"])
    {
      editDiff = (oldText, newText)
    }
    return ProjectedMessage(
      role: JSONUtil.string(obj["role"]) ?? "",
      content: parts,
      toolName: JSONUtil.string(obj["toolName"]),
      toolCallId: JSONUtil.string(obj["toolCallId"]),
      isError: JSONUtil.bool(obj["isError"]) ?? false,
      errorMessage: JSONUtil.string(obj["errorMessage"]),
      timestamp: JSONUtil.int64(obj["timestamp"]),
      usage: usage,
      ttft: JSONUtil.int(obj["ttft"]),
      duration: JSONUtil.int(obj["duration"]),
      todos: todos,
      toolDurationMs: JSONUtil.int(obj["toolDurationMs"]),
      tokensBefore: JSONUtil.int(obj["tokensBefore"]),
      editDiff: editDiff
    )
  }
}

struct GuestSessionView: Equatable {
  var messages: [Int: ProjectedMessage] = [:]
  var status: String = "idle"
  var approvals: [ApprovalRequestInfo] = []
  var asks: [AskRequestInfo] = []
  var tasks: [BackgroundTaskInfo] = []
  var subagents: [SubagentInfo] = []
  var retry: RetryInfo?
  var compaction: String?
  var compactionNoticeAt: Int?

  var sortedMessages: [(Int, ProjectedMessage)] {
    messages.keys.sorted().compactMap { key in messages[key].map { (key, $0) } }
  }

  var isRunning: Bool { status == "running" }
}

struct NewSessionRequest {
  var projectId: String
  var providerId: String
  var modelId: String
  var approvalMode: ApprovalMode
  var reasoningEnabled: Bool
  var thinkingLevel: ThinkingLevel
}

enum DeviceList {
  static func defaultLabel(_ list: [StoredDevice]) -> String {
    let used = Set(list.map(\.label))
    var n = 1
    while used.contains("电脑 \(n)") { n += 1 }
    return "电脑 \(n)"
  }

  static func upsert(_ list: [StoredDevice], _ device: PairedDevice) -> [StoredDevice] {
    if let idx = list.firstIndex(where: { $0.pairId == device.pairId }) {
      var next = list
      next[idx] = StoredDevice.wrap(device, label: list[idx].label)
      return next
    }
    return list + [StoredDevice.wrap(device, label: defaultLabel(list))]
  }

  static func remove(_ list: [StoredDevice], pairId: String) -> [StoredDevice] {
    list.filter { $0.pairId != pairId }
  }

  static func rename(_ list: [StoredDevice], pairId: String, label: String) -> [StoredDevice] {
    let trimmed = label.trimmingCharacters(in: .whitespacesAndNewlines)
    guard !trimmed.isEmpty else { return list }
    return list.map { $0.pairId == pairId ? StoredDevice.wrap($0.credentials, label: trimmed) : $0 }
  }

  static func pickActive(_ list: [StoredDevice], activeId: String?) -> StoredDevice? {
    list.first(where: { $0.pairId == activeId }) ?? list.first
  }

  static func migrate(listRaw: String?, legacyRaw: String?) -> [StoredDevice] {
    if let listRaw, let data = listRaw.data(using: .utf8),
      let arr = (try? JSONSerialization.jsonObject(with: data)) as? [Any]
    {
      return arr.compactMap { JSONUtil.dict($0).flatMap(StoredDevice.parse) }
    }
    if let legacyRaw, let data = legacyRaw.data(using: .utf8),
      let obj = JSONUtil.object(data),
      let device = PairedDevice.parse(obj)
    {
      return [StoredDevice.wrap(device, label: defaultLabel([]))]
    }
    return []
  }
}

enum DrawerOrder {
  static func sortByActivity(_ sessions: [CatalogEntry]) -> [CatalogEntry] {
    sessions.enumerated().sorted { a, b in
      let ta = a.element.updatedAt ?? 0
      let tb = b.element.updatedAt ?? 0
      if ta != tb { return ta > tb }
      return a.offset < b.offset
    }.map(\.element)
  }

  static func orderPinned(_ sessions: [CatalogEntry], manualIds: [String]) -> [CatalogEntry] {
    let byActivity = sortByActivity(sessions)
    var remaining = Dictionary(uniqueKeysWithValues: byActivity.map { ($0.id, $0) })
    var ordered: [CatalogEntry] = []
    for id in manualIds {
      if let session = remaining[id] {
        ordered.append(session)
        remaining.removeValue(forKey: id)
      }
    }
    return ordered + byActivity.filter { remaining[$0.id] != nil }
  }

  static func orderProjectSessions(_ sessions: [CatalogEntry]) -> [CatalogEntry] {
    sortByActivity(sessions.filter(\.pinned)) + sortByActivity(sessions.filter { !$0.pinned })
  }
}

enum ProjectGroups {
  static let allId = "__all__"
  static let ungroupedId = "__ungrouped__"

  static func isUngrouped(_ project: ProjectEntry, groups: [ProjectGroupEntry]) -> Bool {
    guard let gid = project.groupId else { return true }
    return !groups.contains(where: { $0.id == gid })
  }

  static func filterProjects(
    _ projects: [ProjectEntry],
    groups: [ProjectGroupEntry],
    archivedIds: Set<String>,
    selected: String
  ) -> [ProjectEntry] {
    let active = projects.filter { !archivedIds.contains($0.id) }
    if selected == allId { return active }
    if selected == ungroupedId { return active.filter { isUngrouped($0, groups: groups) } }
    return active.filter { $0.groupId == selected }
  }

  struct Section {
    var groupId: String
    var group: ProjectGroupEntry?
    var projects: [ProjectEntry]
  }

  static func sectionsForAllView(
    _ projects: [ProjectEntry],
    groups: [ProjectGroupEntry],
    archivedIds: Set<String>
  ) -> [Section] {
    let active = projects.filter { !archivedIds.contains($0.id) }
    let ordered = groups.sorted { $0.order < $1.order }
    let known = Set(groups.map(\.id))
    var sections = ordered.map { group in
      Section(groupId: group.id, group: group, projects: active.filter { $0.groupId == group.id })
    }
    let ungrouped = active.filter { $0.groupId == nil || !known.contains($0.groupId!) }
    if !ungrouped.isEmpty {
      sections.append(Section(groupId: ungroupedId, group: nil, projects: ungrouped))
    }
    return sections
  }
}

enum RelativeTime {
  static func format(_ ts: Int64, now: Int64 = Int64(Date().timeIntervalSince1970 * 1000)) -> String {
    let diff = ts - now
    let abs = abs(diff)
    let rtf = RelativeDateTimeFormatter()
    rtf.locale = Locale(identifier: "zh_CN")
    rtf.unitsStyle = .short
    if abs < 60_000 { return rtf.localizedString(fromTimeInterval: 0) }
    if abs < 3_600_000 { return rtf.localizedString(fromTimeInterval: TimeInterval(diff / 60_000) * 60) }
    if abs < 86_400_000 { return rtf.localizedString(fromTimeInterval: TimeInterval(diff / 3_600_000) * 3600) }
    if abs < 30 * 86_400_000 {
      return rtf.localizedString(fromTimeInterval: TimeInterval(diff / 86_400_000) * 86_400)
    }
    return rtf.localizedString(fromTimeInterval: TimeInterval(diff / (30 * 86_400_000)) * 30 * 86_400)
  }
}

enum SessionSlots {
  static let collapsedLimit = 5
  static let expandStep = 15

  static func shownCount(total: Int, revealedExtra: Int) -> Int {
    if total <= 0 { return 0 }
    return min(total, collapsedLimit + max(0, revealedExtra))
  }

  static func nextRevealedExtra(total: Int, revealedExtra: Int) -> Int {
    let shown = shownCount(total: total, revealedExtra: revealedExtra)
    if shown >= total { return 0 }
    return min(max(0, total - collapsedLimit), revealedExtra + expandStep)
  }

  static func prevRevealedExtra(_ revealedExtra: Int) -> Int {
    max(0, revealedExtra - expandStep)
  }
}
