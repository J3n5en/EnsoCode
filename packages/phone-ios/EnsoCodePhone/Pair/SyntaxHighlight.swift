import SwiftUI

/// 轻量语法高亮器：对齐 PWA 的 shiki github-light/dark 主题配色。
/// 不追求完整 TextMate 语法，覆盖最常见 token 类型即可。
enum SyntaxHighlight {

  /// github-light / github-dark 的 token 颜色（经浏览器 canvas 换算）
  struct Palette {
    let text: Color
    let comment: Color
    let keyword: Color
    let string: Color
    let number: Color
    let function: Color
    let type: Color
    let `operator`: Color
    let punctuation: Color
    let property: Color
    let constant: Color
  }

  static let light = Palette(
    text: Color(rgb: (36, 41, 46)),
    comment: Color(rgb: (106, 115, 125)),
    keyword: Color(rgb: (215, 58, 73)),
    string: Color(rgb: (34, 134, 58)),
    number: Color(rgb: (0, 92, 197)),
    function: Color(rgb: (111, 66, 193)),
    type: Color(rgb: (34, 134, 58)),
    operator: Color(rgb: (215, 58, 73)),
    punctuation: Color(rgb: (36, 41, 46)),
    property: Color(rgb: (0, 92, 197)),
    constant: Color(rgb: (0, 92, 197))
  )

  static let dark = Palette(
    text: Color(rgb: (225, 228, 232)),
    comment: Color(rgb: (106, 115, 125)),
    keyword: Color(rgb: (249, 117, 131)),
    string: Color(rgb: (133, 232, 157)),
    number: Color(rgb: (121, 184, 255)),
    function: Color(rgb: (179, 146, 240)),
    type: Color(rgb: (133, 232, 157)),
    operator: Color(rgb: (249, 117, 131)),
    punctuation: Color(rgb: (225, 228, 232)),
    property: Color(rgb: (121, 184, 255)),
    constant: Color(rgb: (121, 184, 255))
  )

  /// 按语言高亮代码，返回 AttributedString
  static func highlight(_ code: String, language: String?, dark: Bool) -> AttributedString {
    let palette = dark ? Self.dark : Self.light
    let lang = normalize(language)
    var result = AttributedString()
    result.font = .system(size: 12, design: .monospaced)

    switch lang {
    case .swift, .typescript, .javascript, .tsx, .jsx, .rust, .go, .python, .c, .cpp, .java, .kotlin:
      result = highlightCLike(code, palette: palette, lang: lang)
    case .json:
      result = highlightJSON(code, palette: palette)
    case .shell, .bash, .zsh:
      result = highlightShell(code, palette: palette)
    case .yaml, .yml:
      result = highlightYAML(code, palette: palette)
    case .html, .xml, .vue, .svelte:
      result = highlightHTML(code, palette: palette)
    case .css, .scss, .less:
      result = highlightCSS(code, palette: palette)
    case .markdown, .md:
      result = highlightMarkdown(code, palette: palette)
    default:
      result = AttributedString(code)
      result.foregroundColor = palette.text
      result.font = .system(size: 12, design: .monospaced)
    }
    return result
  }

  // MARK: - 语言归一化

  private enum Lang {
    case swift, typescript, javascript, tsx, jsx, rust, go, python, c, cpp, java, kotlin
    case json, shell, bash, zsh, yaml, yml, html, xml, vue, svelte, css, scss, less, markdown, md
    case text
  }

  private static func normalize(_ lang: String?) -> Lang {
    guard let lang else { return .text }
    switch lang.lowercased() {
    case "swift": return .swift
    case "typescript", "ts": return .typescript
    case "javascript", "js": return .javascript
    case "tsx": return .tsx
    case "jsx": return .jsx
    case "rust", "rs": return .rust
    case "go", "golang": return .go
    case "python", "py": return .python
    case "c", "h": return .c
    case "cpp", "c++", "cc", "cxx", "hpp": return .cpp
    case "java": return .java
    case "kotlin", "kt": return .kotlin
    case "json": return .json
    case "shell", "sh", "bash", "zsh", "fish": return .shell
    case "yaml", "yml": return .yaml
    case "html", "htm", "xhtml": return .html
    case "xml", "svg", "xsl": return .xml
    case "vue": return .vue
    case "svelte": return .svelte
    case "css": return .css
    case "scss", "sass": return .scss
    case "less": return .less
    case "markdown", "md": return .markdown
    default: return .text
    }
  }

  // MARK: - C 系语言（Swift/TS/JS/Rust/Go/Python/C/C++/Java/Kotlin）

  private static func highlightCLike(_ code: String, palette: Palette, lang: Lang) -> AttributedString {
    var result = AttributedString()
    result.font = .system(size: 12, design: .monospaced)

    let keywords: Set<String>
    let types: Set<String>
    switch lang {
    case .swift:
      keywords = ["import", "struct", "class", "enum", "protocol", "extension", "func", "var", "let", "if", "else", "guard", "switch", "case", "default", "for", "while", "return", "break", "continue", "throw", "throws", "try", "catch", "do", "as", "is", "in", "out", "inout", "where", "typealias", "associatedtype", "init", "deinit", "subscript", "operator", "precedencegroup", "static", "override", "final", "public", "private", "internal", "fileprivate", "open", "weak", "unowned", "lazy", "mutating", "nonmutating", "optional", "required", "convenience", "dynamic", "indirect", "some", "any", "async", "await", "actor", "nonisolated", "isolated", "distributed", "macro", "each", "repeat", "consume", "consuming", "borrowing", "package", "true", "false", "nil", "self", "Self", "super", "willSet", "didSet", "get", "set"]
      types = ["Int", "Int8", "Int16", "Int32", "Int64", "UInt", "UInt8", "UInt16", "UInt32", "UInt64", "Float", "Double", "Bool", "String", "Character", "Array", "Dictionary", "Set", "Optional", "Result", "Error", "AnyObject", "AnyClass", "Codable", "Equatable", "Hashable", "Comparable", "Identifiable", "Sendable", "View", "some", "any"]
    case .typescript, .tsx, .javascript, .jsx:
      keywords = ["import", "export", "from", "default", "const", "let", "var", "function", "return", "if", "else", "switch", "case", "for", "while", "do", "break", "continue", "try", "catch", "finally", "throw", "new", "delete", "typeof", "instanceof", "in", "of", "class", "extends", "super", "this", "static", "get", "set", "async", "await", "yield", "interface", "type", "enum", "namespace", "module", "declare", "abstract", "implements", "readonly", "public", "private", "protected", "true", "false", "null", "undefined", "void", "never", "unknown", "any", "string", "number", "boolean", "object", "symbol", "bigint"]
      types = ["Array", "Object", "String", "Number", "Boolean", "Promise", "Map", "Set", "WeakMap", "WeakSet", "Symbol", "Date", "RegExp", "Error", "TypeError", "JSON", "Math", "console", "window", "document", "React", "Component", "useState", "useEffect", "useRef", "useMemo", "useCallback"]
    case .rust:
      keywords = ["fn", "let", "mut", "const", "static", "struct", "enum", "impl", "trait", "type", "where", "for", "in", "loop", "while", "if", "else", "match", "return", "break", "continue", "use", "mod", "pub", "crate", "self", "Self", "super", "as", "ref", "move", "async", "await", "dyn", "box", "unsafe", "extern", "true", "false", "None", "Some", "Ok", "Err"]
      types = ["i8", "i16", "i32", "i64", "i128", "isize", "u8", "u16", "u32", "u64", "u128", "usize", "f32", "f64", "bool", "char", "str", "String", "Vec", "Option", "Result", "Box", "Rc", "Arc", "Cell", "RefCell", "HashMap", "HashSet", "VecDeque", "LinkedList", "BinaryHeap", "BTreeMap", "BTreeSet"]
    case .go:
      keywords = ["package", "import", "func", "var", "const", "type", "struct", "interface", "map", "chan", "go", "defer", "select", "case", "default", "switch", "if", "else", "for", "range", "return", "break", "continue", "fallthrough", "goto", "true", "false", "nil", "iota"]
      types = ["int", "int8", "int16", "int32", "int64", "uint", "uint8", "uint16", "uint32", "uint64", "uintptr", "float32", "float64", "complex64", "complex128", "bool", "byte", "rune", "string", "error", "any", "comparable"]
    case .python:
      keywords = ["def", "class", "if", "elif", "else", "for", "while", "try", "except", "finally", "with", "as", "import", "from", "return", "yield", "raise", "pass", "break", "continue", "and", "or", "not", "in", "is", "lambda", "global", "nonlocal", "assert", "del", "True", "False", "None", "async", "await", "print", "len", "range", "type", "isinstance", "str", "int", "float", "bool", "list", "dict", "set", "tuple", "self", "cls"]
      types = []
    case .c, .cpp:
      keywords = ["auto", "break", "case", "char", "const", "continue", "default", "do", "double", "else", "enum", "extern", "float", "for", "goto", "if", "int", "long", "register", "return", "short", "signed", "sizeof", "static", "struct", "switch", "typedef", "union", "unsigned", "void", "volatile", "while", "class", "namespace", "template", "typename", "using", "virtual", "override", "final", "public", "private", "protected", "friend", "inline", "constexpr", "nullptr", "this", "new", "delete", "try", "catch", "throw", "noexcept", "true", "false", "bool", "wchar_t", "char8_t", "char16_t", "char32_t", "concept", "requires", "co_await", "co_return", "co_yield", "import", "module", "export"]
      types = ["size_t", "ptrdiff_t", "intptr_t", "uintptr_t", "int8_t", "int16_t", "int32_t", "int64_t", "uint8_t", "uint16_t", "uint32_t", "uint64_t", "string", "vector", "map", "set", "unordered_map", "unordered_set", "pair", "tuple", "optional", "variant", "any", "unique_ptr", "shared_ptr", "weak_ptr", "function", "lambda"]
    case .java, .kotlin:
      keywords = ["package", "import", "public", "private", "protected", "class", "interface", "enum", "extends", "implements", "static", "final", "abstract", "void", "int", "long", "short", "byte", "char", "float", "double", "boolean", "new", "return", "if", "else", "switch", "case", "default", "for", "while", "do", "break", "continue", "try", "catch", "finally", "throw", "throws", "instanceof", "this", "super", "true", "false", "null", "var", "val", "fun", "object", "companion", "init", "constructor", "data", "sealed", "inner", "open", "override", "suspend", "inline", "reified", "crossinline", "noinline", "tailrec", "operator", "infix", "in", "is", "as", "when", "by", "lazy", "lateinit", "vararg", "spread", "out", "typealias", "annotation", "actual", "expect", "external", "internal", "const", "it"]
      types = ["String", "Int", "Long", "Short", "Byte", "Char", "Float", "Double", "Boolean", "Unit", "Any", "Nothing", "Array", "List", "MutableList", "Map", "MutableMap", "Set", "MutableSet", "Pair", "Triple", "Sequence", "Iterable", "Collection", "Iterator", "Comparable", "Throwable", "Exception", "RuntimeException"]
    default:
      keywords = []
      types = []
    }

    var i = code.startIndex
    while i < code.endIndex {
      // 注释
      if code[i] == "/" && code.index(after: i) < code.endIndex {
        let next = code[code.index(after: i)]
        if next == "/" {
          let end = code.firstIndex(of: "\n", after: i) ?? code.endIndex
          var attr = AttributedString(String(code[i..<end]))
          attr.foregroundColor = palette.comment
          result.append(attr)
          i = end
          continue
        } else if next == "*" {
          var end = code.index(after: i)
          var depth = 1
          while end < code.endIndex && depth > 0 {
            if code[end] == "*" && code.index(after: end) < code.endIndex && code[code.index(after: end)] == "/" {
              depth -= 1
              end = code.index(after: end)
            } else if code[end] == "/" && code.index(after: end) < code.endIndex && code[code.index(after: end)] == "*" {
              depth += 1
            }
            end = code.index(after: end)
          }
          var attr = AttributedString(String(code[i..<end]))
          attr.foregroundColor = palette.comment
          result.append(attr)
          i = end
          continue
        }
      }
      // 字符串
      if code[i] == "\"" || code[i] == "'" || code[i] == "`" {
        let quote = code[i]
        var end = code.index(after: i)
        while end < code.endIndex {
          if code[end] == "\\" {
            end = code.index(after: end)
            if end < code.endIndex { end = code.index(after: end) }
            continue
          }
          if code[end] == quote { end = code.index(after: end); break }
          end = code.index(after: end)
        }
        var attr = AttributedString(String(code[i..<end]))
        attr.foregroundColor = palette.string
        result.append(attr)
        i = end
        continue
      }
      // 数字
      if code[i].isNumber {
        var end = i
        while end < code.endIndex && (code[end].isNumber || code[end] == "." || code[end] == "_" || code[end] == "x" || code[end] == "X" || code[end] == "b" || code[end] == "B" || code[end] == "o" || code[end] == "O" || code[end].isHexDigit) {
          end = code.index(after: end)
        }
        var attr = AttributedString(String(code[i..<end]))
        attr.foregroundColor = palette.number
        result.append(attr)
        i = end
        continue
      }
      // 标识符 / 关键字
      if code[i].isLetter || code[i] == "_" {
        var end = i
        while end < code.endIndex && (code[end].isLetter || code[end].isNumber || code[end] == "_") {
          end = code.index(after: end)
        }
        let word = String(code[i..<end])
        var attr = AttributedString(word)
        if keywords.contains(word) {
          attr.foregroundColor = palette.keyword
        } else if types.contains(word) {
          attr.foregroundColor = palette.type
        } else if end < code.endIndex && code[end] == "(" {
          attr.foregroundColor = palette.function
        } else if word.first?.isUppercase == true {
          attr.foregroundColor = palette.type
        } else {
          attr.foregroundColor = palette.text
        }
        result.append(attr)
        i = end
        continue
      }
      // 运算符 / 标点
      var attr = AttributedString(String(code[i]))
      if "+-*/%=<>!&|^~?:".contains(code[i]) {
        attr.foregroundColor = palette.operator
      } else if "{}[]()<>.,;".contains(code[i]) {
        attr.foregroundColor = palette.punctuation
      } else {
        attr.foregroundColor = palette.text
      }
      result.append(attr)
      i = code.index(after: i)
    }
    return result
  }

  // MARK: - JSON

  private static func highlightJSON(_ code: String, palette: Palette) -> AttributedString {
    var result = AttributedString()
    result.font = .system(size: 12, design: .monospaced)
    var i = code.startIndex
    while i < code.endIndex {
      if code[i] == "\"" {
        var end = code.index(after: i)
        while end < code.endIndex {
          if code[end] == "\\" { end = code.index(after: end); if end < code.endIndex { end = code.index(after: end) }; continue }
          if code[end] == "\"" { end = code.index(after: end); break }
          end = code.index(after: end)
        }
        var attr = AttributedString(String(code[i..<end]))
        // key 后面跟冒号
        var j = end
        while j < code.endIndex && code[j].isWhitespace { j = code.index(after: j) }
        if j < code.endIndex && code[j] == ":" {
          attr.foregroundColor = palette.property
        } else {
          attr.foregroundColor = palette.string
        }
        result.append(attr)
        i = end
        continue
      }
      if code[i].isNumber || (code[i] == "-" && code.index(after: i) < code.endIndex && code[code.index(after: i)].isNumber) {
        var end = i
        while end < code.endIndex && (code[end].isNumber || code[end] == "." || code[end] == "-" || code[end] == "+" || code[end] == "e" || code[end] == "E") {
          end = code.index(after: end)
        }
        var attr = AttributedString(String(code[i..<end]))
        attr.foregroundColor = palette.number
        result.append(attr)
        i = end
        continue
      }
      let rest = String(code[i...])
      var matched = false
      for kw in ["true", "false", "null"] {
        if rest.hasPrefix(kw) {
          var attr = AttributedString(kw)
          attr.foregroundColor = palette.constant
          result.append(attr)
          i = code.index(i, offsetBy: kw.count)
          matched = true
          break
        }
      }
      if matched { continue }
      if i >= code.endIndex { break }
      var attr = AttributedString(String(code[i]))
      attr.foregroundColor = palette.punctuation
      result.append(attr)
      i = code.index(after: i)
    }
    return result
  }

  // MARK: - Shell

  private static func highlightShell(_ code: String, palette: Palette) -> AttributedString {
    var result = AttributedString()
    result.font = .system(size: 12, design: .monospaced)
    let lines = code.split(separator: "\n", omittingEmptySubsequences: false)
    for (idx, line) in lines.enumerated() {
      var i = line.startIndex
      // 注释
      if let hashIdx = line.firstIndex(of: "#"), line[..<hashIdx].trimmingCharacters(in: .whitespaces).isEmpty {
        var attr = AttributedString(String(line))
        attr.foregroundColor = palette.comment
        result.append(attr)
        if idx < lines.count - 1 { result.append(AttributedString("\n")) }
        continue
      }
      while i < line.endIndex {
        if line[i] == "\"" || line[i] == "'" {
          let quote = line[i]
          var end = line.index(after: i)
          while end < line.endIndex {
            if line[end] == "\\" { end = line.index(after: end); if end < line.endIndex { end = line.index(after: end) }; continue }
            if line[end] == quote { end = line.index(after: end); break }
            end = line.index(after: end)
          }
          var attr = AttributedString(String(line[i..<end]))
          attr.foregroundColor = palette.string
          result.append(attr)
          i = end
          continue
        }
        if line[i] == "$" {
          var end = line.index(after: i)
          if end < line.endIndex && (line[end].isLetter || line[end] == "_" || line[end] == "{") {
            while end < line.endIndex && (line[end].isLetter || line[end].isNumber || line[end] == "_" || line[end] == "{" || line[end] == "}") {
              end = line.index(after: end)
            }
            var attr = AttributedString(String(line[i..<end]))
            attr.foregroundColor = palette.property
            result.append(attr)
            i = end
            continue
          }
        }
        var attr = AttributedString(String(line[i]))
        attr.foregroundColor = palette.text
        result.append(attr)
        i = line.index(after: i)
      }
      if idx < lines.count - 1 { result.append(AttributedString("\n")) }
    }
    return result
  }

  // MARK: - YAML

  private static func highlightYAML(_ code: String, palette: Palette) -> AttributedString {
    var result = AttributedString()
    result.font = .system(size: 12, design: .monospaced)
    let lines = code.split(separator: "\n", omittingEmptySubsequences: false)
    for (idx, line) in lines.enumerated() {
      let trimmed = line.trimmingCharacters(in: .whitespaces)
      if trimmed.hasPrefix("#") {
        var attr = AttributedString(String(line))
        attr.foregroundColor = palette.comment
        result.append(attr)
      } else if let colonIdx = line.firstIndex(of: ":") {
        let key = String(line[..<colonIdx])
        var keyAttr = AttributedString(key)
        keyAttr.foregroundColor = palette.property
        result.append(keyAttr)
        var colonAttr = AttributedString(":")
        colonAttr.foregroundColor = palette.punctuation
        result.append(colonAttr)
        let value = String(line[line.index(after: colonIdx)...])
        var valueAttr = AttributedString(value)
        valueAttr.foregroundColor = palette.text
        result.append(valueAttr)
      } else {
        var attr = AttributedString(String(line))
        attr.foregroundColor = palette.text
        result.append(attr)
      }
      if idx < lines.count - 1 { result.append(AttributedString("\n")) }
    }
    return result
  }

  // MARK: - HTML/XML

  private static func highlightHTML(_ code: String, palette: Palette) -> AttributedString {
    var result = AttributedString()
    result.font = .system(size: 12, design: .monospaced)
    var i = code.startIndex
    while i < code.endIndex {
      if code[i] == "<" {
        var end = code.index(after: i)
        var isComment = false
        if end < code.endIndex && code[end] == "!" {
          isComment = true
          while end < code.endIndex {
            if code[end] == "-" && code.index(after: end) < code.endIndex && code[code.index(after: end)] == "-" {
              let afterDash = code.index(after: end)
              if code.index(afterDash, offsetBy: 1, limitedBy: code.endIndex) != nil {
                let nextIdx = code.index(afterDash, offsetBy: 1)
                if nextIdx < code.endIndex && code[nextIdx] == ">" {
                  end = code.index(nextIdx, offsetBy: 1, limitedBy: code.endIndex) ?? code.endIndex
                  break
                }
              }
            }
            end = code.index(after: end)
          }
        } else {
          while end < code.endIndex && code[end] != ">" { end = code.index(after: end) }
          if end < code.endIndex { end = code.index(after: end) }
        }
        var attr = AttributedString(String(code[i..<end]))
        attr.foregroundColor = isComment ? palette.comment : palette.keyword
        result.append(attr)
        i = end
        continue
      }
      var attr = AttributedString(String(code[i]))
      attr.foregroundColor = palette.text
      result.append(attr)
      i = code.index(after: i)
    }
    return result
  }

  // MARK: - CSS

  private static func highlightCSS(_ code: String, palette: Palette) -> AttributedString {
    var result = AttributedString()
    result.font = .system(size: 12, design: .monospaced)
    var i = code.startIndex
    while i < code.endIndex {
      if code[i] == "/" && code.index(after: i) < code.endIndex && code[code.index(after: i)] == "*" {
        var end = code.index(after: i)
        while end < code.endIndex {
          if code[end] == "*" && code.index(after: end) < code.endIndex && code[code.index(after: end)] == "/" {
            end = code.index(after: end)
            break
          }
          end = code.index(after: end)
        }
        if end < code.endIndex { end = code.index(after: end) }
        var attr = AttributedString(String(code[i..<end]))
        attr.foregroundColor = palette.comment
        result.append(attr)
        i = end
        continue
      }
      if code[i] == "@" {
        var end = code.index(after: i)
        while end < code.endIndex && (code[end].isLetter || code[end] == "-") { end = code.index(after: end) }
        var attr = AttributedString(String(code[i..<end]))
        attr.foregroundColor = palette.keyword
        result.append(attr)
        i = end
        continue
      }
      var attr = AttributedString(String(code[i]))
      attr.foregroundColor = palette.text
      result.append(attr)
      i = code.index(after: i)
    }
    return result
  }

  // MARK: - Markdown

  private static func highlightMarkdown(_ code: String, palette: Palette) -> AttributedString {
    var result = AttributedString()
    result.font = .system(size: 12, design: .monospaced)
    let lines = code.split(separator: "\n", omittingEmptySubsequences: false)
    for (idx, line) in lines.enumerated() {
      let trimmed = line.trimmingCharacters(in: .whitespaces)
      if trimmed.hasPrefix("#") {
        var attr = AttributedString(String(line))
        attr.foregroundColor = palette.keyword
        attr.font = .system(size: 12, weight: .bold, design: .monospaced)
        result.append(attr)
      } else if trimmed.hasPrefix("```") {
        var attr = AttributedString(String(line))
        attr.foregroundColor = palette.comment
        result.append(attr)
      } else if trimmed.hasPrefix("- ") || trimmed.hasPrefix("* ") || trimmed.range(of: #"^\d+\.\s"#, options: .regularExpression) != nil {
        var attr = AttributedString(String(line))
        attr.foregroundColor = palette.text
        result.append(attr)
      } else {
        var attr = AttributedString(String(line))
        attr.foregroundColor = palette.text
        result.append(attr)
      }
      if idx < lines.count - 1 { result.append(AttributedString("\n")) }
    }
    return result
  }
}

// MARK: - String 辅助

private extension String {
  func firstIndex(of char: Character, after: Index) -> Index? {
    var i = self.index(after: after)
    while i < endIndex {
      if self[i] == char { return i }
      i = self.index(after: i)
    }
    return nil
  }
}
