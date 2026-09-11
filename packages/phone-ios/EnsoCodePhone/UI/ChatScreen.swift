import PhotosUI
import SwiftUI

struct ChatScreen: View {
  @EnvironmentObject var model: AppModel
  @Environment(\.ensoPalette) var palette

  var body: some View {
    VStack(spacing: 0) {
      header
      if let banner = model.banner {
        StateBanner(label: banner.label, tone: banner.tone)
      }
      if let group = model.tabGroup {
        coworkerTabs(group)
      }
      if model.activeId == nil {
        emptyState
      } else {
        TimelineView(
          view: model.view,
          projectName: model.entry?.projectName ?? "EnsoCode",
          cwd: model.entry?.cwd,
          compact: model.compactReadOnlyTools,
          hasOlder: hasOlder,
          historyLoading: model.activeId.map { model.historyPending.contains($0) } ?? false,
          connState: model.state,
          onLoadOlder: { model.loadOlder() }
        )
      }
    }
    .background(palette.background)
    .safeAreaInset(edge: .bottom, spacing: 0) {
      if model.activeId != nil { bottomBar }
    }
  }

  private var hasOlder: Bool {
    guard let view = model.view, !view.messages.isEmpty, let min = view.messages.keys.min() else { return false }
    return min > 0
  }

  // PWA: header flex items-center gap-1 border-b px-2 py-2
  private var header: some View {
    HStack(spacing: 4) {
      HeaderIconButton(icon: "sidebar.left", label: "打开会话列表") { model.drawerOpen = true }
      VStack(spacing: 1) {
        Text(model.entry?.title.isEmpty == false ? model.entry!.title : (model.activeId != nil ? "会话" : "EnsoCode"))
          .font(.system(size: EnsoFont.base, weight: .medium))
          .lineLimit(1)
        Text(model.entry?.projectName.isEmpty == false ? model.entry!.projectName : model.connectionLabel)
          .font(EnsoFont.mono(EnsoFont.xs))
          .foregroundStyle(palette.mutedForeground)
          .lineLimit(1)
      }
      .frame(maxWidth: .infinity)
      HeaderIconButton(icon: "square.and.pencil", label: "新建会话") {
        model.composeProjectId = nil
        model.composing = true
      }
      .disabled(!model.canCreate)
      .opacity(model.canCreate ? 1 : 0.4)
    }
    .padding(.horizontal, 8)
    .padding(.vertical, 8)
    .background(palette.background)
    .overlay(alignment: .bottom) { EnsoDivider() }
  }

  // PWA: coworker tab 条 flex items-center gap-1 overflow-x-auto border-b px-2 py-1
  private func coworkerTabs(_ group: (parent: CatalogEntry, children: [CatalogEntry])) -> some View {
    ScrollView(.horizontal, showsIndicators: false) {
      HStack(spacing: 4) {
        tabButton(group.parent.title.isEmpty ? "新对话" : group.parent.title, active: model.activeId == group.parent.id, bot: false) {
          model.setActiveSession(group.parent.id)
        }
        ForEach(group.children) { child in
          tabButton(child.title.isEmpty ? "coworker" : child.title, active: model.activeId == child.id, bot: true, status: child.status) {
            model.setActiveSession(child.id)
          }
        }
      }
      .padding(.horizontal, 8)
      .padding(.vertical, 4)
    }
    .overlay(alignment: .bottom) { EnsoDivider() }
  }

  // PWA tabClass: flex items-center gap-1.5 rounded-md px-2 py-1 text-xs; active: bg-muted font-medium
  private func tabButton(_ title: String, active: Bool, bot: Bool, status: String = "", action: @escaping () -> Void) -> some View {
    Button(action: action) {
      HStack(spacing: 6) {
        if bot { Image(systemName: "cpu").font(.system(size: EnsoFont.sm)) }
        Text(title).lineLimit(1)
        if bot {
          Circle()
            .fill(status == "running" ? palette.info : status == "failed" ? palette.destructive : palette.mutedForeground.opacity(0.3))
            .frame(width: 6, height: 6)
            .modifier(PulseModifier(active: status == "running"))
        }
      }
      .font(.system(size: EnsoFont.sm, weight: active ? .medium : .regular))
      .padding(.horizontal, 8)
      .padding(.vertical, 4)
      .background(active ? palette.muted : Color.clear)
      .clipShape(RoundedRectangle(cornerRadius: EnsoRadius.md))
      .foregroundStyle(active ? palette.foreground : palette.mutedForeground)
    }
    .buttonStyle(.plain)
  }

  // PWA 空态：标题 text-lg font-medium + 副标题 text-sm text-muted-foreground
  private var emptyState: some View {
    VStack(spacing: 4) {
      Text("EnsoCode").font(.system(size: EnsoFont.xl, weight: .medium))
      Text(model.state == .online ? "从左上角选择会话，或新建一个" : model.connectionLabel)
        .font(.system(size: EnsoFont.base))
        .foregroundStyle(palette.mutedForeground)
    }
    .frame(maxWidth: .infinity, maxHeight: .infinity)
    .onTapGesture { hideKeyboard() }
  }

  // PWA: @container shrink-0 pt-1，内部 CHAT_COL，各条 mb-1
  private var bottomBar: some View {
    VStack(spacing: 4) {
      if let retry = model.view?.retry {
        RetryBanner(retry: retry)
      }
      if let queued = model.entry?.queued, !queued.isEmpty, let sid = model.activeId {
        MessageQueueView(sessionId: sid, queued: queued)
      }
      TaskCapsules(
        sessionId: model.activeId ?? "",
        tasks: model.view?.tasks ?? [],
        subagents: model.view?.subagents ?? []
      )
      if let sid = model.activeId {
        ApprovalBar(approvals: model.view?.approvals ?? []) { req, decision in
          model.send(.approvalRespond(sessionId: sid, requestId: req, decision: decision))
        }
        AskBar(asks: model.view?.asks ?? []) { req, answer in
          model.send(.askRespond(sessionId: sid, requestId: req, answer: answer))
        }
      }
      ComposerBar(
        running: model.view?.isRunning == true,
        locked: !(model.view?.approvals.isEmpty ?? true),
        modelLabel: model.modelLabel,
        onOpenConfig: model.configurable ? { model.configOpen = true } : nil,
        onSend: { text, images in model.sendMessage(text: text, images: images) },
        onAbort: { if let id = model.activeId { model.send(.abort(sessionId: id)) } }
      )
    }
    .padding(.horizontal, 16)
    .padding(.top, 4)
    .background(palette.background)
  }
}

/// 顶栏图标按钮：PWA h-9 w-9 rounded-md text-muted-foreground hover:bg-accent
struct HeaderIconButton: View {
  @Environment(\.ensoPalette) var palette
  let icon: String
  let label: String
  var action: () -> Void

  var body: some View {
    Button(action: action) {
      Image(systemName: icon)
        .font(.system(size: 17))
        .foregroundStyle(palette.mutedForeground)
        .frame(width: 36, height: 36)
        .contentShape(RoundedRectangle(cornerRadius: EnsoRadius.md))
    }
    .buttonStyle(EnsoHoverButtonStyle())
    .accessibilityLabel(label)
  }
}

/// hover:bg-accent hover:text-foreground 的按压反馈
struct EnsoHoverButtonStyle: ButtonStyle {
  @Environment(\.ensoPalette) var palette
  func makeBody(configuration: Configuration) -> some View {
    configuration.label
      .background(configuration.isPressed ? palette.accent : Color.clear)
      .clipShape(RoundedRectangle(cornerRadius: EnsoRadius.md))
      .animation(.easeOut(duration: 0.12), value: configuration.isPressed)
  }
}

/// TG 式状态横幅：progress = 琥珀色连接/同步中，ok = 短暂绿色「已是最新」
struct StateBanner: View {
  @Environment(\.ensoPalette) var palette
  let label: String
  let tone: String

  var body: some View {
    HStack(spacing: 6) {
      if tone == "progress" {
        ProgressView().controlSize(.mini).tint(toneColor)
      }
      Text(label)
    }
    .font(.system(size: EnsoFont.sm))
    .foregroundStyle(toneColor)
    .frame(maxWidth: .infinity)
    .padding(.vertical, 4)
    .background(toneColor.opacity(0.1))
  }

  private var toneColor: Color {
    tone == "ok" ? palette.success : palette.warning
  }
}

/// running 状态点的脉冲动画（PWA animate-pulse）
struct PulseModifier: ViewModifier {
  let active: Bool
  @State private var on = false
  func body(content: Content) -> some View {
    content
      .opacity(active ? (on ? 1 : 0.4) : 1)
      .animation(active ? .easeInOut(duration: 0.8).repeatForever(autoreverses: true) : .default, value: on)
      .onAppear { if active { on = true } }
      .onChange(of: active) { _, next in on = next }
  }
}

// PWA RetryBar: rounded-lg border border-amber-500/40 bg-amber-500/10 px-2.5 py-1.5 text-xs
struct RetryBanner: View {
  @Environment(\.ensoPalette) var palette
  let retry: RetryInfo

  var body: some View {
    let remain = max(0, Int((Double(retry.at + Int64(retry.delayMs)) - Date().timeIntervalSince1970 * 1000) / 1000))
    HStack(spacing: 8) {
      Image(systemName: "arrow.clockwise")
        .font(.system(size: 13))
        .foregroundStyle(palette.warning)
      HStack(spacing: 0) {
        Text("自动重试中（\(retry.attempt)/\(retry.maxAttempts)）")
        Text(" · \(remain) 秒后重试 — \(retry.error)")
          .foregroundStyle(palette.mutedForeground)
      }
      .lineLimit(1)
      Spacer(minLength: 0)
    }
    .font(.system(size: EnsoFont.sm))
    .padding(.horizontal, 10)
    .padding(.vertical, 6)
    .background(palette.warning.opacity(0.1))
    .overlay(RoundedRectangle(cornerRadius: EnsoRadius.lg).stroke(palette.warning.opacity(0.4), lineWidth: 1))
    .clipShape(RoundedRectangle(cornerRadius: EnsoRadius.lg))
  }
}

// PWA MessageQueue: 虚线卡片 + 悬停操作（手机改为常显小图标行）
struct MessageQueueView: View {
  @EnvironmentObject var model: AppModel
  @Environment(\.ensoPalette) var palette
  let sessionId: String
  let queued: [QueuedMessage]
  @State private var editing: String?
  @State private var draft = ""

  var body: some View {
    VStack(spacing: 2) {
      ForEach(queued) { item in
        HStack(spacing: 8) {
          Text("排队中")
            .font(.system(size: 10, weight: .medium))
            .foregroundStyle(palette.mutedForeground)
            .textCase(.uppercase)
          if editing == item.id {
            TextField("编辑", text: $draft)
              .font(.system(size: EnsoFont.sm))
              .textFieldStyle(.plain)
            Button {
              model.send(.queueUpdate(sessionId: sessionId, messageId: item.id, text: draft))
              editing = nil
            } label: {
              Image(systemName: "checkmark").font(.system(size: 13)).foregroundStyle(palette.mutedForeground)
            }
          } else {
            Text(item.hasImages && item.text.isEmpty ? "[image]" : item.text)
              .font(.system(size: EnsoFont.sm))
              .lineLimit(1)
              .frame(maxWidth: .infinity, alignment: .leading)
            queueAction("pencil", "编辑") { editing = item.id; draft = item.text }
            queueAction("paperplane", "立即发送") { model.send(.queueSendNow(sessionId: sessionId, messageId: item.id)) }
            queueAction("square.and.arrow.up", "打断并发送") { model.send(.queueInterruptSend(sessionId: sessionId, messageId: item.id)) }
            queueAction("xmark", "移除", destructive: true) { model.send(.queueRemove(sessionId: sessionId, messageId: item.id)) }
          }
        }
        .padding(.horizontal, 10)
        .padding(.vertical, 6)
        .background(palette.muted.opacity(0.2))
        .overlay(RoundedRectangle(cornerRadius: EnsoRadius.lg).stroke(style: StrokeStyle(lineWidth: 1, dash: [4])).foregroundStyle(palette.border))
        .clipShape(RoundedRectangle(cornerRadius: EnsoRadius.lg))
      }
    }
  }

  private func queueAction(_ icon: String, _ label: String, destructive: Bool = false, action: @escaping () -> Void) -> some View {
    Button(action: action) {
      Image(systemName: icon)
        .font(.system(size: 12))
        .foregroundStyle(destructive ? palette.destructive : palette.mutedForeground)
        .frame(width: 22, height: 22)
    }
    .buttonStyle(.plain)
    .accessibilityLabel(label)
  }
}

// PWA TaskBar: rounded-lg border border-border/60 bg-muted/20，状态圆点 + 等宽命令 + 元信息
struct TaskCapsules: View {
  @Environment(\.ensoPalette) var palette
  let sessionId: String
  let tasks: [BackgroundTaskInfo]
  let subagents: [SubagentInfo]
  @State private var dismissed: Set<String> = []

  var body: some View {
    let visTasks = tasks.filter { !dismissed.contains($0.taskId) }
    let visAgents = subagents.filter { !dismissed.contains($0.id) }
    if !visTasks.isEmpty || !visAgents.isEmpty {
      VStack(spacing: 2) {
        ForEach(visTasks) { t in
          HStack(spacing: 8) {
            Circle()
              .fill(dotColor(t.status))
              .frame(width: 6, height: 6)
              .modifier(PulseModifier(active: t.status == "running"))
            Text(t.command)
              .font(EnsoFont.mono(EnsoFont.sm))
              .foregroundStyle(palette.mutedForeground)
              .lineLimit(1)
              .frame(maxWidth: .infinity, alignment: .leading)
            if t.status == "running" {
              Text(elapsed(t.startedAt))
                .font(EnsoFont.mono(10))
                .foregroundStyle(palette.mutedForeground)
            } else if let code = t.exitCode {
              Text("exit \(code)")
                .font(EnsoFont.mono(10))
                .foregroundStyle(palette.mutedForeground)
            }
            if t.status != "running" {
              Button { dismissed.insert(t.taskId) } label: {
                Image(systemName: "xmark").font(.system(size: 11)).foregroundStyle(palette.mutedForeground)
              }
              .buttonStyle(.plain)
            }
          }
          .padding(.horizontal, 10)
          .padding(.vertical, 6)
          .background(palette.muted.opacity(0.2))
          .overlay(RoundedRectangle(cornerRadius: EnsoRadius.lg).stroke(palette.border.opacity(0.6), lineWidth: 1))
          .clipShape(RoundedRectangle(cornerRadius: EnsoRadius.lg))
        }
        ForEach(visAgents) { s in
          HStack(spacing: 8) {
            Circle()
              .fill(dotColor(s.status))
              .frame(width: 6, height: 6)
              .modifier(PulseModifier(active: s.status == "running"))
            Image(systemName: "cpu")
              .font(.system(size: 13))
              .foregroundStyle(palette.mutedForeground)
            Text(s.description)
              .font(.system(size: EnsoFont.sm))
              .foregroundStyle(palette.mutedForeground)
              .lineLimit(1)
              .frame(maxWidth: .infinity, alignment: .leading)
            if s.steps > 0 {
              Text("\(s.steps) 步")
                .font(EnsoFont.mono(10))
                .foregroundStyle(palette.mutedForeground)
            }
            if s.status != "running" {
              Button { dismissed.insert(s.id) } label: {
                Image(systemName: "xmark").font(.system(size: 11)).foregroundStyle(palette.mutedForeground)
              }
              .buttonStyle(.plain)
            }
          }
          .padding(.horizontal, 10)
          .padding(.vertical, 6)
          .background(palette.muted.opacity(0.2))
          .overlay(RoundedRectangle(cornerRadius: EnsoRadius.lg).stroke(palette.border.opacity(0.6), lineWidth: 1))
          .clipShape(RoundedRectangle(cornerRadius: EnsoRadius.lg))
        }
      }
      .onChange(of: finishedIds) { _, ids in
        guard !ids.isEmpty else { return }
        DispatchQueue.main.asyncAfter(deadline: .now() + 5) {
          dismissed.formUnion(ids)
        }
      }
      .onChange(of: sessionId) { _, _ in dismissed = [] }
    }
  }

  private func dotColor(_ status: String) -> Color {
    switch status {
    case "running": return palette.success
    case "failed": return palette.destructive
    default: return palette.info
    }
  }

  private func elapsed(_ startedAt: Int64) -> String {
    let now = Int64(Date().timeIntervalSince1970 * 1000)
    let s = max(0, Int(now - startedAt) / 1000)
    return "\(s)s"
  }

  private var finishedIds: Set<String> {
    Set(tasks.filter { $0.status != "running" }.map(\.taskId))
      .union(subagents.filter { $0.status != "running" }.map(\.id))
      .subtracting(dismissed)
  }
}

// PWA ApprovalBar: rounded-lg border border-border/60 bg-muted/20 px-2.5 py-2
struct ApprovalBar: View {
  @Environment(\.ensoPalette) var palette
  let approvals: [ApprovalRequestInfo]
  var onRespond: (String, ApprovalDecision) -> Void

  var body: some View {
    if let item = approvals.first {
      VStack(alignment: .leading, spacing: 6) {
        HStack(spacing: 8) {
          Image(systemName: "exclamationmark.shield.fill")
            .font(.system(size: 13))
            .foregroundStyle(palette.warning)
          Text(item.reviewing ? "助手代审中…" : "审批需确认")
            .font(.system(size: 10, weight: .medium))
            .textCase(.uppercase)
            .tracking(0.5)
            .foregroundStyle(palette.mutedForeground)
          if !item.tool.isEmpty {
            Text(item.tool)
              .font(EnsoFont.mono(EnsoFont.sm))
              .foregroundStyle(palette.mutedForeground)
              .lineLimit(1)
          }
          Spacer(minLength: 0)
          if approvals.count > 1 {
            Text("1/\(approvals.count)")
              .font(.system(size: 10))
              .foregroundStyle(palette.mutedForeground)
          }
        }
        if !item.summary.isEmpty {
          Text(item.summary)
            .font(EnsoFont.mono(EnsoFont.sm))
            .frame(maxWidth: .infinity, maxHeight: 96, alignment: .topLeading)
            .padding(.horizontal, 8)
            .padding(.vertical, 6)
            .background(palette.muted.opacity(0.5))
            .clipShape(RoundedRectangle(cornerRadius: EnsoRadius.md))
        }
        if !item.reviewing {
          HStack {
            Button("拒绝") { onRespond(item.requestId, .deny) }
              .foregroundStyle(palette.destructive)
            Spacer()
            Button("本会话始终允许") { onRespond(item.requestId, .allowSession) }
              .foregroundStyle(palette.mutedForeground)
            Button("允许") { onRespond(item.requestId, .allow) }
              .padding(.horizontal, 10)
              .padding(.vertical, 4)
              .background(palette.primary)
              .foregroundStyle(palette.primaryForeground)
              .clipShape(RoundedRectangle(cornerRadius: EnsoRadius.md))
          }
          .font(.system(size: EnsoFont.sm))
        }
      }
      .padding(.horizontal, 10)
      .padding(.vertical, 8)
      .background(palette.muted.opacity(0.2))
      .overlay(RoundedRectangle(cornerRadius: EnsoRadius.lg).stroke(palette.border.opacity(0.6), lineWidth: 1))
      .clipShape(RoundedRectangle(cornerRadius: EnsoRadius.lg))
    }
  }
}

// PWA AskBar: 同款容器 + 蓝色问号图标 + 选项按钮 + 输入行
struct AskBar: View {
  @Environment(\.ensoPalette) var palette
  let asks: [AskRequestInfo]
  var onAnswer: (String, String) -> Void
  @State private var text = ""

  var body: some View {
    if let ask = asks.first {
      VStack(alignment: .leading, spacing: 8) {
        HStack(alignment: .top, spacing: 8) {
          Image(systemName: "questionmark.bubble.fill")
            .font(.system(size: 13))
            .foregroundStyle(palette.info)
            .padding(.top, 2)
          Text(ask.question)
            .font(.system(size: EnsoFont.sm))
            .lineSpacing(3)
            .frame(maxWidth: .infinity, alignment: .leading)
          if asks.count > 1 {
            Text("1/\(asks.count)")
              .font(.system(size: 10))
              .foregroundStyle(palette.mutedForeground)
          }
        }
        if !ask.options.isEmpty {
          FlowLayout(spacing: 6) {
            ForEach(ask.options, id: \.self) { opt in
              Button(opt) { onAnswer(ask.requestId, opt) }
                .font(.system(size: EnsoFont.sm))
                .foregroundStyle(palette.mutedForeground)
                .padding(.horizontal, 10)
                .padding(.vertical, 4)
                .overlay(RoundedRectangle(cornerRadius: EnsoRadius.md).stroke(palette.border.opacity(0.6), lineWidth: 1))
            }
          }
        }
        HStack(spacing: 6) {
          TextField("输入回答…", text: $text)
            .font(.system(size: EnsoFont.sm))
            .textFieldStyle(.plain)
            .padding(.horizontal, 8)
            .frame(height: 28)
            .overlay(RoundedRectangle(cornerRadius: EnsoRadius.md).stroke(palette.border, lineWidth: 1))
          Button {
            let t = text.trimmingCharacters(in: .whitespacesAndNewlines)
            guard !t.isEmpty else { return }
            onAnswer(ask.requestId, t)
            text = ""
          } label: {
            Image(systemName: "paperplane.fill")
              .font(.system(size: 13))
              .foregroundStyle(palette.mutedForeground)
              .frame(width: 28, height: 28)
          }
          .buttonStyle(.plain)
          .disabled(text.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty)
          .opacity(text.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty ? 0.4 : 1)
        }
      }
      .padding(.horizontal, 10)
      .padding(.vertical, 8)
      .background(palette.muted.opacity(0.2))
      .overlay(RoundedRectangle(cornerRadius: EnsoRadius.lg).stroke(palette.border.opacity(0.6), lineWidth: 1))
      .clipShape(RoundedRectangle(cornerRadius: EnsoRadius.lg))
    }
  }
}

/// 简单流式布局（选项按钮自动换行）
struct FlowLayout: Layout {
  var spacing: CGFloat = 6

  func sizeThatFits(proposal: ProposedViewSize, subviews: Subviews, cache: inout ()) -> CGSize {
    let width = proposal.width ?? .infinity
    var x: CGFloat = 0, y: CGFloat = 0, rowHeight: CGFloat = 0
    for view in subviews {
      let size = view.sizeThatFits(.unspecified)
      if x + size.width > width, x > 0 {
        x = 0
        y += rowHeight + spacing
        rowHeight = 0
      }
      x += size.width + spacing
      rowHeight = max(rowHeight, size.height)
    }
    return CGSize(width: width, height: y + rowHeight)
  }

  func placeSubviews(in bounds: CGRect, proposal: ProposedViewSize, subviews: Subviews, cache: inout ()) {
    var x = bounds.minX, y = bounds.minY, rowHeight: CGFloat = 0
    for view in subviews {
      let size = view.sizeThatFits(.unspecified)
      if x + size.width > bounds.maxX, x > bounds.minX {
        x = bounds.minX
        y += rowHeight + spacing
        rowHeight = 0
      }
      view.place(at: CGPoint(x: x, y: y), proposal: ProposedViewSize(size))
      x += size.width + spacing
      rowHeight = max(rowHeight, size.height)
    }
  }
}

// PWA Composer: rounded-xl border bg-background shadow-sm，聚焦时 border-ring
struct ComposerBar: View {
  @Environment(\.ensoPalette) var palette
  var running: Bool
  var locked: Bool
  var modelLabel: String?
  var onOpenConfig: (() -> Void)?
  var onSend: (String, [AttachedImage]) -> Void
  var onAbort: () -> Void

  @State private var text = ""
  @State private var pickerItem: PhotosPickerItem?
  @State private var images: [AttachedImage] = []
  @State private var imageError: String?
  @FocusState private var focused: Bool

  var body: some View {
    VStack(alignment: .leading, spacing: 0) {
      if let imageError {
        Text(imageError)
          .font(.system(size: EnsoFont.xs))
          .foregroundStyle(palette.destructive)
          .padding(.horizontal, 12)
          .padding(.top, 8)
      }
      // 图片预览：PWA h-16 w-16 rounded-md border object-cover + 删除小圆钮
      if !images.isEmpty {
        ScrollView(.horizontal, showsIndicators: false) {
          HStack(spacing: 8) {
            ForEach(Array(images.enumerated()), id: \.offset) { i, img in
              if let data = Data(base64Encoded: img.data), let ui = UIImage(data: data) {
                ZStack(alignment: .topTrailing) {
                  Image(uiImage: ui)
                    .resizable()
                    .scaledToFill()
                    .frame(width: 64, height: 64)
                    .clipShape(RoundedRectangle(cornerRadius: EnsoRadius.md))
                    .overlay(RoundedRectangle(cornerRadius: EnsoRadius.md).stroke(palette.border, lineWidth: 1))
                  Button { images.remove(at: i) } label: {
                    Image(systemName: "xmark")
                      .font(.system(size: 9, weight: .bold))
                      .foregroundStyle(palette.mutedForeground)
                      .frame(width: 18, height: 18)
                      .background(palette.background)
                      .clipShape(Circle())
                      .overlay(Circle().stroke(palette.border, lineWidth: 1))
                  }
                  .offset(x: 6, y: -6)
                }
              }
            }
          }
          .padding(.horizontal, 12)
          .padding(.top, 12)
        }
      }
      // 输入区：PWA px-3.5 pt-3，min-h-10，text-sm
      TextField(placeholder, text: $text, axis: .vertical)
        .lineLimit(1...6)
        .font(.system(size: EnsoFont.base))
        .disabled(locked)
        .focused($focused)
        .padding(.horizontal, 14)
        .padding(.top, images.isEmpty ? 12 : 6)
        .frame(minHeight: 40, alignment: .top)
      // 工具栏：PWA flex justify-between px-1.5 pb-1
      HStack(spacing: 4) {
        if let modelLabel, let onOpenConfig {
          Button(action: onOpenConfig) {
            HStack(spacing: 2) {
              Text(modelLabel).lineLimit(1)
              Image(systemName: "chevron.down").font(.system(size: 9, weight: .semibold))
            }
            .font(.system(size: EnsoFont.xs))
            .foregroundStyle(palette.mutedForeground)
            .padding(.horizontal, 6)
            .padding(.vertical, 4)
            .contentShape(RoundedRectangle(cornerRadius: EnsoRadius.md))
          }
          .buttonStyle(EnsoHoverButtonStyle())
        }
        PhotosPicker(selection: $pickerItem, matching: .images) {
          Image(systemName: "photo")
            .font(.system(size: 15))
            .foregroundStyle(palette.mutedForeground)
            .frame(width: 28, height: 28)
            .contentShape(RoundedRectangle(cornerRadius: EnsoRadius.md))
        }
        .buttonStyle(EnsoHoverButtonStyle())
        .onChange(of: pickerItem) { _, item in
          guard let item else { return }
          Task {
            if let data = try? await item.loadTransferable(type: Data.self), let ui = UIImage(data: data) {
              do {
                images.append(try ImageCompress.compress(ui))
                imageError = nil
              } catch {
                imageError = error.localizedDescription
              }
            }
            pickerItem = nil
          }
        }
        Spacer(minLength: 0)
        // 发送/停止：PWA h-7 w-7 rounded-lg；发送 bg-primary，停止 outline
        Button(action: tap) {
          Image(systemName: showStop ? "stop" : "arrow.up")
            .font(.system(size: 14, weight: .semibold))
            .frame(width: 28, height: 28)
            .foregroundStyle(showStop ? palette.destructive : (canSend ? palette.primaryForeground : palette.mutedForeground))
            .background(showStop ? Color.clear : (canSend ? palette.primary : Color.clear))
            .clipShape(RoundedRectangle(cornerRadius: EnsoRadius.lg))
            .overlay(
              RoundedRectangle(cornerRadius: EnsoRadius.lg)
                .stroke(showStop ? palette.border : Color.clear, lineWidth: 1)
            )
        }
        .disabled(!showStop && !canSend)
      }
      .padding(.horizontal, 6)
      .padding(.bottom, 4)
    }
    .background(palette.background)
    .overlay(
      RoundedRectangle(cornerRadius: EnsoRadius.xl)
        .stroke(focused ? palette.ring : palette.border, lineWidth: 1)
    )
    .clipShape(RoundedRectangle(cornerRadius: EnsoRadius.xl))
    .shadow(color: Color.black.opacity(palette.isDark ? 0.2 : 0.05), radius: 2, y: 1)
    .padding(.bottom, 4)
  }

  private var placeholder: String {
    if locked { return "解决待决审批以继续" }
    if running { return "消息将排队，等待本轮结束…" }
    return "输入消息…"
  }

  private var showStop: Bool { running && text.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty && images.isEmpty }
  private var canSend: Bool { !locked && (!text.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty || !images.isEmpty) }

  private func tap() {
    if showStop { onAbort(); return }
    let t = text.trimmingCharacters(in: .whitespacesAndNewlines)
    guard !t.isEmpty || !images.isEmpty else { return }
    onSend(t, images)
    text = ""
    images = []
  }
}
