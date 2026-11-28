import EnsoCore
import SwiftUI
import WidgetKit

struct EnsoWidgetEntry: TimelineEntry {
    let date: Date
    let snapshot: EnsoWidgetSnapshot
}

struct EnsoStatusProvider: TimelineProvider {
    func placeholder(in context: Context) -> EnsoWidgetEntry {
        EnsoWidgetEntry(date: Date(), snapshot: Self.previewSnapshot)
    }

    func getSnapshot(in context: Context, completion: @escaping (EnsoWidgetEntry) -> Void) {
        let snap = SharedWidgetStore.shared.load() ?? (context.isPreview ? Self.previewSnapshot : .placeholder)
        completion(EnsoWidgetEntry(date: Date(), snapshot: snap))
    }

    func getTimeline(in context: Context, completion: @escaping (Timeline<EnsoWidgetEntry>) -> Void) {
        let now = Date()
        let snap = SharedWidgetStore.shared.load() ?? .placeholder
        let nextRefresh = Calendar.current.date(byAdding: .minute, value: 15, to: now) ?? now.addingTimeInterval(900)
        completion(Timeline(entries: [EnsoWidgetEntry(date: now, snapshot: snap)], policy: .after(nextRefresh)))
    }

    static let previewSnapshot = EnsoWidgetSnapshot(
        deviceLabel: "MacBook Pro",
        connectionState: "online",
        transport: "direct",
        rttMs: 12,
        runningCount: 1,
        pendingCount: 1,
        unreadCount: 2,
        activeTitle: "优化中继延迟与灵动岛",
        activeProject: "enso-code",
        activeSessionId: "preview-1",
        activeStatus: "pending",
        activeDetail: "等待审批执行命令",
        startedAt: Date().timeIntervalSince1970 * 1000 - 45_000,
        sessions: [
            EnsoWidgetSessionItem(
                id: "preview-1",
                title: "优化中继延迟与灵动岛",
                projectName: "enso-code",
                status: "waiting",
                pendingCount: 1,
                unread: true,
                updatedAt: Date().timeIntervalSince1970 * 1000
            ),
            EnsoWidgetSessionItem(
                id: "preview-2",
                title: "排查 iOS 推送回调",
                projectName: "enso-code",
                status: "running",
                pendingCount: 0,
                unread: false,
                updatedAt: Date().timeIntervalSince1970 * 1000 - 120_000
            ),
        ],
        updatedAt: Date().timeIntervalSince1970 * 1000
    )
}

struct EnsoStatusWidget: Widget {
    let kind = "EnsoStatusWidget"

    var body: some WidgetConfiguration {
        StaticConfiguration(kind: kind, provider: EnsoStatusProvider()) { entry in
            EnsoStatusWidgetView(entry: entry)
        }
        .configurationDisplayName("EnsoCode 状态")
        .description("实时查看桌面端 Agent 运行状态、待审批任务与活跃会话。")
        .supportedFamilies([
            .systemSmall,
            .systemMedium,
            .accessoryCircular,
            .accessoryRectangular,
            .accessoryInline,
        ])
    }
}

private struct EnsoStatusWidgetView: View {
    @Environment(\.widgetFamily) private var family
    let entry: EnsoWidgetEntry

    var body: some View {
        Group {
            switch family {
            case .systemSmall:
                SmallWidgetView(snapshot: entry.snapshot)
            case .systemMedium:
                MediumWidgetView(snapshot: entry.snapshot)
            case .accessoryCircular:
                CircularLockView(snapshot: entry.snapshot)
            case .accessoryRectangular:
                RectangularLockView(snapshot: entry.snapshot)
            case .accessoryInline:
                InlineLockView(snapshot: entry.snapshot)
            default:
                SmallWidgetView(snapshot: entry.snapshot)
            }
        }
        .widgetURL(EnsoWidgetSnapshot.deepLinkURL(sessionId: entry.snapshot.activeSessionId))
        .ensoWidgetBackground()
    }
}

private func statusAccent(_ snapshot: EnsoWidgetSnapshot) -> Color {
    if snapshot.pendingCount > 0 { return Color(red: 0.96, green: 0.62, blue: 0.04) }
    if snapshot.runningCount > 0 { return Color(red: 0.39, green: 0.40, blue: 0.95) }
    if snapshot.connectionState == "online" { return Color(red: 0.06, green: 0.72, blue: 0.51) }
    return .secondary
}

private func connectionBadgeText(_ snapshot: EnsoWidgetSnapshot) -> String {
    if snapshot.pendingCount > 0 { return "待确认" }
    if snapshot.runningCount > 0 { return "运行中" }
    switch snapshot.connectionState {
    case "online": return snapshot.transport == "direct" ? "直连" : "在线"
    case "connecting": return "连接中"
    case "host-offline": return "桌面离线"
    default: return "未连接"
    }
}

private func sessionDotColor(_ item: EnsoWidgetSessionItem) -> Color {
    if item.pendingCount > 0 || item.status == "waiting" {
        return Color(red: 0.96, green: 0.62, blue: 0.04)
    }
    if item.status == "running" {
        return Color(red: 0.39, green: 0.40, blue: 0.95)
    }
    if item.unread {
        return Color(red: 0.06, green: 0.72, blue: 0.51)
    }
    return Color.secondary.opacity(0.45)
}

private struct SmallWidgetView: View {
    let snapshot: EnsoWidgetSnapshot

    var body: some View {
        let accent = statusAccent(snapshot)
        VStack(alignment: .leading, spacing: 8) {
            HStack(spacing: 5) {
                EnsoMarkView(
                    size: 13,
                    color: accent,
                    badge: snapshot.pendingCount > 0 ? .pending : .none
                )
                Text(snapshot.deviceLabel)
                    .font(.caption.weight(.semibold))
                    .lineLimit(1)
                Spacer(minLength: 0)
            }

            Spacer(minLength: 0)

            HStack(alignment: .firstTextBaseline, spacing: 12) {
                MetricBlock(
                    value: snapshot.runningCount,
                    label: "运行",
                    color: snapshot.runningCount > 0 ? Color(red: 0.39, green: 0.40, blue: 0.95) : .secondary
                )
                MetricBlock(
                    value: snapshot.pendingCount,
                    label: "待办",
                    color: snapshot.pendingCount > 0 ? Color(red: 0.96, green: 0.62, blue: 0.04) : .secondary
                )
            }

            Spacer(minLength: 0)

            VStack(alignment: .leading, spacing: 2) {
                Text(snapshot.activeTitle ?? connectionBadgeText(snapshot))
                    .font(.caption.weight(.medium))
                    .lineLimit(1)
                Text(snapshot.activeProject ?? snapshot.activeDetail ?? "点击打开 EnsoCode")
                    .font(.caption2)
                    .foregroundStyle(.secondary)
                    .lineLimit(1)
            }
        }
        .padding(2)
    }
}

private struct MetricBlock: View {
    let value: Int
    let label: String
    let color: Color

    var body: some View {
        VStack(alignment: .leading, spacing: 1) {
            Text("\(value)")
                .font(.system(size: 28, weight: .bold, design: .rounded))
                .foregroundStyle(color)
                .monospacedDigit()
            Text(label)
                .font(.caption2)
                .foregroundStyle(.secondary)
        }
    }
}

private struct MediumWidgetView: View {
    let snapshot: EnsoWidgetSnapshot

    var body: some View {
        let accent = statusAccent(snapshot)
        HStack(spacing: 12) {
            VStack(alignment: .leading, spacing: 6) {
                HStack(spacing: 5) {
                    EnsoMarkView(
                        size: 13,
                        color: accent,
                        badge: snapshot.pendingCount > 0 ? .pending : .none
                    )
                    Text(snapshot.deviceLabel)
                        .font(.caption.weight(.semibold))
                        .lineLimit(1)
                }

                Text(connectionBadgeText(snapshot))
                    .font(.caption2.weight(.medium))
                    .padding(.horizontal, 7)
                    .padding(.vertical, 2)
                    .background(accent.opacity(0.16), in: Capsule())
                    .foregroundStyle(accent)

                Spacer(minLength: 0)

                HStack(spacing: 12) {
                    MetricBlock(
                        value: snapshot.runningCount,
                        label: "运行",
                        color: snapshot.runningCount > 0 ? Color(red: 0.39, green: 0.40, blue: 0.95) : .secondary
                    )
                    MetricBlock(
                        value: snapshot.pendingCount,
                        label: "待办",
                        color: snapshot.pendingCount > 0 ? Color(red: 0.96, green: 0.62, blue: 0.04) : .secondary
                    )
                }
            }
            .frame(maxWidth: 112, alignment: .leading)

            Divider()

            VStack(alignment: .leading, spacing: 6) {
                if snapshot.sessions.isEmpty {
                    Spacer(minLength: 0)
                    Text("暂无活跃会话")
                        .font(.caption.weight(.medium))
                        .foregroundStyle(.secondary)
                    Text("点击打开 EnsoCode 开始任务")
                        .font(.caption2)
                        .foregroundStyle(.tertiary)
                    Spacer(minLength: 0)
                } else {
                    ForEach(Array(snapshot.sessions.prefix(3))) { item in
                        Link(destination: EnsoWidgetSnapshot.deepLinkURL(sessionId: item.id)) {
                            HStack(spacing: 6) {
                                Circle()
                                    .fill(sessionDotColor(item))
                                    .frame(width: 6, height: 6)
                                VStack(alignment: .leading, spacing: 1) {
                                    Text(item.title)
                                        .font(.caption.weight(.medium))
                                        .lineLimit(1)
                                    Text(item.projectName)
                                        .font(.caption2)
                                        .foregroundStyle(.secondary)
                                        .lineLimit(1)
                                }
                                Spacer(minLength: 0)
                                if item.pendingCount > 0 {
                                    Text("\(item.pendingCount)")
                                        .font(.caption2.weight(.bold))
                                        .padding(.horizontal, 5)
                                        .padding(.vertical, 1)
                                        .background(
                                            Color(red: 0.96, green: 0.62, blue: 0.04).opacity(0.2),
                                            in: Capsule()
                                        )
                                        .foregroundStyle(Color(red: 0.96, green: 0.62, blue: 0.04))
                                }
                            }
                        }
                    }
                    Spacer(minLength: 0)
                }
            }
            .frame(maxWidth: .infinity, alignment: .leading)
        }
        .padding(2)
    }
}

private struct CircularLockView: View {
    let snapshot: EnsoWidgetSnapshot

    var body: some View {
        let count = snapshot.pendingCount > 0 ? snapshot.pendingCount : snapshot.runningCount
        ZStack {
            AccessoryWidgetBackground()
            VStack(spacing: 1) {
                EnsoMarkView(
                    size: 15,
                    color: .primary,
                    badge: snapshot.pendingCount > 0 ? .pending : .none
                )
                Text(count > 0 ? "\(count)" : "就绪")
                    .font(.system(size: 16, weight: .bold, design: .rounded))
                    .monospacedDigit()
            }
        }
    }
}

private struct RectangularLockView: View {
    let snapshot: EnsoWidgetSnapshot

    var body: some View {
        VStack(alignment: .leading, spacing: 2) {
            HStack(spacing: 4) {
                EnsoMarkView(
                    size: 12,
                    color: .primary,
                    badge: snapshot.pendingCount > 0 ? .pending : .none
                )
                Text("Enso · \(connectionBadgeText(snapshot))")
                    .font(.caption.weight(.semibold))
                    .lineLimit(1)
            }
            Text(snapshot.activeTitle ?? "无活跃任务")
                .font(.caption)
                .lineLimit(1)
            Text("运行 \(snapshot.runningCount) · 待办 \(snapshot.pendingCount)")
                .font(.caption2)
                .foregroundStyle(.secondary)
                .lineLimit(1)
        }
        .frame(maxWidth: .infinity, alignment: .leading)
    }
}

private struct InlineLockView: View {
    let snapshot: EnsoWidgetSnapshot

    var body: some View {
        if snapshot.pendingCount > 0 {
            Label("Enso · \(snapshot.pendingCount) 项待确认", systemImage: "exclamationmark.bubble.fill")
        } else if snapshot.runningCount > 0 {
            Label("Enso · \(snapshot.runningCount) 个运行中", systemImage: "sparkles")
        } else {
            Label("Enso · \(connectionBadgeText(snapshot))", systemImage: "terminal.fill")
        }
    }
}

private extension View {
    @ViewBuilder
    func ensoWidgetBackground() -> some View {
        if #available(iOS 17.0, *) {
            self.containerBackground(for: .widget) {
                Color(.systemBackground)
            }
        } else {
            self.padding(12)
                .background(Color(.systemBackground))
        }
    }
}
