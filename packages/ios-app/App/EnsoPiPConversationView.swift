import EnsoCore
import SwiftUI

/// 画中画窗口的数据源：前端推送的快照在这里统一清洗后再驱动 SwiftUI 刷新。
@MainActor
final class EnsoPiPViewModel: ObservableObject {
    @Published private(set) var snapshot: EnsoPiPSnapshot = .placeholder

    func apply(_ next: EnsoPiPSnapshot) {
        let display = next.sanitizedForDisplay()
        if display != snapshot {
            snapshot = display
        }
    }
}

/// 与 EnsoCode 对话区对齐的明暗双色板。
private struct PiPTheme {
    let isLight: Bool
    let surface: Color
    let surfaceRaised: Color
    let codeBg: Color
    let cardBg: Color
    let border: Color
    let text: Color
    let muted: Color
    let userBubbleBg: Color
    let userBubbleBorder: Color
    let running: Color
    let pending: Color
    let idle: Color
    let failed: Color
    let offline: Color

    static let dark = PiPTheme(
        isLight: false,
        surface: Color(red: 0.08, green: 0.085, blue: 0.10),
        surfaceRaised: Color(red: 0.115, green: 0.12, blue: 0.145),
        codeBg: Color(red: 0.13, green: 0.14, blue: 0.175),
        cardBg: Color.white.opacity(0.055),
        border: Color.white.opacity(0.10),
        text: Color.white.opacity(0.93),
        muted: Color.white.opacity(0.56),
        userBubbleBg: Color(red: 0.39, green: 0.40, blue: 0.95).opacity(0.24),
        userBubbleBorder: Color(red: 0.49, green: 0.51, blue: 0.98).opacity(0.35),
        running: Color(red: 0.44, green: 0.46, blue: 0.98),
        pending: Color(red: 0.98, green: 0.68, blue: 0.14),
        idle: Color(red: 0.16, green: 0.78, blue: 0.56),
        failed: Color(red: 0.96, green: 0.38, blue: 0.36),
        offline: Color.white.opacity(0.42)
    )

    static let light = PiPTheme(
        isLight: true,
        surface: Color(red: 0.985, green: 0.986, blue: 0.992),
        surfaceRaised: Color(red: 0.95, green: 0.955, blue: 0.97),
        codeBg: Color(red: 0.93, green: 0.94, blue: 0.96),
        cardBg: Color.black.opacity(0.04),
        border: Color.black.opacity(0.09),
        text: Color(red: 0.10, green: 0.11, blue: 0.14),
        muted: Color(red: 0.42, green: 0.44, blue: 0.50),
        userBubbleBg: Color(red: 0.36, green: 0.38, blue: 0.92).opacity(0.13),
        userBubbleBorder: Color(red: 0.36, green: 0.38, blue: 0.92).opacity(0.24),
        running: Color(red: 0.35, green: 0.37, blue: 0.90),
        pending: Color(red: 0.85, green: 0.49, blue: 0.02),
        idle: Color(red: 0.05, green: 0.62, blue: 0.42),
        failed: Color(red: 0.85, green: 0.22, blue: 0.22),
        offline: Color.black.opacity(0.38)
    )

    static func resolve(_ name: String?) -> PiPTheme {
        name == "light" ? .light : .dark
    }
}

/// 会话状态到画中画展示（文案 / 颜色 / 圆相角标）的映射表。
private struct PiPStatusStyle {
    let label: String
    let color: Color
    let badge: EnsoMarkBadge

    init(status: String, theme: PiPTheme) {
        switch status {
        case "running": self.init("运行中", theme.running, .none)
        case "pending": self.init("待确认", theme.pending, .pending)
        case "failed": self.init("失败", theme.failed, .none)
        case "offline": self.init("离线", theme.offline, .none)
        default: self.init("已完成", theme.idle, .done)
        }
    }

    private init(_ label: String, _ color: Color, _ badge: EnsoMarkBadge) {
        self.label = label
        self.color = color
        self.badge = badge
    }
}

struct EnsoPiPConversationView: View {
    @ObservedObject var model: EnsoPiPViewModel
    var isPaused: Bool = false

    var body: some View {
        let snapshot = model.snapshot
        let theme = PiPTheme.resolve(snapshot.theme)
        let style = PiPStatusStyle(status: snapshot.status, theme: theme)
        VStack(spacing: 0) {
            header(snapshot, style: style, theme: theme)
            Rectangle().fill(theme.border).frame(height: 0.5)
            feed(snapshot, accent: style.color, theme: theme)
            if let todo = snapshot.todo {
                Rectangle().fill(theme.border).frame(height: 0.5)
                todoStrip(todo, theme: theme)
            }
            if let detail = snapshot.pendingDetail {
                Rectangle().fill(theme.pending.opacity(0.32)).frame(height: 0.5)
                pendingCard(detail, theme: theme)
            } else if let hint = snapshot.pendingHint {
                Rectangle().fill(theme.pending.opacity(0.28)).frame(height: 0.5)
                pendingBanner(hint, theme: theme)
            }
        }
        .background(theme.surface)
        .environment(\.colorScheme, theme.isLight ? .light : .dark)
    }

    private func header(_ snapshot: EnsoPiPSnapshot, style: PiPStatusStyle, theme: PiPTheme) -> some View {
        HStack(spacing: 7) {
            EnsoMarkView(size: 17, color: style.color, badge: style.badge)
            VStack(alignment: .leading, spacing: 1) {
                Text(snapshot.title)
                    .font(.system(size: 11.5, weight: .semibold))
                    .foregroundColor(theme.text)
                    .lineLimit(1)
                let sub = [snapshot.projectName, snapshot.meta ?? ""]
                    .filter { !$0.isEmpty }
                    .joined(separator: " · ")
                if !sub.isEmpty {
                    Text(sub)
                        .font(.system(size: 9, weight: .medium))
                        .foregroundColor(theme.muted)
                        .lineLimit(1)
                }
            }
            Spacer(minLength: 4)
            HStack(spacing: 4) {
                if snapshot.runningCount > 1 {
                    Text("\(snapshot.runningCount) 并行")
                        .font(.system(size: 8.5, weight: .semibold))
                        .foregroundColor(theme.muted)
                        .padding(.horizontal, 5)
                        .padding(.vertical, 2)
                        .background(Capsule().fill(theme.cardBg))
                }
                HStack(spacing: 3.5) {
                    if snapshot.status == "running" {
                        PiPStreamingDot(color: style.color)
                    }
                    Text(style.label)
                        .font(.system(size: 9, weight: .semibold))
                        .foregroundColor(style.color)
                }
                .padding(.horizontal, 6)
                .padding(.vertical, 2)
                .background(Capsule().fill(style.color.opacity(0.16)))
                if isPaused {
                    Text("已暂停")
                        .font(.system(size: 8.5, weight: .semibold))
                        .foregroundColor(theme.pending)
                        .padding(.horizontal, 5)
                        .padding(.vertical, 2)
                        .background(Capsule().fill(theme.pending.opacity(0.16)))
                }
            }
        }
        .padding(.horizontal, 10)
        .padding(.vertical, 7)
        .background(theme.surfaceRaised)
    }

    /// 用底部锚定 + 顶部裁切代替 `ScrollView`，确保 `ImageRenderer` 单次离屏渲染时
    /// 最新消息始终贴底可见，超出可视高度的早期消息自然从顶部裁出。
    private func feed(_ snapshot: EnsoPiPSnapshot, accent: Color, theme: PiPTheme) -> some View {
        Color.clear
            .frame(maxWidth: .infinity, maxHeight: .infinity)
            .overlay(alignment: snapshot.messages.isEmpty ? .center : .bottomLeading) {
                if snapshot.messages.isEmpty {
                    emptyState(snapshot, theme: theme)
                } else {
                    LazyVStack(alignment: .leading, spacing: 7) {
                        ForEach(snapshot.messages) { message in
                            PiPMessageRow(
                                message: message,
                                isLatest: message.id == snapshot.messages.last?.id,
                                accent: accent,
                                theme: theme
                            )
                        }
                    }
                    .padding(.horizontal, 10)
                    .padding(.top, 8)
                    .padding(.bottom, 6)
                    .fixedSize(horizontal: false, vertical: true)
                    .frame(maxWidth: .infinity, alignment: .leading)
                }
            }
            .clipped()
    }

    private func emptyState(_ snapshot: EnsoPiPSnapshot, theme: PiPTheme) -> some View {
        VStack(spacing: 6) {
            EnsoMarkView(size: 28, color: theme.muted.opacity(0.55))
            Text("等待对话输出…")
                .font(.system(size: 11, weight: .medium))
                .foregroundColor(theme.muted)
            if let hint = connectionHint(snapshot.connectionState) {
                Text(hint)
                    .font(.system(size: 9.5))
                    .foregroundColor(theme.muted.opacity(0.8))
            }
        }
        .frame(maxWidth: .infinity)
        .padding(.horizontal, 12)
    }

    private func connectionHint(_ state: String) -> String? {
        switch state {
        case "online": return nil
        case "connecting": return "正在连接桌面端…"
        case "host-offline": return "桌面端离线"
        default: return "未连接桌面端，返回 EnsoCode 重新连接"
        }
    }

    /// 底部固定待办进度条（对齐桌面 `TodoBar`）。
    private func todoStrip(_ todo: EnsoPiPTodoSummary, theme: PiPTheme) -> some View {
        let ratio = todo.total > 0 ? CGFloat(todo.done) / CGFloat(todo.total) : 0
        return VStack(alignment: .leading, spacing: 3) {
            HStack(spacing: 5) {
                Image(systemName: "checklist")
                    .font(.system(size: 9, weight: .semibold))
                    .foregroundColor(theme.running)
                Text("\(todo.done)/\(todo.total)")
                    .font(.system(size: 9.5, weight: .semibold, design: .monospaced))
                    .foregroundColor(theme.text)
                if let current = todo.current, !current.isEmpty {
                    Text(current)
                        .font(.system(size: 9.5))
                        .foregroundColor(theme.muted)
                        .lineLimit(1)
                }
                Spacer(minLength: 0)
            }
            GeometryReader { geo in
                ZStack(alignment: .leading) {
                    Capsule().fill(theme.border)
                    Capsule()
                        .fill(theme.running)
                        .frame(width: max(4, geo.size.width * ratio))
                }
            }
            .frame(height: 2.5)
        }
        .padding(.horizontal, 10)
        .padding(.vertical, 5)
        .background(theme.surfaceRaised)
    }

    /// 底部审批 / 提问详情卡（对齐桌面 `ApprovalBar` / `AskBar`）。
    private func pendingCard(_ detail: EnsoPiPPendingDetail, theme: PiPTheme) -> some View {
        VStack(alignment: .leading, spacing: 3) {
            HStack(spacing: 5) {
                Image(systemName: detail.kind == "ask" ? "questionmark.circle.fill" : "exclamationmark.shield.fill")
                    .font(.system(size: 10, weight: .semibold))
                    .foregroundColor(theme.pending)
                Text(detail.title)
                    .font(.system(size: 10, weight: .semibold))
                    .foregroundColor(theme.pending)
                    .lineLimit(1)
                Spacer(minLength: 4)
                Text("点返回处理")
                    .font(.system(size: 9, weight: .semibold))
                    .foregroundColor(theme.pending)
                    .padding(.horizontal, 5)
                    .padding(.vertical, 1.5)
                    .background(Capsule().fill(theme.pending.opacity(0.18)))
                    .fixedSize()
            }
            if let summary = detail.summary, !summary.isEmpty {
                Text(summary)
                    .font(.system(size: 9.5, design: detail.kind == "approval" ? .monospaced : .default))
                    .foregroundColor(theme.text.opacity(0.88))
                    .lineLimit(2)
                    .frame(maxWidth: .infinity, alignment: .leading)
            }
        }
        .padding(.horizontal, 10)
        .padding(.vertical, 6)
        .background(theme.pending.opacity(theme.isLight ? 0.12 : 0.16))
    }

    private func pendingBanner(_ hint: String, theme: PiPTheme) -> some View {
        HStack(spacing: 6) {
            Circle()
                .fill(theme.pending)
                .frame(width: 6, height: 6)
            Text("待确认 · \(hint)")
                .font(.system(size: 10, weight: .semibold))
                .foregroundColor(theme.pending)
                .lineLimit(1)
            Spacer(minLength: 4)
            Text("点返回处理")
                .font(.system(size: 9, weight: .medium))
                .foregroundColor(theme.pending.opacity(0.85))
                .lineLimit(1)
                .fixedSize()
        }
        .padding(.horizontal, 10)
        .padding(.vertical, 5)
        .background(theme.pending.opacity(0.14))
    }
}

private struct PiPMessageRow: View {
    let message: EnsoPiPMessage
    let isLatest: Bool
    let accent: Color
    let theme: PiPTheme

    var body: some View {
        switch message.role {
        case "user":
            userBubble
        case "thinking":
            thinkingRow
        case "tool-group":
            PiPToolGroupCard(message: message, theme: theme)
        case "tool":
            PiPToolRow(message: message, theme: theme)
        case "system":
            systemBanner
        default:
            assistantText
        }
    }

    private var userBubble: some View {
        HStack {
            Spacer(minLength: 28)
            Text(message.text)
                .font(.system(size: 11))
                .foregroundColor(theme.text)
                .lineLimit(4)
                .fixedSize(horizontal: false, vertical: true)
                .padding(.horizontal, 9)
                .padding(.vertical, 5)
                .background(
                    RoundedRectangle(cornerRadius: 11, style: .continuous)
                        .fill(theme.userBubbleBg)
                        .overlay(
                            RoundedRectangle(cornerRadius: 11, style: .continuous)
                                .stroke(theme.userBubbleBorder, lineWidth: 0.5)
                        )
                )
        }
    }

    /// 思考过程行（对齐桌面折叠风格：已完成收成一行「思考了 Xs」，流式时才展示尾部 3 行预览）。
    private var thinkingRow: some View {
        Group {
            if message.isStreaming {
                HStack(alignment: .top, spacing: 5) {
                    Image(systemName: "brain")
                        .font(.system(size: 9.5, weight: .medium))
                        .foregroundColor(accent)
                        .padding(.top, 1.5)
                    VStack(alignment: .leading, spacing: 2) {
                        HStack(spacing: 4) {
                            Text("思考中")
                                .font(.system(size: 9.5, weight: .medium))
                                .foregroundColor(accent)
                            PiPStreamingDot(color: accent)
                        }
                        if !message.text.isEmpty && message.text != "思考中…" {
                            Text(message.text)
                                .font(.system(size: 9.5))
                                .foregroundColor(theme.muted)
                                .lineLimit(3)
                                .fixedSize(horizontal: false, vertical: true)
                        }
                    }
                }
                .padding(.leading, 6)
                .overlay(alignment: .leading) {
                    Rectangle()
                        .fill(accent.opacity(0.38))
                        .frame(width: 1.5)
                }
                .frame(maxWidth: .infinity, alignment: .leading)
            } else {
                HStack(spacing: 4) {
                    Image(systemName: "chevron.right")
                        .font(.system(size: 8, weight: .semibold))
                        .foregroundColor(theme.muted.opacity(0.65))
                    Text(message.text.isEmpty ? "思考过程" : message.text)
                        .font(.system(size: 9.5, weight: .medium))
                        .foregroundColor(theme.muted)
                        .lineLimit(1)
                    Spacer(minLength: 0)
                }
                .padding(.vertical, 1)
            }
        }
    }

    private var systemBanner: some View {
        HStack(alignment: .top, spacing: 5) {
            Image(systemName: message.isError ? "exclamationmark.triangle.fill" : "info.circle")
                .font(.system(size: 9.5))
                .foregroundColor(message.isError ? theme.failed : theme.muted)
                .padding(.top, 1.5)
            Text(message.text)
                .font(.system(size: 10))
                .foregroundColor(message.isError ? theme.failed : theme.muted)
                .lineLimit(3)
                .fixedSize(horizontal: false, vertical: true)
        }
        .padding(.horizontal, 7)
        .padding(.vertical, 4)
        .frame(maxWidth: .infinity, alignment: .leading)
        .background(
            RoundedRectangle(cornerRadius: 6, style: .continuous)
                .fill((message.isError ? theme.failed : theme.muted).opacity(0.12))
        )
    }

    /// 助手正文：按 Markdown 块拆分为普通段落（支持加粗/行内代码/列表）与围栏代码块，对齐对话区可读性。
    private var assistantText: some View {
        let blocks = PiPMarkdownBlock.parse(message.text)
        return VStack(alignment: .leading, spacing: 4) {
            ForEach(Array(blocks.enumerated()), id: \.offset) { idx, block in
                let isTailBlock = idx == blocks.count - 1
                switch block {
                case .paragraph(let content):
                    HStack(alignment: .lastTextBaseline, spacing: 4) {
                        PiPMarkdownParagraph(
                            text: content,
                            fontSize: 11.5,
                            color: theme.text,
                            lineLimit: isLatest || message.isStreaming ? 18 : 7
                        )
                        if isTailBlock && message.isStreaming {
                            PiPStreamingDot(color: accent)
                        }
                    }
                case .code(let lang, let code):
                    VStack(alignment: .leading, spacing: 2) {
                        if !lang.isEmpty {
                            Text(lang)
                                .font(.system(size: 8.5, weight: .semibold, design: .monospaced))
                                .foregroundColor(theme.muted)
                        }
                        Text(code)
                            .font(.system(size: 9.5, design: .monospaced))
                            .foregroundColor(theme.text.opacity(0.9))
                            .lineLimit(isLatest || message.isStreaming ? 10 : 5)
                            .fixedSize(horizontal: false, vertical: true)
                    }
                    .padding(.horizontal, 7)
                    .padding(.vertical, 5)
                    .frame(maxWidth: .infinity, alignment: .leading)
                    .background(
                        RoundedRectangle(cornerRadius: 6, style: .continuous)
                            .fill(theme.codeBg)
                            .overlay(
                                RoundedRectangle(cornerRadius: 6, style: .continuous)
                                    .stroke(theme.border, lineWidth: 0.5)
                            )
                    )
                }
            }
            if blocks.isEmpty && message.isStreaming {
                PiPStreamingDot(color: accent)
            }
        }
        .frame(maxWidth: .infinity, alignment: .leading)
    }
}

/// 单条工具行（对齐桌面 `StepDot + 工具标签 + 参数摘要 + 报错一行预览`）。
private struct PiPToolRow: View {
    let message: EnsoPiPMessage
    let theme: PiPTheme

    var body: some View {
        let state = message.toolState ?? (message.isError ? "error" : (message.isStreaming ? "running" : "ok"))
        let isErr = state == "error" || message.isError
        VStack(alignment: .leading, spacing: 2) {
            HStack(spacing: 5) {
                PiPStepDot(state: state, theme: theme)
                if let name = message.toolName, !name.isEmpty {
                    Text(name)
                        .font(.system(size: 10, weight: .semibold))
                        .foregroundColor(isErr ? theme.failed : theme.text.opacity(0.82))
                        .lineLimit(1)
                        .fixedSize()
                }
                if !message.text.isEmpty {
                    Text(message.text)
                        .font(.system(size: 9.5, design: .monospaced))
                        .foregroundColor(isErr ? theme.failed.opacity(0.9) : theme.muted)
                        .lineLimit(1)
                        .truncationMode(.tail)
                }
                Spacer(minLength: 0)
            }
            if let detail = message.detail, !detail.isEmpty {
                Text(detail)
                    .font(.system(size: 9, design: .monospaced))
                    .foregroundColor(isErr ? theme.failed.opacity(0.9) : theme.muted)
                    .lineLimit(2)
                    .padding(.leading, 12)
            }
        }
        .padding(.horizontal, 7)
        .padding(.vertical, 4)
        .background(
            RoundedRectangle(cornerRadius: 6, style: .continuous)
                .fill(isErr ? theme.failed.opacity(0.13) : theme.cardBg)
        )
    }
}

/// 折叠过程组（对齐桌面「已工作 XmYs」紧凑收起行：无 steps 时只显示轻量标题与一行摘要；
/// 仅当显式传入 steps 时再展开子步）。
private struct PiPToolGroupCard: View {
    let message: EnsoPiPMessage
    let theme: PiPTheme

    var body: some View {
        let state = message.toolState ?? (message.isError ? "error" : (message.isStreaming ? "running" : "ok"))
        let isErr = state == "error" || message.isError
        let steps = message.steps ?? []
        let total = message.stepCount ?? steps.count
        if steps.isEmpty && !isErr {
            // 桌面同款收起态：「› 已工作 1m48s」+ 一行淡色摘要，不占大卡片空间
            VStack(alignment: .leading, spacing: 1.5) {
                HStack(spacing: 4) {
                    Image(systemName: "chevron.right")
                        .font(.system(size: 8, weight: .semibold))
                        .foregroundColor(theme.muted.opacity(0.65))
                    Text(message.text)
                        .font(.system(size: 9.5, weight: .medium))
                        .foregroundColor(theme.muted)
                        .lineLimit(1)
                    Spacer(minLength: 4)
                    if total > 1 {
                        Text("\(total) 步")
                            .font(.system(size: 8.5, design: .monospaced))
                            .foregroundColor(theme.muted.opacity(0.7))
                    }
                }
                if let detail = message.detail, !detail.isEmpty {
                    Text(detail)
                        .font(.system(size: 9))
                        .foregroundColor(theme.muted.opacity(0.75))
                        .lineLimit(1)
                        .truncationMode(.tail)
                        .padding(.leading, 11)
                }
            }
            .padding(.vertical, 1.5)
            .frame(maxWidth: .infinity, alignment: .leading)
        } else {
            let hidden = max(0, total - steps.count)
            VStack(alignment: .leading, spacing: 3.5) {
                HStack(spacing: 5) {
                    PiPStepDot(state: state, theme: theme)
                    Text(message.text)
                        .font(.system(size: 10, weight: .semibold))
                        .foregroundColor(isErr ? theme.failed : theme.text.opacity(0.84))
                        .lineLimit(1)
                    Spacer(minLength: 4)
                    if total > 1 {
                        Text("\(total) 步")
                            .font(.system(size: 8.5, weight: .medium, design: .monospaced))
                            .foregroundColor(theme.muted)
                    }
                }
                if hidden > 0 {
                    Text("… 前面还有 \(hidden) 步")
                        .font(.system(size: 8.5))
                        .foregroundColor(theme.muted.opacity(0.75))
                        .padding(.leading, 12)
                }
                ForEach(steps) { step in
                    VStack(alignment: .leading, spacing: 1) {
                        HStack(spacing: 5) {
                            PiPStepDot(state: step.state, theme: theme)
                            Text(step.summary)
                                .font(.system(size: 9.5, design: .monospaced))
                                .foregroundColor(step.state == "error" ? theme.failed : theme.muted)
                                .lineLimit(1)
                                .truncationMode(.tail)
                            Spacer(minLength: 0)
                        }
                        if let out = step.output, !out.isEmpty {
                            Text(out)
                                .font(.system(size: 8.5, design: .monospaced))
                                .foregroundColor(step.state == "error" ? theme.failed.opacity(0.88) : theme.muted)
                                .lineLimit(1)
                                .padding(.leading, 12)
                        }
                    }
                    .padding(.leading, 4)
                }
            }
            .padding(.horizontal, 8)
            .padding(.vertical, 5)
            .background(
                RoundedRectangle(cornerRadius: 7, style: .continuous)
                    .fill(isErr ? theme.failed.opacity(0.11) : theme.cardBg)
                    .overlay(
                        RoundedRectangle(cornerRadius: 7, style: .continuous)
                            .stroke(isErr ? theme.failed.opacity(0.28) : theme.border, lineWidth: 0.5)
                    )
            )
        }
    }
}

/// 对齐桌面 `StepDot`：running 呼吸紫点 / error 红点 / ok 绿点。
private struct PiPStepDot: View {
    let state: String
    let theme: PiPTheme

    var body: some View {
        Group {
            if state == "running" {
                PiPStreamingDot(color: theme.running)
            } else if state == "error" {
                Circle().fill(theme.failed).frame(width: 5.5, height: 5.5)
            } else {
                Circle().fill(theme.idle.opacity(0.85)).frame(width: 4.5, height: 4.5)
            }
        }
        .frame(width: 7, height: 7)
    }
}

/// 极轻 Markdown 段落渲染：优先走 Foundation `AttributedString(markdown:)` 呈现加粗/斜体/行内代码/链接，
/// 解析失败（如流式半截反引号）时平滑回落为纯文本。
private struct PiPMarkdownParagraph: View {
    let text: String
    let fontSize: CGFloat
    let color: Color
    let lineLimit: Int

    var body: some View {
        let rendered: Text = {
            if let attr = try? AttributedString(
                markdown: text,
                options: AttributedString.MarkdownParsingOptions(
                    interpretedSyntax: .inlineOnlyPreservingWhitespace
                )
            ) {
                return Text(attr)
            }
            return Text(text)
        }()
        return rendered
            .font(.system(size: fontSize))
            .foregroundColor(color)
            .lineSpacing(2)
            .lineLimit(lineLimit)
            .fixedSize(horizontal: false, vertical: true)
    }
}

private enum PiPMarkdownBlock {
    case paragraph(String)
    case code(lang: String, code: String)

    /// 把回复按 ``` 围栏拆成段落与代码块，支持流式未闭合的代码块。
    static func parse(_ source: String) -> [PiPMarkdownBlock] {
        guard !source.isEmpty else { return [] }
        var blocks: [PiPMarkdownBlock] = []
        var textLines: [String] = []
        var codeLines: [String] = []
        var inCode = false
        var codeLang = ""

        func flushText() {
            let joined = textLines.joined(separator: "\n").trimmingCharacters(in: .whitespacesAndNewlines)
            if !joined.isEmpty { blocks.append(.paragraph(joined)) }
            textLines.removeAll()
        }
        func flushCode() {
            let joined = codeLines.joined(separator: "\n").trimmingCharacters(in: .newlines)
            if !joined.isEmpty { blocks.append(.code(lang: codeLang, code: joined)) }
            codeLines.removeAll()
            codeLang = ""
        }

        for rawLine in source.split(separator: "\n", omittingEmptySubsequences: false) {
            let line = String(rawLine)
            let trimmed = line.trimmingCharacters(in: .whitespaces)
            if trimmed.hasPrefix("```") {
                if inCode {
                    flushCode()
                    inCode = false
                } else {
                    flushText()
                    codeLang = String(trimmed.dropFirst(3)).trimmingCharacters(in: .whitespaces)
                    inCode = true
                }
            } else if inCode {
                codeLines.append(line)
            } else {
                textLines.append(line)
            }
        }
        if inCode { flushCode() } else { flushText() }
        return blocks
    }
}

private struct PiPStreamingDot: View {
    let color: Color
    @State private var dimmed = false

    var body: some View {
        Circle()
            .fill(color)
            .frame(width: 5, height: 5)
            .opacity(dimmed ? 0.25 : 1)
            .onAppear {
                withAnimation(.easeInOut(duration: 0.7).repeatForever(autoreverses: true)) {
                    dimmed = true
                }
            }
    }
}
