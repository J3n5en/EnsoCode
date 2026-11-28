import ActivityKit
import EnsoCore
import Foundation
import WidgetKit

/// 负责把前端推送过来的实时会话状态落盘到 App Group（供主屏幕/锁屏小组件读取），
/// 并自动驱动 iOS 灵动岛与锁屏实时活动（ActivityKit Live Activity）。
@MainActor
final class EnsoWidgetBridge {
    static let shared = EnsoWidgetBridge()

    private var lastSnapshot: EnsoWidgetSnapshot?
    private var lastWidgetReloadAt: Date = .distantPast
    private var activeStartedAt: Date = Date()
    private var activeSessionIdForTimer: String?
    private var hadLiveWork = false

    private let minWidgetReloadInterval: TimeInterval = 5

    /// 处理前端 `window.__ensoNative.updateWidgetState(snapshot)` 推送。
    func update(from rawObject: [String: Any]) {
        guard let data = try? JSONSerialization.data(withJSONObject: rawObject, options: []),
              let snapshot = try? JSONDecoder().decode(EnsoWidgetSnapshot.self, from: data)
        else { return }

        let changed = isMeaningfullyChanged(old: lastSnapshot, new: snapshot)
        lastSnapshot = snapshot
        _ = SharedWidgetStore.shared.save(snapshot)

        let now = Date()
        if changed || now.timeIntervalSince(lastWidgetReloadAt) >= minWidgetReloadInterval {
            lastWidgetReloadAt = now
            WidgetCenter.shared.reloadAllTimelines()
        }

        if #available(iOS 16.1, *) {
            syncLiveActivity(with: snapshot)
        }
    }

    private func isMeaningfullyChanged(old: EnsoWidgetSnapshot?, new: EnsoWidgetSnapshot) -> Bool {
        guard let old else { return true }
        return old.deviceLabel != new.deviceLabel
            || old.connectionState != new.connectionState
            || old.runningCount != new.runningCount
            || old.pendingCount != new.pendingCount
            || old.unreadCount != new.unreadCount
            || old.activeSessionId != new.activeSessionId
            || old.activeTitle != new.activeTitle
            || old.activeStatus != new.activeStatus
            || old.activeDetail != new.activeDetail
            || old.sessions.count != new.sessions.count
            || old.sessions.first != new.sessions.first
    }

    @available(iOS 16.1, *)
    private func syncLiveActivity(with snapshot: EnsoWidgetSnapshot) {
        guard ActivityAuthorizationInfo().areActivitiesEnabled else { return }

        let hasWork = snapshot.runningCount > 0 || snapshot.pendingCount > 0
        let existing = Activity<EnsoSessionActivityAttributes>.activities.first

        if hasWork {
            let sid = snapshot.activeSessionId ?? ""
            if let ms = snapshot.startedAt, ms > 0 {
                activeStartedAt = Date(timeIntervalSince1970: ms / 1000)
                activeSessionIdForTimer = sid
            } else if !hadLiveWork || activeSessionIdForTimer != sid {
                activeStartedAt = Date()
                activeSessionIdForTimer = sid
            }
            hadLiveWork = true

            let status = snapshot.pendingCount > 0 ? "pending" : "running"
            let title = nonEmpty(snapshot.activeTitle) ?? "EnsoCode 正在执行"
            let project = nonEmpty(snapshot.activeProject) ?? snapshot.deviceLabel
            let detail: String = {
                if let d = nonEmpty(snapshot.activeDetail) { return d }
                if snapshot.pendingCount > 0 {
                    return "有 \(snapshot.pendingCount) 项等待你的确认"
                }
                return snapshot.runningCount > 1
                    ? "\(snapshot.runningCount) 个会话运行中"
                    : "Agent 正在执行"
            }()

            let state = EnsoSessionActivityAttributes.ContentState(
                status: status,
                title: title,
                projectName: project,
                detail: detail,
                runningCount: snapshot.runningCount,
                pendingCount: snapshot.pendingCount,
                startedAt: activeStartedAt
            )

            if let activity = existing {
                Task {
                    if #available(iOS 16.2, *) {
                        await activity.update(
                            ActivityContent(
                                state: state,
                                staleDate: Date().addingTimeInterval(30 * 60)
                            )
                        )
                    } else {
                        await activity.update(using: state)
                    }
                }
            } else {
                let attrs = EnsoSessionActivityAttributes(
                    sessionId: sid,
                    deviceLabel: snapshot.deviceLabel
                )
                do {
                    if #available(iOS 16.2, *) {
                        _ = try Activity.request(
                            attributes: attrs,
                            content: ActivityContent(
                                state: state,
                                staleDate: Date().addingTimeInterval(30 * 60)
                            ),
                            pushType: nil
                        )
                    } else {
                        _ = try Activity.request(
                            attributes: attrs,
                            contentState: state,
                            pushType: nil
                        )
                    }
                } catch {
                    NSLog("[EnsoWidgetBridge] Activity.request failed: %@", String(describing: error))
                }
            }
            return
        }

        // 没有进行中任务且没有待审批：把现有灵动岛切换为「已完成」并在 15 秒后优雅收起
        hadLiveWork = false
        activeSessionIdForTimer = nil
        let activities = Activity<EnsoSessionActivityAttributes>.activities
        guard !activities.isEmpty else { return }

        let doneTitle = nonEmpty(snapshot.activeTitle) ?? "EnsoCode"
        let doneProject = nonEmpty(snapshot.activeProject) ?? snapshot.deviceLabel
        let doneState = EnsoSessionActivityAttributes.ContentState(
            status: "done",
            title: doneTitle,
            projectName: doneProject,
            detail: "任务已完成",
            runningCount: 0,
            pendingCount: 0,
            startedAt: activeStartedAt
        )
        let dismissAt = Date().addingTimeInterval(15)
        for activity in activities {
            Task {
                if #available(iOS 16.2, *) {
                    await activity.end(
                        ActivityContent(state: doneState, staleDate: dismissAt),
                        dismissalPolicy: .after(dismissAt)
                    )
                } else {
                    await activity.end(using: doneState, dismissalPolicy: .after(dismissAt))
                }
            }
        }
    }

    private func nonEmpty(_ text: String?) -> String? {
        guard let trimmed = text?.trimmingCharacters(in: .whitespacesAndNewlines), !trimmed.isEmpty else {
            return nil
        }
        return trimmed
    }
}
