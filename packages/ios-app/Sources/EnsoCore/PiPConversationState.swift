import Foundation

/// 画中画窗口的纵横比预设：
/// - `portrait`（默认）：竖屏对话大窗（9:14），同宽度下高度接近横屏的 2.5 倍，最像真实对话区
/// - `square`：近似方形（5:6），兼顾单行宽度与多轮上下文
/// - `landscape`：紧凑横屏（16:10），占用屏幕面积最小
public enum EnsoPiPAspect: String, Codable, Equatable, Hashable, CaseIterable, Sendable {
    case portrait
    case square
    case landscape

    /// 传给 `AVPictureInPictureVideoCallViewController.preferredContentSize` 的逻辑画布尺寸。
    /// 系统 PiP 按该纵横比决定浮窗形状，并允许用户双指缩放；适度更大的画布让 SwiftUI 按对话区密度排版。
    public var preferredContentSize: CGSize {
        switch self {
        case .portrait: return CGSize(width: 300, height: 470)
        case .square: return CGSize(width: 320, height: 370)
        case .landscape: return CGSize(width: 380, height: 245)
        }
    }

    public init(rawOrDefault value: String?) {
        self = value.flatMap(EnsoPiPAspect.init(rawValue:)) ?? .portrait
    }
}

/// 工具折叠组内单步（与桌面 `tool-group` 展开后的单行对齐）。
public struct EnsoPiPToolStep: Codable, Equatable, Hashable, Sendable, Identifiable {
    public let id: String
    public let name: String
    public let summary: String
    /// "running" | "ok" | "error"
    public let state: String
    public let output: String?

    public init(
        id: String,
        name: String,
        summary: String,
        state: String = "ok",
        output: String? = nil
    ) {
        self.id = id
        self.name = name
        self.summary = summary
        self.state = state
        self.output = output
    }

    private enum CodingKeys: String, CodingKey {
        case id, name, summary, state, output
    }

    public init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        id = try c.decode(String.self, forKey: .id)
        name = try c.decodeIfPresent(String.self, forKey: .name) ?? ""
        summary = try c.decodeIfPresent(String.self, forKey: .summary) ?? ""
        state = try c.decodeIfPresent(String.self, forKey: .state) ?? "ok"
        output = try c.decodeIfPresent(String.self, forKey: .output)
    }
}

/// 固定在底部状态区的 Todo 进度摘要（与桌面 `TodoBar` 对齐）。
public struct EnsoPiPTodoSummary: Codable, Equatable, Hashable, Sendable {
    public let done: Int
    public let total: Int
    public let current: String?

    public init(done: Int, total: Int, current: String? = nil) {
        self.done = done
        self.total = total
        self.current = current
    }

    private enum CodingKeys: String, CodingKey {
        case done, total, current
    }

    public init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        done = max(0, try c.decodeIfPresent(Int.self, forKey: .done) ?? 0)
        total = max(0, try c.decodeIfPresent(Int.self, forKey: .total) ?? 0)
        current = try c.decodeIfPresent(String.self, forKey: .current)
    }
}

/// 审批或提问的详情卡片（与桌面 `ApprovalBar` / `AskBar` 对齐）。
public struct EnsoPiPPendingDetail: Codable, Equatable, Hashable, Sendable {
    /// "approval" | "ask"
    public let kind: String
    public let title: String
    public let summary: String?

    public init(kind: String, title: String, summary: String? = nil) {
        self.kind = kind
        self.title = title
        self.summary = summary
    }

    private enum CodingKeys: String, CodingKey {
        case kind, title, summary
    }

    public init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        kind = try c.decodeIfPresent(String.self, forKey: .kind) ?? "approval"
        title = try c.decodeIfPresent(String.self, forKey: .title) ?? ""
        summary = try c.decodeIfPresent(String.self, forKey: .summary)
    }
}

/// 画中画（PiP）实时对话窗口中的一条时间线项，由前端 `window.__ensoNative.updatePipState(snapshot)` 推送。
public struct EnsoPiPMessage: Codable, Equatable, Hashable, Sendable, Identifiable {
    public let id: String
    /// "user" | "assistant" | "thinking" | "tool" | "tool-group" | "system"
    public let role: String
    public let text: String
    public let toolName: String?
    /// "running" | "ok" | "error"（仅 tool / tool-group 有意义）
    public let toolState: String?
    /// 工具出错或关键结果的一行预览
    public let detail: String?
    /// 工具组包含的子步摘要（最多保留尾段若干步）
    public let steps: [EnsoPiPToolStep]?
    /// 折叠工具组总步数
    public let stepCount: Int?
    public let isStreaming: Bool
    public let isError: Bool
    public let timestamp: Double

    public init(
        id: String,
        role: String,
        text: String,
        toolName: String? = nil,
        toolState: String? = nil,
        detail: String? = nil,
        steps: [EnsoPiPToolStep]? = nil,
        stepCount: Int? = nil,
        isStreaming: Bool = false,
        isError: Bool = false,
        timestamp: Double
    ) {
        self.id = id
        self.role = role
        self.text = text
        self.toolName = toolName
        self.toolState = toolState
        self.detail = detail
        self.steps = steps
        self.stepCount = stepCount
        self.isStreaming = isStreaming
        self.isError = isError
        self.timestamp = timestamp
    }

    private enum CodingKeys: String, CodingKey {
        case id, role, text, toolName, toolState, detail, steps, stepCount, isStreaming, isError, timestamp
    }

    /// 前端 JSON 是外部输入：除 `id` 外缺省或为 null 的字段都回落到安全默认值。
    public init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        id = try c.decode(String.self, forKey: .id)
        role = try c.decodeIfPresent(String.self, forKey: .role) ?? "assistant"
        text = try c.decodeIfPresent(String.self, forKey: .text) ?? ""
        toolName = try c.decodeIfPresent(String.self, forKey: .toolName)
        toolState = try c.decodeIfPresent(String.self, forKey: .toolState)
        detail = try c.decodeIfPresent(String.self, forKey: .detail)
        steps = try c.decodeIfPresent([EnsoPiPToolStep].self, forKey: .steps)
        stepCount = try c.decodeIfPresent(Int.self, forKey: .stepCount)
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
    public let pendingDetail: EnsoPiPPendingDetail?
    public let todo: EnsoPiPTodoSummary?
    /// 模型名或上下文占比等一行元信息（如 "claude-opus · 42%"）
    public let meta: String?
    /// "dark" | "light"（跟随页面主题，缺省按 dark）
    public let theme: String?
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
        pendingDetail: EnsoPiPPendingDetail? = nil,
        todo: EnsoPiPTodoSummary? = nil,
        meta: String? = nil,
        theme: String? = nil,
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
        self.pendingDetail = pendingDetail
        self.todo = todo
        self.meta = meta
        self.theme = theme
        self.runningCount = runningCount
        self.pendingCount = pendingCount
        self.connectionState = connectionState
        self.messages = messages
        self.updatedAt = updatedAt
    }

    private enum CodingKeys: String, CodingKey {
        case sessionId, title, projectName, status, pendingHint, pendingDetail, todo, meta, theme
        case runningCount, pendingCount
        case connectionState, messages, updatedAt
    }

    public init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        sessionId = try c.decodeIfPresent(String.self, forKey: .sessionId)
        title = try c.decodeIfPresent(String.self, forKey: .title) ?? ""
        projectName = try c.decodeIfPresent(String.self, forKey: .projectName) ?? ""
        status = try c.decodeIfPresent(String.self, forKey: .status) ?? "idle"
        pendingHint = try c.decodeIfPresent(String.self, forKey: .pendingHint)
        pendingDetail = try c.decodeIfPresent(EnsoPiPPendingDetail.self, forKey: .pendingDetail)
        todo = try c.decodeIfPresent(EnsoPiPTodoSummary.self, forKey: .todo)
        meta = try c.decodeIfPresent(String.self, forKey: .meta)
        theme = try c.decodeIfPresent(String.self, forKey: .theme)
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
        pendingDetail: nil,
        todo: nil,
        meta: nil,
        theme: "dark",
        runningCount: 0,
        pendingCount: 0,
        connectionState: "offline",
        messages: [],
        updatedAt: 0
    )

    /// 竖屏大窗可展示多轮完整对话与工具分组：丢弃空白项、保留末尾 `maxMessages` 条、截断超长正文与提示。
    public func sanitizedForDisplay(maxMessages: Int = 18, maxTextLength: Int = 1400) -> EnsoPiPSnapshot {
        let kept = messages.compactMap { message -> EnsoPiPMessage? in
            let text = Self.truncated(message.text, to: maxTextLength)
            let toolName = Self.nonEmpty(message.toolName)
            let detail = Self.nonEmpty(message.detail).map { Self.truncated($0, to: 220) }
            let cleanedSteps: [EnsoPiPToolStep]? = message.steps.flatMap { raw in
                let mapped = raw.suffix(6).compactMap { step -> EnsoPiPToolStep? in
                    let name = Self.truncated(step.name, to: 48)
                    let summary = Self.truncated(step.summary, to: 120)
                    let output = Self.nonEmpty(step.output).map { Self.truncated($0, to: 140) }
                    if name.isEmpty && summary.isEmpty { return nil }
                    return EnsoPiPToolStep(
                        id: step.id,
                        name: name,
                        summary: summary,
                        state: step.state,
                        output: output
                    )
                }
                return mapped.isEmpty ? nil : mapped
            }
            if text.isEmpty && toolName == nil && cleanedSteps == nil && !message.isStreaming { return nil }
            return EnsoPiPMessage(
                id: message.id,
                role: message.role,
                text: text,
                toolName: toolName,
                toolState: Self.nonEmpty(message.toolState),
                detail: detail,
                steps: cleanedSteps,
                stepCount: message.stepCount.map { max(0, $0) },
                isStreaming: message.isStreaming,
                isError: message.isError,
                timestamp: message.timestamp
            )
        }
        let cleanTitle = Self.truncated(title, to: 80)
        let cleanPendingDetail = pendingDetail.flatMap { pd -> EnsoPiPPendingDetail? in
            let t = Self.truncated(pd.title, to: 90)
            let s = Self.nonEmpty(pd.summary).map { Self.truncated($0, to: 160) }
            if t.isEmpty && s == nil { return nil }
            return EnsoPiPPendingDetail(kind: pd.kind, title: t, summary: s)
        }
        let cleanTodo = todo.flatMap { td -> EnsoPiPTodoSummary? in
            guard td.total > 0 else { return nil }
            return EnsoPiPTodoSummary(
                done: min(td.total, max(0, td.done)),
                total: td.total,
                current: Self.nonEmpty(td.current).map { Self.truncated($0, to: 90) }
            )
        }
        let cleanTheme: String = theme == "light" ? "light" : "dark"
        return EnsoPiPSnapshot(
            sessionId: Self.nonEmpty(sessionId),
            title: cleanTitle.isEmpty ? Self.placeholder.title : cleanTitle,
            projectName: Self.truncated(projectName, to: 60),
            status: status,
            pendingHint: Self.nonEmpty(pendingHint).map { Self.truncated($0, to: 120) },
            pendingDetail: cleanPendingDetail,
            todo: cleanTodo,
            meta: Self.nonEmpty(meta).map { Self.truncated($0, to: 60) },
            theme: cleanTheme,
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
    public let aspect: String
    public let error: String?

    public init(
        supported: Bool,
        active: Bool,
        auto: Bool,
        aspect: String = EnsoPiPAspect.portrait.rawValue,
        error: String?
    ) {
        self.supported = supported
        self.active = active
        self.auto = auto
        self.aspect = aspect
        self.error = error
    }

    private enum CodingKeys: String, CodingKey {
        case supported, active, auto, aspect, error
    }

    public init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        supported = try c.decode(Bool.self, forKey: .supported)
        active = try c.decode(Bool.self, forKey: .active)
        auto = try c.decode(Bool.self, forKey: .auto)
        aspect = try c.decodeIfPresent(String.self, forKey: .aspect) ?? EnsoPiPAspect.portrait.rawValue
        error = try c.decodeIfPresent(String.self, forKey: .error)
    }

    /// 始终写出 `error` 键（无错误时为 null），前端拿到的结构稳定。
    public func encode(to encoder: Encoder) throws {
        var c = encoder.container(keyedBy: CodingKeys.self)
        try c.encode(supported, forKey: .supported)
        try c.encode(active, forKey: .active)
        try c.encode(auto, forKey: .auto)
        try c.encode(aspect, forKey: .aspect)
        try c.encode(error, forKey: .error)
    }
}
