import Foundation

/// 画中画（PiP）实时对话窗口中的一条消息，由前端 `window.__ensoNative.updatePipState(snapshot)` 推送。
public struct EnsoPiPMessage: Codable, Equatable, Hashable, Sendable, Identifiable {
    public let id: String
    /// "user" | "assistant" | "tool" | "system"
    public let role: String
    public let text: String
    public let toolName: String?
    public let isStreaming: Bool
    public let isError: Bool
    public let timestamp: Double

    public init(
        id: String,
        role: String,
        text: String,
        toolName: String? = nil,
        isStreaming: Bool = false,
        isError: Bool = false,
        timestamp: Double
    ) {
        self.id = id
        self.role = role
        self.text = text
        self.toolName = toolName
        self.isStreaming = isStreaming
        self.isError = isError
        self.timestamp = timestamp
    }

    private enum CodingKeys: String, CodingKey {
        case id, role, text, toolName, isStreaming, isError, timestamp
    }

    /// 前端 JSON 是外部输入：除 `id` 外缺省或为 null 的字段都回落到安全默认值。
    public init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        id = try c.decode(String.self, forKey: .id)
        role = try c.decodeIfPresent(String.self, forKey: .role) ?? "assistant"
        text = try c.decodeIfPresent(String.self, forKey: .text) ?? ""
        toolName = try c.decodeIfPresent(String.self, forKey: .toolName)
        isStreaming = try c.decodeIfPresent(Bool.self, forKey: .isStreaming) ?? false
        isError = try c.decodeIfPresent(Bool.self, forKey: .isError) ?? false
        timestamp = try c.decodeIfPresent(Double.self, forKey: .timestamp) ?? 0
    }
}

/// 画中画窗口展示的当前会话快照。
public struct EnsoPiPSnapshot: Codable, Equatable, Sendable {
    public let sessionId: String?
    public let title: String
    public let projectName: String
    /// "running" | "pending" | "idle" | "failed" | "offline"
    public let status: String
    public let pendingHint: String?
    public let runningCount: Int
    public let pendingCount: Int
    public let connectionState: String
    public let messages: [EnsoPiPMessage]
    public let updatedAt: Double

    public init(
        sessionId: String?,
        title: String,
        projectName: String,
        status: String,
        pendingHint: String?,
        runningCount: Int,
        pendingCount: Int,
        connectionState: String,
        messages: [EnsoPiPMessage],
        updatedAt: Double
    ) {
        self.sessionId = sessionId
        self.title = title
        self.projectName = projectName
        self.status = status
        self.pendingHint = pendingHint
        self.runningCount = runningCount
        self.pendingCount = pendingCount
        self.connectionState = connectionState
        self.messages = messages
        self.updatedAt = updatedAt
    }

    private enum CodingKeys: String, CodingKey {
        case sessionId, title, projectName, status, pendingHint, runningCount, pendingCount
        case connectionState, messages, updatedAt
    }

    public init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        sessionId = try c.decodeIfPresent(String.self, forKey: .sessionId)
        title = try c.decodeIfPresent(String.self, forKey: .title) ?? ""
        projectName = try c.decodeIfPresent(String.self, forKey: .projectName) ?? ""
        status = try c.decodeIfPresent(String.self, forKey: .status) ?? "idle"
        pendingHint = try c.decodeIfPresent(String.self, forKey: .pendingHint)
        runningCount = try c.decodeIfPresent(Int.self, forKey: .runningCount) ?? 0
        pendingCount = try c.decodeIfPresent(Int.self, forKey: .pendingCount) ?? 0
        connectionState = try c.decodeIfPresent(String.self, forKey: .connectionState) ?? "offline"
        messages = try c.decodeIfPresent([EnsoPiPMessage].self, forKey: .messages) ?? []
        updatedAt = try c.decodeIfPresent(Double.self, forKey: .updatedAt) ?? 0
    }

    public static let placeholder = EnsoPiPSnapshot(
        sessionId: nil,
        title: "EnsoCode",
        projectName: "",
        status: "idle",
        pendingHint: nil,
        runningCount: 0,
        pendingCount: 0,
        connectionState: "offline",
        messages: [],
        updatedAt: 0
    )

    /// 画中画窗口只有几百点宽：丢弃空白消息、只保留末尾 `maxMessages` 条、截断超长正文与提示。
    public func sanitizedForDisplay(maxMessages: Int = 12, maxTextLength: Int = 600) -> EnsoPiPSnapshot {
        let kept = messages.compactMap { message -> EnsoPiPMessage? in
            let text = Self.truncated(message.text, to: maxTextLength)
            let toolName = Self.nonEmpty(message.toolName)
            if text.isEmpty && toolName == nil && !message.isStreaming { return nil }
            return EnsoPiPMessage(
                id: message.id,
                role: message.role,
                text: text,
                toolName: toolName,
                isStreaming: message.isStreaming,
                isError: message.isError,
                timestamp: message.timestamp
            )
        }
        let cleanTitle = Self.truncated(title, to: 80)
        return EnsoPiPSnapshot(
            sessionId: Self.nonEmpty(sessionId),
            title: cleanTitle.isEmpty ? Self.placeholder.title : cleanTitle,
            projectName: Self.truncated(projectName, to: 60),
            status: status,
            pendingHint: Self.nonEmpty(pendingHint).map { Self.truncated($0, to: 120) },
            runningCount: max(0, runningCount),
            pendingCount: max(0, pendingCount),
            connectionState: connectionState,
            messages: Array(kept.suffix(max(0, maxMessages))),
            updatedAt: updatedAt
        )
    }

    private static func nonEmpty(_ value: String?) -> String? {
        guard let trimmed = value?.trimmingCharacters(in: .whitespacesAndNewlines), !trimmed.isEmpty else {
            return nil
        }
        return trimmed
    }

    /// 按字形簇截断，避免切断 emoji / 组合字符，并在截断处补省略号。
    private static func truncated(_ value: String, to limit: Int) -> String {
        let trimmed = value.trimmingCharacters(in: .whitespacesAndNewlines)
        guard trimmed.count > limit else { return trimmed }
        let head = trimmed.prefix(max(0, limit)).trimmingCharacters(in: .whitespacesAndNewlines)
        return head + "…"
    }
}

/// 原生画中画控制器的显式生命周期状态机。
public enum EnsoPiPLifecyclePhase: String, Equatable, Sendable {
    /// 设备不支持，或尚未挂载到可见窗口
    case unavailable
    case ready
    case starting
    case active
    case stopping
}

/// 通过 `window.__ensoNativeInternal.onPipState(state)` 回推给前端的画中画状态。
public struct EnsoPiPStatusPayload: Codable, Equatable, Sendable {
    public let supported: Bool
    public let active: Bool
    public let auto: Bool
    public let error: String?

    public init(supported: Bool, active: Bool, auto: Bool, error: String?) {
        self.supported = supported
        self.active = active
        self.auto = auto
        self.error = error
    }

    private enum CodingKeys: String, CodingKey {
        case supported, active, auto, error
    }

    /// 始终写出 `error` 键（无错误时为 null），前端拿到的结构稳定。
    public func encode(to encoder: Encoder) throws {
        var c = encoder.container(keyedBy: CodingKeys.self)
        try c.encode(supported, forKey: .supported)
        try c.encode(active, forKey: .active)
        try c.encode(auto, forKey: .auto)
        try c.encode(error, forKey: .error)
    }
}
