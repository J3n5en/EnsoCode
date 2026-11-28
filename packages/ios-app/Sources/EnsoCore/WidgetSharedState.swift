import Foundation
#if canImport(ActivityKit) && !os(macOS)
import ActivityKit
#endif

/// 小组件与灵动岛展示用的会话精简条目。
public struct EnsoWidgetSessionItem: Codable, Equatable, Hashable, Sendable, Identifiable {
    public let id: String
    public let title: String
    public let projectName: String
    public let status: String
    public let pendingCount: Int
    public let unread: Bool
    public let updatedAt: Double

    public init(
        id: String,
        title: String,
        projectName: String,
        status: String,
        pendingCount: Int,
        unread: Bool,
        updatedAt: Double
    ) {
        self.id = id
        self.title = title
        self.projectName = projectName
        self.status = status
        self.pendingCount = pendingCount
        self.unread = unread
        self.updatedAt = updatedAt
    }
}

/// 主 App、NotificationServiceExtension 与 WidgetExtension 通过 App Group 共享的实时快照。
public struct EnsoWidgetSnapshot: Codable, Equatable, Sendable {
    public let deviceLabel: String
    public let connectionState: String
    public let transport: String
    public let rttMs: Int?
    public let runningCount: Int
    public let pendingCount: Int
    public let unreadCount: Int
    public let activeTitle: String?
    public let activeProject: String?
    public let activeSessionId: String?
    public let activeStatus: String
    public let activeDetail: String?
    public let startedAt: Double?
    public let sessions: [EnsoWidgetSessionItem]
    public let updatedAt: Double

    public init(
        deviceLabel: String,
        connectionState: String,
        transport: String,
        rttMs: Int?,
        runningCount: Int,
        pendingCount: Int,
        unreadCount: Int,
        activeTitle: String?,
        activeProject: String?,
        activeSessionId: String?,
        activeStatus: String,
        activeDetail: String?,
        startedAt: Double?,
        sessions: [EnsoWidgetSessionItem],
        updatedAt: Double
    ) {
        self.deviceLabel = deviceLabel
        self.connectionState = connectionState
        self.transport = transport
        self.rttMs = rttMs
        self.runningCount = runningCount
        self.pendingCount = pendingCount
        self.unreadCount = unreadCount
        self.activeTitle = activeTitle
        self.activeProject = activeProject
        self.activeSessionId = activeSessionId
        self.activeStatus = activeStatus
        self.activeDetail = activeDetail
        self.startedAt = startedAt
        self.sessions = sessions
        self.updatedAt = updatedAt
    }

    public static let placeholder = EnsoWidgetSnapshot(
        deviceLabel: "EnsoCode",
        connectionState: "offline",
        transport: "",
        rttMs: nil,
        runningCount: 0,
        pendingCount: 0,
        unreadCount: 0,
        activeTitle: nil,
        activeProject: nil,
        activeSessionId: nil,
        activeStatus: "idle",
        activeDetail: "打开 EnsoCode 连接桌面端",
        startedAt: nil,
        sessions: [],
        updatedAt: 0
    )

    /// 构造点击跳转到指定会话（或默认首页）的 `enso://` 深链。
    public static func deepLinkURL(sessionId: String?) -> URL {
        if let sessionId, !sessionId.isEmpty {
            var comps = URLComponents()
            comps.scheme = "enso"
            comps.host = "open"
            comps.queryItems = [URLQueryItem(name: "session", value: sessionId)]
            if let url = comps.url {
                return url
            }
        }
        return URL(string: "enso://open")!
    }
}

/// 跨主 App、NSE、Widgets 共享的 App Group 快照读写仓。
public final class SharedWidgetStore: @unchecked Sendable {
    public static let appGroupId = "group.com.j3n5en.ensocode"
    public static let fileName = "enso-widget-state.json"

    public static let shared = SharedWidgetStore()

    private let directoryOverride: URL?
    private let fileManager: FileManager

    public init(directory: URL? = nil, fileManager: FileManager = .default) {
        self.directoryOverride = directory
        self.fileManager = fileManager
    }

    private func stateFileURL() -> URL? {
        if let dir = directoryOverride {
            return dir.appendingPathComponent(Self.fileName)
        }
        guard let container = fileManager.containerURL(
            forSecurityApplicationGroupIdentifier: Self.appGroupId
        ) else {
            return nil
        }
        return container.appendingPathComponent(Self.fileName)
    }

    public func load() -> EnsoWidgetSnapshot? {
        guard let url = stateFileURL(),
              let data = try? Data(contentsOf: url)
        else { return nil }
        return try? JSONDecoder().decode(EnsoWidgetSnapshot.self, from: data)
    }

    @discardableResult
    public func save(_ snapshot: EnsoWidgetSnapshot) -> Bool {
        guard let url = stateFileURL() else { return false }
        let dir = url.deletingLastPathComponent()
        try? fileManager.createDirectory(at: dir, withIntermediateDirectories: true)
        guard let data = try? JSONEncoder().encode(snapshot) else { return false }
        do {
            try data.write(to: url, options: .atomic)
            return true
        } catch {
            return false
        }
    }

    /// 后台 NSE 本地解密 APNs 推送后直接合入小组件快照，即使主 App 被系统挂起也能实时刷新桌面/锁屏小组件。
    @discardableResult
    public func mergePushNotification(
        title: String,
        body: String,
        sessionId: String,
        pending: Bool,
        nowMs: Double = Date().timeIntervalSince1970 * 1000
    ) -> EnsoWidgetSnapshot {
        let prev = load() ?? .placeholder
        var nextSessions = prev.sessions
        let cleanTitle = title.trimmingCharacters(in: .whitespacesAndNewlines)
        let cleanBody = body.trimmingCharacters(in: .whitespacesAndNewlines)
        let displayTitle = cleanTitle.isEmpty ? "EnsoCode" : cleanTitle

        if let idx = nextSessions.firstIndex(where: { $0.id == sessionId }) {
            let old = nextSessions[idx]
            let updated = EnsoWidgetSessionItem(
                id: old.id,
                title: old.title.isEmpty ? displayTitle : old.title,
                projectName: old.projectName,
                status: pending ? "waiting" : "idle",
                pendingCount: pending ? max(1, old.pendingCount) : old.pendingCount,
                unread: true,
                updatedAt: nowMs
            )
            nextSessions.remove(at: idx)
            nextSessions.insert(updated, at: 0)
        } else if !sessionId.isEmpty {
            let item = EnsoWidgetSessionItem(
                id: sessionId,
                title: displayTitle,
                projectName: prev.deviceLabel,
                status: pending ? "waiting" : "idle",
                pendingCount: pending ? 1 : 0,
                unread: true,
                updatedAt: nowMs
            )
            nextSessions.insert(item, at: 0)
            if nextSessions.count > 6 {
                nextSessions = Array(nextSessions.prefix(6))
            }
        }

        let pendingCount = max(
            pending ? 1 : 0,
            nextSessions.reduce(0) { $0 + $1.pendingCount }
        )
        let unreadCount = max(
            1,
            nextSessions.reduce(0) { $0 + ($1.unread ? 1 : 0) }
        )
        let runningCount = pending ? max(0, prev.runningCount) : max(0, prev.runningCount - 1)

        let merged = EnsoWidgetSnapshot(
            deviceLabel: prev.deviceLabel,
            connectionState: prev.connectionState == "offline" ? "online" : prev.connectionState,
            transport: prev.transport,
            rttMs: prev.rttMs,
            runningCount: runningCount,
            pendingCount: pendingCount,
            unreadCount: unreadCount,
            activeTitle: displayTitle,
            activeProject: nextSessions.first?.projectName ?? prev.activeProject,
            activeSessionId: sessionId.isEmpty ? prev.activeSessionId : sessionId,
            activeStatus: pending ? "pending" : (runningCount > 0 ? "running" : "idle"),
            activeDetail: cleanBody.isEmpty ? (pending ? "等待你的确认" : "有新消息") : cleanBody,
            startedAt: prev.startedAt,
            sessions: nextSessions,
            updatedAt: nowMs
        )
        _ = save(merged)
        return merged
    }
}

#if canImport(ActivityKit) && !os(macOS)
/// iOS 灵动岛与锁屏实时活动（Live Activity）的共享状态契约。
@available(iOS 16.1, *)
public struct EnsoSessionActivityAttributes: ActivityAttributes {
    public struct ContentState: Codable, Hashable, Sendable {
        /// "running" | "pending" | "done" | "offline"
        public var status: String
        public var title: String
        public var projectName: String
        public var detail: String
        public var runningCount: Int
        public var pendingCount: Int
        public var startedAt: Date

        public init(
            status: String,
            title: String,
            projectName: String,
            detail: String,
            runningCount: Int,
            pendingCount: Int,
            startedAt: Date
        ) {
            self.status = status
            self.title = title
            self.projectName = projectName
            self.detail = detail
            self.runningCount = runningCount
            self.pendingCount = pendingCount
            self.startedAt = startedAt
        }
    }

    public var sessionId: String
    public var deviceLabel: String

    public init(sessionId: String, deviceLabel: String) {
        self.sessionId = sessionId
        self.deviceLabel = deviceLabel
    }
}
#endif
