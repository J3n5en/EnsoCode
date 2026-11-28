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

private enum PiPPalette {
    static let surface = Color(red: 0.07, green: 0.08, blue: 0.10)
    static let surfaceRaised = Color(red: 0.12, green: 0.13, blue: 0.16)
    static let text = Color.white.opacity(0.92)
    static let muted = Color.white.opacity(0.55)
    static let running = Color(red: 0.39, green: 0.40, blue: 0.95)
    static let pending = Color(red: 0.96, green: 0.62, blue: 0.04)
    static let idle = Color(red: 0.06, green: 0.72, blue: 0.51)
    static let failed = Color(red: 0.94, green: 0.33, blue: 0.31)
    static let offline = Color.white.opacity(0.45)
}

/// 会话状态到画中画展示（文案 / 颜色 / 圆相角标）的映射表。
private struct PiPStatusStyle {
    let label: String
    let color: Color
    let badge: EnsoMarkBadge

    init(status: String) {
        switch status {
        case "running": self.init("运行中", PiPPalette.running, .none)
        case "pending": self.init("待确认", PiPPalette.pending, .pending)
        case "failed": self.init("失败", PiPPalette.failed, .none)
        case "offline": self.init("离线", PiPPalette.offline, .none)
        default: self.init("空闲", PiPPalette.idle, .done)
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

    private static let bottomAnchor = "pip-bottom"

    var body: some View {
        let snapshot = model.snapshot
        let style = PiPStatusStyle(status: snapshot.status)
        VStack(spacing: 0) {
            header(snapshot, style: style)
            Divider().overlay(Color.white.opacity(0.08))
            feed(snapshot, accent: style.color)
            if let hint = snapshot.pendingHint {
                pendingBanner(hint)
            }
        }
        .background(PiPPalette.surface)
        .environment(\.colorScheme, .dark)
    }

    private func header(_ snapshot: EnsoPiPSnapshot, style: PiPStatusStyle) -> some View {
        HStack(spacing: 7) {
            EnsoMarkView(size: 16, color: style.color, badge: style.badge)
            VStack(alignment: .leading, spacing: 1) {
                Text(snapshot.title)
                    .font(.system(size: 12, weight: .bold))
                    .foregroundColor(PiPPalette.text)
                    .lineLimit(1)
                if !snapshot.projectName.isEmpty {
                    Text(snapshot.projectName)
                        .font(.system(size: 9.5, weight: .medium))
                        .foregroundColor(PiPPalette.muted)
                        .lineLimit(1)
                }
            }
            Spacer(minLength: 4)
            Text(style.label)
                .font(.system(size: 9.5, weight: .semibold))
                .foregroundColor(style.color)
                .padding(.horizontal, 6)
                .padding(.vertical, 2)
                .background(Capsule().fill(style.color.opacity(0.16)))
        }
        .padding(.horizontal, 10)
        .padding(.vertical, 6)
        .background(PiPPalette.surfaceRaised)
    }

    private func feed(_ snapshot: EnsoPiPSnapshot, accent: Color) -> some View {
        ScrollViewReader { proxy in
            ScrollView(.vertical, showsIndicators: false) {
                if snapshot.messages.isEmpty {
                    emptyState(snapshot)
                } else {
                    LazyVStack(alignment: .leading, spacing: 6) {
                        ForEach(snapshot.messages) { message in
                            PiPMessageRow(
                                message: message,
                                isLatest: message.id == snapshot.messages.last?.id,
                                accent: accent
                            )
                        }
                    }
                    .padding(.horizontal, 10)
                    .padding(.top, 6)
                }
                Color.clear
                    .frame(height: 4)
                    .id(Self.bottomAnchor)
            }
            .onAppear {
                proxy.scrollTo(Self.bottomAnchor, anchor: .bottom)
            }
            .onChange(of: scrollKey(snapshot)) { _ in
                withAnimation(.easeOut(duration: 0.2)) {
                    proxy.scrollTo(Self.bottomAnchor, anchor: .bottom)
                }
            }
        }
    }

    /// 新快照、新消息或流式正文增长时都需要滚到底部。
    private func scrollKey(_ snapshot: EnsoPiPSnapshot) -> String {
        let last = snapshot.messages.last
        return "\(snapshot.updatedAt)|\(snapshot.messages.count)|\(last?.id ?? "")|\(last?.text.count ?? 0)"
    }

    private func emptyState(_ snapshot: EnsoPiPSnapshot) -> some View {
        VStack(spacing: 6) {
            EnsoMarkView(size: 26, color: PiPPalette.muted.opacity(0.6))
            Text("等待对话输出…")
                .font(.system(size: 11, weight: .medium))
                .foregroundColor(PiPPalette.muted)
            if let hint = connectionHint(snapshot.connectionState) {
                Text(hint)
                    .font(.system(size: 9.5))
                    .foregroundColor(PiPPalette.muted.opacity(0.8))
            }
        }
        .frame(maxWidth: .infinity)
        .padding(.top, 26)
    }

    private func connectionHint(_ state: String) -> String? {
        switch state {
        case "online": return nil
        case "connecting": return "正在连接桌面端…"
        case "host-offline": return "桌面端离线"
        default: return "未连接桌面端，返回 EnsoCode 重新连接"
        }
    }

    private func pendingBanner(_ hint: String) -> some View {
        HStack(spacing: 6) {
            Circle()
                .fill(PiPPalette.pending)
                .frame(width: 6, height: 6)
            Text("待确认 · \(hint)")
                .font(.system(size: 10.5, weight: .semibold))
                .foregroundColor(PiPPalette.pending)
                .lineLimit(1)
            Spacer(minLength: 4)
            Text("点击返回处理")
                .font(.system(size: 9.5, weight: .medium))
                .foregroundColor(PiPPalette.pending.opacity(0.8))
                .lineLimit(1)
                .fixedSize()
        }
        .padding(.horizontal, 10)
        .padding(.vertical, 5)
        .background(PiPPalette.pending.opacity(0.16))
    }
}

private struct PiPMessageRow: View {
    let message: EnsoPiPMessage
    let isLatest: Bool
    let accent: Color

    var body: some View {
        if message.role == "user" {
            userBubble
        } else if message.role == "tool" || message.isError {
            PiPToolTag(name: message.toolName ?? "tool", detail: message.text, isError: message.isError)
        } else if message.role == "system" {
            Text(message.text)
                .font(.system(size: 10).italic())
                .foregroundColor(PiPPalette.muted)
                .lineLimit(2)
        } else {
            assistantText
        }
    }

    private var userBubble: some View {
        HStack {
            Spacer(minLength: 36)
            Text(message.text)
                .font(.system(size: 11.5))
                .foregroundColor(PiPPalette.text)
                .lineLimit(3)
                .padding(.horizontal, 8)
                .padding(.vertical, 4)
                .background(
                    RoundedRectangle(cornerRadius: 9, style: .continuous)
                        .fill(accent.opacity(0.24))
                )
        }
    }

    private var assistantText: some View {
        VStack(alignment: .leading, spacing: 3) {
            if let toolName = message.toolName {
                PiPToolTag(name: toolName, detail: nil, isError: false)
            }
            if !message.text.isEmpty || message.isStreaming {
                HStack(alignment: .lastTextBaseline, spacing: 4) {
                    if !message.text.isEmpty {
                        Text(message.text)
                            .font(.system(size: 12))
                            .foregroundColor(PiPPalette.text)
                            .lineLimit(isLatest || message.isStreaming ? 8 : 4)
                            .fixedSize(horizontal: false, vertical: true)
                    }
                    if message.isStreaming {
                        PiPStreamingDot(color: accent)
                    }
                }
            }
        }
        .frame(maxWidth: .infinity, alignment: .leading)
    }
}

private struct PiPToolTag: View {
    let name: String
    let detail: String?
    let isError: Bool

    var body: some View {
        let tint = isError ? PiPPalette.failed : PiPPalette.muted
        HStack(spacing: 4) {
            Image(systemName: isError ? "exclamationmark.triangle.fill" : "terminal")
                .font(.system(size: 8.5, weight: .semibold))
            Text(name)
                .font(.system(size: 9.5, weight: .semibold, design: .monospaced))
                .lineLimit(1)
            if let detail, !detail.isEmpty {
                Text(detail)
                    .font(.system(size: 9.5, design: .monospaced))
                    .foregroundColor(tint.opacity(0.85))
                    .lineLimit(1)
            }
        }
        .foregroundColor(tint)
        .padding(.horizontal, 6)
        .padding(.vertical, 2)
        .background(
            RoundedRectangle(cornerRadius: 5, style: .continuous)
                .fill(tint.opacity(isError ? 0.16 : 0.12))
        )
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
