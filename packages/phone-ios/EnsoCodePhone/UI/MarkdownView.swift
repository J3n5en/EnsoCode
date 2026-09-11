import SwiftUI

struct ChatMarkdown: View {
  @Environment(\.ensoPalette) var palette
  let text: String

  var body: some View {
    let blocks = MarkdownParse.parse(text)
    VStack(alignment: .leading, spacing: 6) {
      ForEach(Array(blocks.enumerated()), id: \.offset) { _, block in
        blockView(block)
      }
    }
    .frame(maxWidth: .infinity, alignment: .leading)
  }

  @ViewBuilder
  private func blockView(_ block: MarkdownBlock) -> some View {
    switch block {
    case .heading(let level, let text):
      inline(text)
        .font(.system(size: level <= 2 ? 16 : 14, weight: .semibold))
        .padding(.top, 6)
        .fixedSize(horizontal: false, vertical: true)
    case .paragraph(let text):
      inline(text)
        .font(.system(size: 14))
        .lineSpacing(5)
        .fixedSize(horizontal: false, vertical: true)
    case .list(let ordered, let items):
      VStack(alignment: .leading, spacing: 4) {
        ForEach(Array(items.enumerated()), id: \.offset) { i, item in
          HStack(alignment: .top, spacing: 8) {
            Text(ordered ? "\(i + 1)." : "•")
              .font(.system(size: 14))
              .frame(width: 18, alignment: .trailing)
            inline(item.text)
              .font(.system(size: 14))
              .lineSpacing(4)
              .fixedSize(horizontal: false, vertical: true)
          }
          .padding(.leading, CGFloat(item.indent * 16))
        }
      }
    case .quote(let text):
      inline(text)
        .font(.system(size: 14))
        .foregroundStyle(.secondary)
        .padding(.leading, 12)
        .overlay(alignment: .leading) {
          Rectangle().fill(Color.gray.opacity(0.35)).frame(width: 2)
        }
        .fixedSize(horizontal: false, vertical: true)
    case .code(let lang, let body):
      CodeBlockView(code: body, language: lang, palette: palette)
    case .table(let headers, let rows):
      ScrollView(.horizontal, showsIndicators: true) {
        VStack(alignment: .leading, spacing: 0) {
          rowView(headers, header: true)
          ForEach(Array(rows.enumerated()), id: \.offset) { _, r in
            rowView(r, header: false)
          }
        }
      }
    case .hr:
      Divider().padding(.vertical, 8)
    }
  }

  private func rowView(_ cells: [String], header: Bool) -> some View {
    HStack(alignment: .top, spacing: 0) {
      ForEach(Array(cells.enumerated()), id: \.offset) { _, cell in
        Text(cell)
          .font(.system(size: 12, weight: header ? .medium : .regular))
          .padding(.horizontal, 8)
          .padding(.vertical, 4)
          .frame(minWidth: 72, alignment: .leading)
      }
    }
    .overlay(alignment: .bottom) { Divider() }
  }

  private func inline(_ raw: String) -> Text {
    let options = AttributedString.MarkdownParsingOptions(
      interpretedSyntax: .inlineOnlyPreservingWhitespace,
      failurePolicy: .returnPartiallyParsedIfPossible
    )
    if let attr = try? AttributedString(markdown: raw, options: options) {
      return Text(attr)
    }
    return Text(raw)
  }
}

/// 代码块：语法高亮 + 复制按钮（对齐 PWA CodeBlock）
struct CodeBlockView: View {
  let code: String
  let language: String?
  let palette: EnsoPalette
  @State private var copied = false

  var body: some View {
    let highlighted = SyntaxHighlight.highlight(code, language: language, dark: palette.isDark)
    VStack(alignment: .leading, spacing: 0) {
      ScrollView(.horizontal, showsIndicators: false) {
        Text(highlighted)
          .font(.system(size: 12, design: .monospaced))
          .fixedSize(horizontal: true, vertical: true)
          .padding(10)
      }
    }
    .frame(maxWidth: .infinity, alignment: .leading)
    .background(palette.isDark ? Color(rgb: (36, 41, 46)) : Color(rgb: (246, 248, 250)))
    .clipShape(RoundedRectangle(cornerRadius: 6))
    .overlay(
      RoundedRectangle(cornerRadius: 6)
        .stroke(palette.border, lineWidth: 1)
    )
    .overlay(alignment: .topTrailing) {
      Button {
        UIPasteboard.general.string = code
        copied = true
        DispatchQueue.main.asyncAfter(deadline: .now() + 1.5) { copied = false }
      } label: {
        Image(systemName: copied ? "checkmark" : "doc.on.doc")
          .font(.system(size: 11))
          .foregroundStyle(copied ? palette.success : palette.mutedForeground)
          .padding(6)
          .background(palette.background.opacity(0.8))
          .clipShape(RoundedRectangle(cornerRadius: 4))
          .overlay(RoundedRectangle(cornerRadius: 4).stroke(palette.border, lineWidth: 1))
      }
      .padding(4)
    }
  }
}
