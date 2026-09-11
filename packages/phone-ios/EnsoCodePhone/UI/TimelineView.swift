import SwiftUI
import UIKit

struct TimelineView: View {
  @Environment(\.ensoPalette) var palette
  var view: GuestSessionView?
  var projectName: String
  var cwd: String?
  var compact: Bool
  var hasOlder: Bool
  var historyLoading: Bool
  /// 连接状态：非 online 时顶部横幅已承担状态提示，中间不再重复显示加载态
  var connState: ConnState = .online
  var onLoadOlder: () -> Void

  @State private var atBottom = true
  @State private var expandedGroups: Set<String> = []
  /// 无限滚动：记录加载前第一个可见 item id，加载后滚回它
  @State private var anchorItemId: String?
  @State private var pendingScrollRestore = false

  private var items: [TimelineItem] {
    guard let view else { return [] }
    let raw = TimelineBuilder.build(
      messages: view.sortedMessages,
      running: view.isRunning,
      cwd: cwd,
      approvals: view.approvals,
      compaction: view.compaction
    )
    return TimelineFold.fold(raw, running: view.isRunning, expandedKeys: expandedGroups, compact: compact)
  }

  var body: some View {
    let rows = items
    ScrollViewReader { proxy in
      ScrollView {
        // PWA: CHAT_COL px-4，行间 pb-4
        LazyVStack(alignment: .leading, spacing: 16) {
          // 无限滚动：顶部哨兵，进入视口即触发加载
          if hasOlder {
            Color.clear
              .frame(height: 1)
              .id("top-sentinel")
              .onAppear {
                guard !historyLoading, !pendingScrollRestore else { return }
                // 记录当前第一个 item 作为锚点
                anchorItemId = rows.first?.id
                pendingScrollRestore = true
                onLoadOlder()
              }
            if historyLoading {
              HStack(spacing: 8) {
                ProgressView().controlSize(.mini)
                Text("加载中…")
              }
              .font(.system(size: EnsoFont.sm))
              .foregroundStyle(palette.mutedForeground)
              .frame(maxWidth: .infinity)
              .padding(.vertical, 12)
            }
          }
          if view == nil && connState == .online {
            // 已连接但快照未到（同步中）：中间加载态
            VStack(spacing: 10) {
              ProgressView().controlSize(.regular).tint(palette.mutedForeground)
              Text("正在准备会话…")
                .font(.system(size: EnsoFont.base))
                .foregroundStyle(palette.mutedForeground)
            }
            .frame(maxWidth: .infinity)
            .padding(.top, 120)
          } else if view != nil && rows.isEmpty && view?.status != "running" {
            VStack(spacing: 8) {
              Text(projectName)
                .font(.system(size: EnsoFont.xl, weight: .medium))
              Text("开始对话吧")
                .font(.system(size: EnsoFont.base))
                .foregroundStyle(palette.mutedForeground)
            }
            .frame(maxWidth: .infinity)
            .padding(.top, 120)
          }
          ForEach(rows) { item in
            TimelineRow(item: item) {
              if expandedGroups.contains(item.id) { expandedGroups.remove(item.id) }
              else { expandedGroups.insert(item.id) }
            }
            .id(item.id)
          }
          if view?.isRunning == true {
            RunningFooter()
          }
          Color.clear
            .frame(height: 1)
            .id("bottom")
            .onAppear { atBottom = true }
            .onDisappear { atBottom = false }
        }
        .padding(.horizontal, 16)
        .padding(.vertical, 12)
      }
      .scrollDismissesKeyboard(.interactively)
      .simultaneousGesture(TapGesture().onEnded { hideKeyboard() })
      .onChange(of: stamp) { _, _ in
        if atBottom { proxy.scrollTo("bottom", anchor: .bottom) }
      }
      .onChange(of: historyLoading) { _, loading in
        // 加载完成：滚回锚点 item，保持视觉位置
        if !loading, pendingScrollRestore, let anchorId = anchorItemId {
          pendingScrollRestore = false
          DispatchQueue.main.asyncAfter(deadline: .now() + 0.05) {
            withAnimation(.easeOut(duration: 0.1)) {
              proxy.scrollTo(anchorId, anchor: .top)
            }
          }
        }
      }
      .overlay(alignment: .bottom) {
        // PWA: absolute bottom-4 居中，rounded-full border bg-background shadow-md
        if !atBottom {
          Button {
            atBottom = true
            proxy.scrollTo("bottom", anchor: .bottom)
          } label: {
            Image(systemName: "arrow.down")
              .font(.system(size: 14, weight: .semibold))
              .foregroundStyle(palette.mutedForeground)
              .padding(8)
              .background(palette.background)
              .clipShape(Circle())
              .overlay(Circle().stroke(palette.border, lineWidth: 1))
              .shadow(color: Color.black.opacity(0.12), radius: 4, y: 2)
          }
          .padding(.bottom, 16)
          .accessibilityLabel("回到底部")
        }
      }
    }
  }

  private var stamp: String {
    guard let last = items.last else { return "" }
    return "\(items.count)-\(last.id)-\(last.text.count)-\(last.state)-\(last.streaming)"
  }
}

/// running 底部：3 个跳动点（PWA animate-bounce 150ms 交错）
struct RunningFooter: View {
  @Environment(\.ensoPalette) var palette
  @State private var tick = false

  var body: some View {
    HStack(spacing: 4) {
      ForEach(0..<3, id: \.self) { i in
        Circle()
          .fill(palette.mutedForeground.opacity(0.6))
          .frame(width: 6, height: 6)
          .offset(y: tick ? -3 : 0)
          .animation(
            .easeInOut(duration: 0.45).repeatForever(autoreverses: true).delay(Double(i) * 0.15),
            value: tick
          )
      }
    }
    .padding(.vertical, 4)
    .onAppear { tick = true }
  }
}

struct TimelineRow: View {
  @Environment(\.ensoPalette) var palette
  let item: TimelineItem
  var onToggleGroup: () -> Void = {}

  var body: some View {
    switch item.kind {
    case .user: userBubble
    case .text: assistantText
    case .thinking: ThinkingBlock(text: item.text, streaming: item.streaming)
    case .tool: ToolCallRow(item: item)
    case .toolGroup: ToolGroupRow(item: item, onToggle: onToggleGroup)
    case .error: ErrorBox(text: item.text)
    case .compaction: compactionRow
    case .compactionProgress:
      Label(item.text, systemImage: "arrow.triangle.2.circlepath")
        .font(.system(size: EnsoFont.sm))
        .foregroundStyle(palette.mutedForeground)
    case .taskNote:
      HStack(alignment: .top, spacing: 8) {
        Image(systemName: "terminal")
          .font(.system(size: 13))
          .padding(.top, 1)
        Text(item.text)
          .font(.system(size: EnsoFont.sm))
          .fixedSize(horizontal: false, vertical: true)
      }
      .foregroundStyle(palette.mutedForeground)
      .padding(.horizontal, 12)
      .padding(.vertical, 8)
      .frame(maxWidth: .infinity, alignment: .leading)
      .overlay(
        RoundedRectangle(cornerRadius: EnsoRadius.lg)
          .stroke(style: StrokeStyle(lineWidth: 1, dash: [4]))
          .foregroundStyle(palette.border)
      )
    }
  }

  // PWA: max-w-[80%] rounded-2xl rounded-br-md bg-muted px-4 py-2.5 text-sm，靠右
  private var userBubble: some View {
    HStack(alignment: .top, spacing: 0) {
      Spacer(minLength: 48)
      VStack(alignment: .trailing, spacing: 6) {
        ForEach(Array(item.images.enumerated()), id: \.offset) { _, img in
          if let raw = Data(base64Encoded: img.data), let ui = UIImage(data: raw) {
            Image(uiImage: ui)
              .resizable()
              .scaledToFit()
              .frame(maxWidth: 220, maxHeight: 192)
              .clipShape(RoundedRectangle(cornerRadius: EnsoRadius.lg))
              .overlay(RoundedRectangle(cornerRadius: EnsoRadius.lg).stroke(palette.border, lineWidth: 1))
          }
        }
        if !item.text.isEmpty {
          Text(item.text)
            .font(.system(size: EnsoFont.base))
            .lineSpacing(4)
            .multilineTextAlignment(.leading)
            .fixedSize(horizontal: false, vertical: true)
            .padding(.horizontal, 16)
            .padding(.vertical, 10)
            .background(palette.muted)
            .clipShape(
              UnevenRoundedRectangle(
                topLeadingRadius: EnsoRadius.xxl,
                bottomLeadingRadius: EnsoRadius.xxl,
                bottomTrailingRadius: EnsoRadius.lg,
                topTrailingRadius: EnsoRadius.xxl
              )
            )
        }
      }
    }
  }

  // PWA: text-sm + 底部操作条（复制）
  private var assistantText: some View {
    VStack(alignment: .leading, spacing: 4) {
      ChatMarkdown(text: item.text)
      HStack(spacing: 8) {
        if item.streaming { ProgressView().controlSize(.mini) }
        Spacer()
        Button {
          UIPasteboard.general.string = item.text
        } label: {
          Image(systemName: "doc.on.doc")
            .font(.system(size: EnsoFont.xs))
            .foregroundStyle(palette.mutedForeground)
        }
        .accessibilityLabel("复制")
      }
    }
    .frame(maxWidth: .infinity, alignment: .leading)
  }

  // PWA CompactionRow：左右横线夹胶囊文案
  private var compactionRow: some View {
    HStack(spacing: 12) {
      palette.border.frame(height: 1).frame(maxWidth: .infinity)
      HStack(spacing: 6) {
        Image(systemName: "shippingbox")
          .font(.system(size: 11))
        Text(item.tokensBefore.map { "上下文已压缩（原 \(formatTokens($0)) tokens）" } ?? "上下文已压缩")
          .font(.system(size: EnsoFont.xs))
      }
      .foregroundStyle(palette.mutedForeground)
      palette.border.frame(height: 1).frame(maxWidth: .infinity)
    }
  }

  private func formatTokens(_ n: Int) -> String {
    n >= 1000 ? String(format: "%.1fk", Double(n) / 1000) : "\(n)"
  }
}

// PWA ToolGroupRow: rounded-lg border border-border/60 bg-muted/30 px-3 py-1.5 text-xs
struct ToolGroupRow: View {
  @Environment(\.ensoPalette) var palette
  let item: TimelineItem
  var onToggle: () -> Void

  var body: some View {
    Button(action: onToggle) {
      if item.stats.commands == 0 && (item.stats.reads > 0 || item.stats.searches > 0) {
        // 精简探索行：无卡片，纯文字
        HStack(alignment: .firstTextBaseline, spacing: 6) {
          Text(item.exploring ? "探索中" : "探索了")
          Text(exploredLabel).foregroundStyle(palette.mutedForeground).lineLimit(1)
        }
        .font(.system(size: EnsoFont.base))
        .opacity(item.exploring ? 0.7 : 1)
      } else {
        HStack(spacing: 8) {
          Image(systemName: "chevron.right")
            .font(.system(size: 10, weight: .semibold))
            .rotationEffect(.degrees(item.expanded ? 90 : 0))
          Text("\(item.groupCount) 次工具调用").font(.system(size: EnsoFont.sm, weight: .medium))
          if !parts.isEmpty {
            Text("·").foregroundStyle(palette.mutedForeground.opacity(0.5))
            Text(parts.joined(separator: " · ")).lineLimit(1).foregroundStyle(palette.mutedForeground)
          }
          Spacer(minLength: 0)
        }
        .font(.system(size: EnsoFont.sm))
        .padding(.horizontal, 12)
        .padding(.vertical, 6)
        .background(palette.muted.opacity(0.3))
        .overlay(RoundedRectangle(cornerRadius: EnsoRadius.lg).stroke(palette.border.opacity(0.6), lineWidth: 1))
        .clipShape(RoundedRectangle(cornerRadius: EnsoRadius.lg))
      }
    }
    .buttonStyle(.plain)
    .foregroundStyle(palette.foreground)
  }

  private var exploredLabel: String {
    var bits: [String] = []
    if item.stats.reads > 0 { bits.append("\(item.stats.reads) 个文件") }
    if item.stats.searches > 0 { bits.append("\(item.stats.searches) 次检索") }
    return bits.joined(separator: ", ")
  }

  private var parts: [String] {
    var bits: [String] = []
    if item.stats.commands > 0 { bits.append("跑了 \(item.stats.commands) 条命令") }
    if item.stats.reads > 0 { bits.append("读了 \(item.stats.reads) 个文件") }
    if item.stats.searches > 0 { bits.append("检索 \(item.stats.searches) 次") }
    if item.stats.others > 0 { bits.append("\(item.stats.others) 次其他调用") }
    return bits
  }
}

// PWA ThinkingRow：折叠头 text-xs muted + 展开 border-l-2 pl-3 text-xs muted
struct ThinkingBlock: View {
  @Environment(\.ensoPalette) var palette
  let text: String
  var streaming: Bool
  @State private var open = false

  var body: some View {
    VStack(alignment: .leading, spacing: 6) {
      Button { open.toggle() } label: {
        HStack(spacing: 6) {
          Image(systemName: "brain.head.profile")
            .modifier(PulseModifier(active: streaming))
          Text(streaming ? "思考中…" : "思考过程")
          Spacer()
          Image(systemName: "chevron.right")
            .font(.system(size: 10, weight: .semibold))
            .rotationEffect(.degrees(expanded ? 90 : 0))
        }
        .font(.system(size: EnsoFont.sm))
        .foregroundStyle(palette.mutedForeground)
      }
      .buttonStyle(.plain)
      if expanded {
        Text(text)
          .font(.system(size: EnsoFont.sm))
          .foregroundStyle(palette.mutedForeground)
          .lineSpacing(4)
          .fixedSize(horizontal: false, vertical: true)
          .padding(.leading, 12)
          .overlay(alignment: .leading) { palette.border.frame(width: 2) }
      }
    }
    .onChange(of: streaming) { _, next in open = next }
    .onAppear { if streaming { open = true } }
  }

  private var expanded: Bool { streaming || open }
}

// PWA ToolRow: rounded-lg border border-border/60 bg-muted/30；条头 px-3 py-1.5 text-xs
struct ToolCallRow: View {
  @Environment(\.ensoPalette) var palette
  let item: TimelineItem
  @State private var open = false

  var body: some View {
    VStack(alignment: .leading, spacing: 0) {
      Button { open.toggle() } label: {
        HStack(spacing: 8) {
          statusIcon
          Text(item.name).font(.system(size: EnsoFont.sm, weight: .medium))
          Text("·").foregroundStyle(palette.mutedForeground.opacity(0.5))
          if !open {
            Text(item.summary)
              .font(EnsoFont.mono(EnsoFont.sm))
              .foregroundStyle(item.state == "error" ? palette.destructive : palette.mutedForeground)
              .lineLimit(1)
          }
          Spacer(minLength: 0)
          if let ms = item.durationMs {
            Text(formatMs(ms))
              .font(EnsoFont.mono(10))
              .foregroundStyle(palette.mutedForeground.opacity(0.7))
          }
          Image(systemName: "chevron.right")
            .font(.system(size: 10, weight: .semibold))
            .foregroundStyle(palette.mutedForeground)
            .rotationEffect(.degrees(open ? 90 : 0))
        }
        .font(.system(size: EnsoFont.sm))
        .padding(.horizontal, 12)
        .padding(.vertical, 6)
        .contentShape(Rectangle())
      }
      .buttonStyle(.plain)
      if open {
        VStack(alignment: .leading, spacing: 6) {
          if !item.summary.isEmpty {
            Text(item.summary)
              .font(EnsoFont.mono(EnsoFont.sm))
              .foregroundStyle(palette.mutedForeground)
              .fixedSize(horizontal: false, vertical: true)
              .frame(maxWidth: .infinity, alignment: .leading)
          }
          if !item.edits.isEmpty {
            ForEach(Array(item.edits.enumerated()), id: \.offset) { _, diff in
              DiffView(oldText: diff.oldText, newText: diff.newText)
            }
          }
          if let write = item.writeContent, !write.isEmpty {
            Text(write)
              .font(EnsoFont.mono(EnsoFont.xs))
              .foregroundStyle(palette.mutedForeground)
              .fixedSize(horizontal: false, vertical: true)
              .frame(maxWidth: .infinity, alignment: .leading)
              .padding(8)
              .background(palette.muted.opacity(0.5))
              .clipShape(RoundedRectangle(cornerRadius: EnsoRadius.md))
          }
          if !item.todos.isEmpty { TodoListView(items: item.todos) }
          if !item.output.isEmpty {
            Text(item.output)
              .font(EnsoFont.mono(EnsoFont.xs))
              .foregroundStyle(palette.mutedForeground)
              .fixedSize(horizontal: false, vertical: true)
              .frame(maxWidth: .infinity, alignment: .leading)
              .padding(8)
              .background(palette.muted.opacity(0.5))
              .clipShape(RoundedRectangle(cornerRadius: EnsoRadius.md))
          }
        }
        .padding(.horizontal, 12)
        .padding(.vertical, 8)
        .overlay(alignment: .top) { palette.border.opacity(0.6).frame(height: 1) }
      }
    }
    .background(palette.muted.opacity(0.3))
    .overlay(RoundedRectangle(cornerRadius: EnsoRadius.lg).stroke(palette.border.opacity(0.6), lineWidth: 1))
    .clipShape(RoundedRectangle(cornerRadius: EnsoRadius.lg))
  }

  // PWA ToolStateIcon：running/reviewing 旋转 loader，ok 灰勾，error 红叹号
  @ViewBuilder
  private var statusIcon: some View {
    switch item.state {
    case "running":
      ProgressView().controlSize(.mini).tint(palette.mutedForeground)
    case "reviewing":
      ProgressView().controlSize(.mini).tint(palette.mutedForeground)
    case "error":
      Image(systemName: "exclamationmark.circle")
        .font(.system(size: 13))
        .foregroundStyle(palette.destructive)
    default:
      Image(systemName: "checkmark")
        .font(.system(size: 12, weight: .semibold))
        .foregroundStyle(palette.mutedForeground)
    }
  }
}

struct TodoListView: View {
  @Environment(\.ensoPalette) var palette
  let items: [TodoItem]

  var body: some View {
    let done = items.filter { $0.status == "completed" }.count
    VStack(alignment: .leading, spacing: 6) {
      HStack(spacing: 6) {
        Image(systemName: "checklist")
        Text("待办清单")
        Text("\(done)/\(items.count)").foregroundStyle(palette.mutedForeground)
      }
      .font(.system(size: EnsoFont.sm, weight: .medium))
      ForEach(Array(items.enumerated()), id: \.offset) { _, item in
        HStack(alignment: .top, spacing: 6) {
          Image(
            systemName: item.status == "completed"
              ? "checkmark.circle.fill"
              : item.status == "in_progress" ? "circle.inset.filled" : "circle"
          )
          .font(.system(size: 13))
          .foregroundStyle(
            item.status == "completed" ? palette.success
              : item.status == "in_progress" ? palette.info : palette.mutedForeground
          )
          Text(item.content).font(.system(size: EnsoFont.md))
        }
      }
    }
  }
}

struct DiffView: View {
  @Environment(\.ensoPalette) var palette
  let oldText: String
  let newText: String

  var body: some View {
    VStack(alignment: .leading, spacing: 0) {
      ForEach(Array(oldText.split(separator: "\n", omittingEmptySubsequences: false).prefix(12).enumerated()), id: \.offset) { _, line in
        Text("- \(line)")
          .font(EnsoFont.mono(EnsoFont.xs))
          .foregroundStyle(palette.destructive)
          .frame(maxWidth: .infinity, alignment: .leading)
          .padding(.horizontal, 8)
          .background(palette.destructive.opacity(0.08))
      }
      ForEach(Array(newText.split(separator: "\n", omittingEmptySubsequences: false).prefix(12).enumerated()), id: \.offset) { _, line in
        Text("+ \(line)")
          .font(EnsoFont.mono(EnsoFont.xs))
          .foregroundStyle(palette.success)
          .frame(maxWidth: .infinity, alignment: .leading)
          .padding(.horizontal, 8)
          .background(palette.success.opacity(0.08))
      }
    }
    .clipShape(RoundedRectangle(cornerRadius: EnsoRadius.md))
  }
}

// PWA 轮次错误：flex items-start gap-2 text-sm text-destructive
struct ErrorBox: View {
  @Environment(\.ensoPalette) var palette
  let text: String

  var body: some View {
    HStack(alignment: .top, spacing: 8) {
      Image(systemName: "exclamationmark.circle")
        .font(.system(size: 13))
        .padding(.top, 1)
      Text(text)
        .font(.system(size: EnsoFont.base))
        .fixedSize(horizontal: false, vertical: true)
    }
    .foregroundStyle(palette.destructive)
  }
}

func hideKeyboard() {
  UIApplication.shared.sendAction(#selector(UIResponder.resignFirstResponder), to: nil, from: nil, for: nil)
}

private func formatMs(_ ms: Int) -> String {
  if ms < 1000 { return "\(ms)ms" }
  let s = Double(ms) / 1000
  if s < 60 { return String(format: "%.1fs", s) }
  return String(format: "%.0fm %.0fs", s / 60, s.truncatingRemainder(dividingBy: 60))
}
