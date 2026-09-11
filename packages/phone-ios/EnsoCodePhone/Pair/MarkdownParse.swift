import Foundation

enum MarkdownBlock: Equatable {
  case heading(Int, String)
  case paragraph(String)
  case list(ordered: Bool, items: [(indent: Int, text: String)])
  case quote(String)
  case code(lang: String?, body: String)
  case table(headers: [String], rows: [[String]])
  case hr

  static func == (lhs: MarkdownBlock, rhs: MarkdownBlock) -> Bool {
    switch (lhs, rhs) {
    case (.heading(let a, let b), .heading(let c, let d)): return a == c && b == d
    case (.paragraph(let a), .paragraph(let b)): return a == b
    case (.list(let o1, let i1), .list(let o2, let i2)):
      return o1 == o2 && i1.map(\.indent) == i2.map(\.indent) && i1.map(\.text) == i2.map(\.text)
    case (.quote(let a), .quote(let b)): return a == b
    case (.code(let a, let b), .code(let c, let d)): return a == c && b == d
    case (.table(let h1, let r1), .table(let h2, let r2)): return h1 == h2 && r1 == r2
    case (.hr, .hr): return true
    default: return false
    }
  }
}

enum MarkdownParse {
  static func parse(_ source: String) -> [MarkdownBlock] {
    let lines = source.split(separator: "\n", omittingEmptySubsequences: false).map(String.init)
    var blocks: [MarkdownBlock] = []
    var i = 0
    while i < lines.count {
      let line = lines[i]
      let trimmed = line.trimmingCharacters(in: .whitespaces)
      if trimmed.hasPrefix("```") {
        let lang = String(trimmed.dropFirst(3)).trimmingCharacters(in: .whitespaces)
        i += 1
        var body: [String] = []
        while i < lines.count, !lines[i].trimmingCharacters(in: .whitespaces).hasPrefix("```") {
          body.append(lines[i])
          i += 1
        }
        if i < lines.count { i += 1 }
        var code = body.joined(separator: "\n")
        if code.hasSuffix("\n") { code.removeLast() }
        blocks.append(.code(lang: lang.isEmpty ? nil : lang, body: code))
        continue
      }
      if trimmed == "---" || trimmed == "***" || trimmed == "___" {
        blocks.append(.hr)
        i += 1
        continue
      }
      if let heading = heading(trimmed) {
        blocks.append(heading)
        i += 1
        continue
      }
      if trimmed.hasPrefix(">") {
        var quote: [String] = []
        while i < lines.count {
          let t = lines[i].trimmingCharacters(in: .whitespaces)
          if t.hasPrefix(">") {
            quote.append(String(t.drop(while: { $0 == ">" || $0 == " " })))
            i += 1
          } else if t.isEmpty && i + 1 < lines.count && lines[i + 1].trimmingCharacters(in: .whitespaces).hasPrefix(">") {
            quote.append("")
            i += 1
          } else {
            break
          }
        }
        blocks.append(.quote(quote.joined(separator: "\n")))
        continue
      }
      if isListLine(line) {
        var items: [(Int, String)] = []
        var ordered = orderedList(line)
        while i < lines.count, isListLine(lines[i]) {
          let parsed = parseListLine(lines[i])
          items.append(parsed)
          ordered = orderedList(lines[i])
          i += 1
        }
        blocks.append(.list(ordered: ordered, items: items))
        continue
      }
      if isTableSep(lines, i) {
        let headers = splitRow(lines[i])
        i += 2
        var rows: [[String]] = []
        while i < lines.count, lines[i].contains("|") {
          rows.append(splitRow(lines[i]))
          i += 1
        }
        blocks.append(.table(headers: headers, rows: rows))
        continue
      }
      if trimmed.isEmpty {
        i += 1
        continue
      }
      var para: [String] = []
      while i < lines.count {
        let l = lines[i]
        let t = l.trimmingCharacters(in: .whitespaces)
        if t.isEmpty || t.hasPrefix("```") || heading(t) != nil || t.hasPrefix(">") || isListLine(l)
          || t == "---" || t == "***"
        {
          break
        }
        para.append(t)
        i += 1
      }
      if !para.isEmpty {
        blocks.append(.paragraph(para.joined(separator: " ")))
      }
    }
    return blocks
  }

  private static func heading(_ trimmed: String) -> MarkdownBlock? {
    guard trimmed.hasPrefix("#") else { return nil }
    var level = 0
    for ch in trimmed {
      if ch == "#" { level += 1 } else { break }
    }
    guard level >= 1, level <= 6, trimmed.count > level, trimmed[trimmed.index(trimmed.startIndex, offsetBy: level)] == " "
    else { return nil }
    let text = String(trimmed.dropFirst(level)).trimmingCharacters(in: .whitespaces)
    return .heading(level, text)
  }

  private static func isListLine(_ line: String) -> Bool {
    let t = line.trimmingCharacters(in: .whitespaces)
    if t.hasPrefix("- ") || t.hasPrefix("* ") || t.hasPrefix("+ ") { return true }
    return t.range(of: #"^\d+\.\s+"#, options: .regularExpression) != nil
  }

  private static func orderedList(_ line: String) -> Bool {
    line.trimmingCharacters(in: .whitespaces).range(of: #"^\d+\.\s+"#, options: .regularExpression) != nil
  }

  private static func parseListLine(_ line: String) -> (Int, String) {
    let spaces = line.prefix(while: { $0 == " " || $0 == "\t" }).count
    let indent = spaces / 2
    var t = line.trimmingCharacters(in: .whitespaces)
    if t.hasPrefix("- ") || t.hasPrefix("* ") || t.hasPrefix("+ ") {
      t = String(t.dropFirst(2))
    } else if let range = t.range(of: #"^\d+\.\s+"#, options: .regularExpression) {
      t = String(t[range.upperBound...])
    }
    return (indent, t)
  }

  private static func isTableSep(_ lines: [String], _ i: Int) -> Bool {
    guard i + 1 < lines.count, lines[i].contains("|") else { return false }
    let sep = lines[i + 1].trimmingCharacters(in: .whitespaces)
    return sep.contains("|") && sep.contains("-")
  }

  private static func splitRow(_ line: String) -> [String] {
    var s = line.trimmingCharacters(in: .whitespaces)
    if s.hasPrefix("|") { s.removeFirst() }
    if s.hasSuffix("|") { s.removeLast() }
    return s.split(separator: "|", omittingEmptySubsequences: false).map {
      $0.trimmingCharacters(in: .whitespaces)
    }
  }
}
