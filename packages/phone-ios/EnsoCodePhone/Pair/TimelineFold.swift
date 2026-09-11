import Foundation

struct ToolGroupStats: Equatable {
  var commands = 0
  var reads = 0
  var searches = 0
  var others = 0
}

enum TimelineFold {
  static let minTools = 3
  static let searchTools: Set<String> = ["grep", "find", "glob", "ls"]
  static let readOnlyTools: Set<String> = ["read", "grep", "find", "glob", "ls"]
  static let readOnlyPrograms: Set<String> = [
    "ls", "tree", "pwd", "cd", "cat", "bat", "head", "tail", "wc", "nl", "tac", "less", "more",
    "rg", "grep", "egrep", "fgrep", "ag", "find", "fd", "fdfind", "which", "type", "file", "stat",
    "du", "df", "sort", "uniq", "cut", "tr", "awk", "sed", "diff", "jq", "yq", "echo", "printf",
    "basename", "dirname", "realpath", "readlink", "printenv", "date", "whoami", "uname", "column",
    "true", "test", "[", "git",
  ]
  static let readFilePrograms: Set<String> = ["cat", "bat", "head", "tail", "less", "more", "nl", "tac"]
  static let gitRead: Set<String> = [
    "status", "log", "diff", "show", "blame", "grep", "ls-files", "ls-tree", "rev-parse", "describe",
    "shortlog", "reflog", "cat-file", "name-rev", "remote", "config", "branch", "tag",
  ]

  static func isReadOnlyTool(_ item: TimelineItem) -> Bool {
    let name = item.toolName.isEmpty ? item.name : item.toolName
    return readOnlyTools.contains(name) || (name == "bash" && isReadOnlyCommand(item.summary))
  }

  static func isReadOnlyCommand(_ command: String) -> Bool {
    let trimmed = command.trimmingCharacters(in: .whitespacesAndNewlines)
    if trimmed.isEmpty { return false }
    if trimmed.contains("$(") || trimmed.contains("<(") || trimmed.contains("`") { return false }
    let withoutStderr = trimmed.replacingOccurrences(of: "2>&1", with: "")
      .replacingOccurrences(of: #"[12]?>\s*/dev/null"#, with: "", options: .regularExpression)
    if withoutStderr.contains(">") { return false }
    let segments = withoutStderr.split(whereSeparator: { "|&;\n".contains($0) }).map(String.init)
    for raw in segments {
      let segment = raw.trimmingCharacters(in: .whitespaces)
      if segment.isEmpty { continue }
      let tokens = segment.split(separator: " ").map(String.init)
      var i = 0
      while i < tokens.count && tokens[i].contains("=") && tokens[i].first?.isLetter == true {
        if tokens[i].hasPrefix("GIT_") { return false }
        i += 1
      }
      let rest = Array(tokens.dropFirst(i))
      guard let head = rest.first else { return false }
      let program = (head as NSString).lastPathComponent
      if !readOnlyPrograms.contains(program) { return false }
      if program == "git" {
        let sub = rest.dropFirst().first(where: { !$0.hasPrefix("-") })
        guard let sub, gitRead.contains(sub) else { return false }
      }
    }
    return true
  }

  static func fold(
    _ items: [TimelineItem],
    running: Bool,
    expandedKeys: Set<String>,
    compact: Bool
  ) -> [TimelineItem] {
    let lastUser = items.lastIndex(where: { $0.kind == .user }) ?? -1
    func inSegment(_ s: TimelineItem) -> Bool {
      s.kind == .thinking || (s.kind == .tool && (!compact || isReadOnlyTool(s)))
    }
    func pinned(_ s: TimelineItem) -> Bool {
      guard s.kind == .tool else { return false }
      if !s.edits.isEmpty || s.writeContent != nil || (s.toolName.isEmpty ? s.name : s.toolName) == "todo" {
        return true
      }
      if s.state != "running" && s.state != "reviewing" { return false }
      return !(compact && isReadOnlyTool(s))
    }

    var result: [TimelineItem] = []
    var i = 0
    while i < items.count {
      let item = items[i]
      if !inSegment(item) {
        result.append(item)
        i += 1
        continue
      }
      var end = i
      while end < items.count && inSegment(items[end]) { end += 1 }
      let segment = Array(items[i..<end])
      let live = !compact && running && lastUser >= 0 && i > lastUser
      let groupRows = segment.filter { !pinned($0) }
      let editRows = segment.filter { pinned($0) }
      let toolCount = groupRows.filter { $0.kind == .tool }.count
      let threshold = compact ? 1 : minTools
      if live || toolCount < threshold {
        result.append(contentsOf: segment)
      } else {
        var stats = ToolGroupStats()
        for row in groupRows where row.kind == .tool {
          classify(row, stats: &stats, compact: compact)
        }
        let key = "group-\(segment[0].id)"
        let expanded = expandedKeys.contains(key)
        var group = TimelineItem(id: key, kind: .toolGroup)
        group.groupCount = toolCount
        group.stats = stats
        group.exploring = compact && groupRows.contains { $0.kind == .tool && ($0.state == "running" || $0.state == "reviewing") }
        group.expanded = expanded
        group.children = groupRows
        result.append(group)
        if expanded { result.append(contentsOf: segment) }
        else { result.append(contentsOf: editRows) }
      }
      i = end
    }
    return result
  }

  private static func classify(_ row: TimelineItem, stats: inout ToolGroupStats, compact: Bool) {
    let name = row.toolName.isEmpty ? row.name : row.toolName
    if name == "read" { stats.reads += 1 }
    else if searchTools.contains(name) { stats.searches += 1 }
    else if name == "bash" {
      if !compact || !isReadOnlyCommand(row.summary) { stats.commands += 1 }
      else if readFilePrograms.contains(firstProgram(row.summary)) { stats.reads += 1 }
      else { stats.searches += 1 }
    } else { stats.others += 1 }
  }

  private static func firstProgram(_ command: String) -> String {
    let tokens = command.trimmingCharacters(in: .whitespaces).split(separator: " ").map(String.init)
    var i = 0
    while i < tokens.count && tokens[i].contains("=") { i += 1 }
    let head = i < tokens.count ? tokens[i] : ""
    return (head as NSString).lastPathComponent
  }
}
