import ActivityKit
import EnsoCore
import SwiftUI
import WidgetKit

@available(iOS 16.1, *)
struct EnsoLiveActivityWidget: Widget {
    var body: some WidgetConfiguration {
        ActivityConfiguration(for: EnsoSessionActivityAttributes.self) { context in
            LockScreenActivityView(context: context)
                .widgetURL(EnsoWidgetSnapshot.deepLinkURL(sessionId: context.attributes.sessionId))
                .activityBackgroundTint(Color(red: 0.08, green: 0.09, blue: 0.13))
                .activitySystemActionForegroundColor(.white)
        } dynamicIsland: { context in
            DynamicIsland {
                DynamicIslandExpandedRegion(.leading) {
                    HStack(spacing: 6) {
                        ActivityStatusIcon(status: context.state.status, size: 16)
                        Text(context.attributes.deviceLabel)
                            .font(.caption.weight(.semibold))
                            .foregroundStyle(.white.opacity(0.9))
                            .lineLimit(1)
                    }
                    .padding(.leading, 10)
                    .padding(.top, 2)
                }
                DynamicIslandExpandedRegion(.trailing) {
                    HStack(spacing: 6) {
                        if context.state.status == "running" {
                            Text(context.state.startedAt, style: .timer)
                                .font(.caption.weight(.semibold).monospacedDigit())
                                .multilineTextAlignment(.trailing)
                                .foregroundStyle(Color(red: 0.65, green: 0.71, blue: 0.99))
                                .frame(width: 56, alignment: .trailing)
                        } else if context.state.pendingCount > 0 {
                            Text("\(context.state.pendingCount) 待办")
                                .font(.caption.weight(.bold))
                                .foregroundStyle(Color(red: 0.98, green: 0.75, blue: 0.14))
                        } else {
                            Text("已完成")
                                .font(.caption.weight(.semibold))
                                .foregroundStyle(Color(red: 0.20, green: 0.83, blue: 0.60))
                        }
                    }
                    .padding(.trailing, 10)
                    .padding(.top, 2)
                }
                DynamicIslandExpandedRegion(.bottom) {
                    VStack(alignment: .leading, spacing: 5) {
                        Text(context.state.title)
                            .font(.subheadline.weight(.semibold))
                            .foregroundStyle(.white)
                            .lineLimit(1)
                        HStack(spacing: 6) {
                            Text(context.state.projectName)
                                .font(.caption2.weight(.medium))
                                .foregroundStyle(.white.opacity(0.68))
                                .lineLimit(1)
                            Text("·")
                                .font(.caption2)
                                .foregroundStyle(.white.opacity(0.4))
                            Text(context.state.detail)
                                .font(.caption2)
                                .foregroundStyle(.white.opacity(0.85))
                                .lineLimit(1)
                            Spacer(minLength: 0)
                            if context.state.runningCount > 1 {
                                Text("\(context.state.runningCount) 并行")
                                    .font(.caption2.weight(.medium))
                                    .foregroundStyle(.white.opacity(0.55))
                                    .lineLimit(1)
                            }
                        }
                    }
                    .padding(.horizontal, 14)
                    .padding(.top, 4)
                    .padding(.bottom, 6)
                }
            } compactLeading: {
                ActivityStatusIcon(status: context.state.status, size: 15)
                    .padding(.leading, 2)
            } compactTrailing: {
                if context.state.pendingCount > 0 {
                    Text("\(context.state.pendingCount) 待办")
                        .font(.caption2.weight(.bold))
                        .foregroundStyle(Color(red: 0.98, green: 0.75, blue: 0.14))
                        .padding(.trailing, 2)
                } else if context.state.status == "running" {
                    Text(context.state.startedAt, style: .timer)
                        .font(.caption2.weight(.semibold).monospacedDigit())
                        .multilineTextAlignment(.trailing)
                        .foregroundStyle(Color(red: 0.65, green: 0.71, blue: 0.99))
                        .frame(width: 40, alignment: .trailing)
                        .padding(.trailing, 2)
                } else {
                    Image(systemName: "checkmark")
                        .font(.caption2.weight(.bold))
                        .foregroundStyle(Color(red: 0.20, green: 0.83, blue: 0.60))
                        .padding(.trailing, 2)
                }
            } minimal: {
                if context.state.pendingCount > 0 {
                    Text("\(context.state.pendingCount)")
                        .font(.caption2.weight(.bold))
                        .foregroundStyle(Color(red: 0.98, green: 0.75, blue: 0.14))
                } else {
                    ActivityStatusIcon(status: context.state.status, size: 14)
                }
            }
            .widgetURL(EnsoWidgetSnapshot.deepLinkURL(sessionId: context.attributes.sessionId))
            .keylineTint(activityTint(context.state.status))
        }
    }
}

@available(iOS 16.1, *)
private struct LockScreenActivityView: View {
    let context: ActivityViewContext<EnsoSessionActivityAttributes>

    var body: some View {
        let tint = activityTint(context.state.status)
        HStack(spacing: 12) {
            ZStack {
                RoundedRectangle(cornerRadius: 10, style: .continuous)
                    .fill(tint.opacity(0.2))
                    .frame(width: 40, height: 40)
                ActivityStatusIcon(status: context.state.status, size: 22)
            }

            VStack(alignment: .leading, spacing: 3) {
                HStack(spacing: 6) {
                    Text(context.state.title)
                        .font(.subheadline.weight(.semibold))
                        .foregroundStyle(.white)
                        .lineLimit(1)
                    Spacer(minLength: 0)
                    if context.state.status == "running" {
                        Text(context.state.startedAt, style: .timer)
                            .font(.caption.weight(.semibold).monospacedDigit())
                            .foregroundStyle(tint)
                    } else if context.state.pendingCount > 0 {
                        Text("\(context.state.pendingCount) 待确认")
                            .font(.caption2.weight(.bold))
                            .padding(.horizontal, 6)
                            .padding(.vertical, 2)
                            .background(tint.opacity(0.22), in: Capsule())
                            .foregroundStyle(tint)
                    } else {
                        Text("已完成")
                            .font(.caption2.weight(.semibold))
                            .foregroundStyle(tint)
                    }
                }

                HStack(spacing: 6) {
                    Text(context.state.projectName)
                        .font(.caption2.weight(.medium))
                        .foregroundStyle(.white.opacity(0.65))
                        .lineLimit(1)
                    Text("·")
                        .font(.caption2)
                        .foregroundStyle(.white.opacity(0.4))
                    Text(context.state.detail)
                        .font(.caption2)
                        .foregroundStyle(.white.opacity(0.85))
                        .lineLimit(1)
                    Spacer(minLength: 0)
                    if context.state.runningCount > 1 {
                        Text("\(context.state.runningCount) 并行")
                            .font(.caption2)
                            .foregroundStyle(.white.opacity(0.6))
                    }
                }
            }
        }
        .padding(.horizontal, 14)
        .padding(.vertical, 12)
    }
}

private struct ActivityStatusIcon: View {
    let status: String
    let size: CGFloat

    var body: some View {
        let badge: EnsoMarkBadge = {
            switch status {
            case "pending": return .pending
            case "done": return .done
            default: return .none
            }
        }()
        EnsoMarkView(size: size, color: activityTint(status), badge: badge)
            .accessibilityLabel("EnsoCode")
    }
}

private func activityTint(_ status: String) -> Color {
    switch status {
    case "pending": return Color(red: 0.98, green: 0.75, blue: 0.14)
    case "done": return Color(red: 0.20, green: 0.83, blue: 0.60)
    case "offline": return .gray
    default: return Color(red: 0.51, green: 0.55, blue: 0.97)
    }
}
