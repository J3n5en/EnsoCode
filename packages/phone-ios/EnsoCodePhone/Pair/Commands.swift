import Foundation

enum PhoneCommand {
  case prompt(sessionId: String, text: String, images: [AttachedImage]?)
  case steer(sessionId: String, text: String, images: [AttachedImage]?)
  case abort(sessionId: String)
  case approvalRespond(sessionId: String, requestId: String, decision: ApprovalDecision)
  case askRespond(sessionId: String, requestId: String, answer: String)
  case snapshot
  case subscribe(sessionId: String?, sinceIndex: Int?)
  case spawn(
    sessionId: String,
    projectId: String,
    providerId: String,
    modelId: String,
    approvalMode: ApprovalMode?,
    reasoningEnabled: Bool?,
    thinkingLevel: ThinkingLevel?
  )
  case setModel(sessionId: String, providerId: String, modelId: String)
  case setReasoning(sessionId: String, enabled: Bool)
  case setThinking(sessionId: String, level: ThinkingLevel)
  case history(sessionId: String, beforeIndex: Int)
  case enqueue(sessionId: String, text: String, images: [AttachedImage]?)
  case queueRemove(sessionId: String, messageId: String)
  case queueUpdate(sessionId: String, messageId: String, text: String)
  case queueSendNow(sessionId: String, messageId: String)
  case queueInterruptSend(sessionId: String, messageId: String)
  case pushSubscribe(endpoint: String, p256dh: String, auth: String)
  case pushUnsubscribe
  case presence(visible: Bool)

  func json() -> [String: Any] {
    switch self {
    case .prompt(let sessionId, let text, let images):
      return withImages(["type": "prompt", "sessionId": sessionId, "text": text], images)
    case .steer(let sessionId, let text, let images):
      return withImages(["type": "steer", "sessionId": sessionId, "text": text], images)
    case .abort(let sessionId):
      return ["type": "abort", "sessionId": sessionId]
    case .approvalRespond(let sessionId, let requestId, let decision):
      return [
        "type": "approval-respond", "sessionId": sessionId, "requestId": requestId, "decision": decision.rawValue,
      ]
    case .askRespond(let sessionId, let requestId, let answer):
      return ["type": "ask-respond", "sessionId": sessionId, "requestId": requestId, "answer": answer]
    case .snapshot:
      return ["type": "snapshot"]
    case .subscribe(let sessionId, let sinceIndex):
      var obj: [String: Any] = ["type": "subscribe", "sessionId": sessionId ?? NSNull()]
      if let sinceIndex { obj["sinceIndex"] = sinceIndex }
      return obj
    case .spawn(let sessionId, let projectId, let providerId, let modelId, let approvalMode, let reasoningEnabled, let thinkingLevel):
      var obj: [String: Any] = [
        "type": "spawn",
        "sessionId": sessionId,
        "projectId": projectId,
        "providerId": providerId,
        "modelId": modelId,
      ]
      if let approvalMode { obj["approvalMode"] = approvalMode.rawValue }
      if let reasoningEnabled { obj["reasoningEnabled"] = reasoningEnabled }
      if let thinkingLevel { obj["thinkingLevel"] = thinkingLevel.rawValue }
      return obj
    case .setModel(let sessionId, let providerId, let modelId):
      return ["type": "set-model", "sessionId": sessionId, "providerId": providerId, "modelId": modelId]
    case .setReasoning(let sessionId, let enabled):
      return ["type": "set-reasoning", "sessionId": sessionId, "enabled": enabled]
    case .setThinking(let sessionId, let level):
      return ["type": "set-thinking", "sessionId": sessionId, "level": level.rawValue]
    case .history(let sessionId, let beforeIndex):
      return ["type": "history", "sessionId": sessionId, "beforeIndex": beforeIndex]
    case .enqueue(let sessionId, let text, let images):
      return withImages(["type": "enqueue", "sessionId": sessionId, "text": text], images)
    case .queueRemove(let sessionId, let messageId):
      return ["type": "queue-remove", "sessionId": sessionId, "messageId": messageId]
    case .queueUpdate(let sessionId, let messageId, let text):
      return ["type": "queue-update", "sessionId": sessionId, "messageId": messageId, "text": text]
    case .queueSendNow(let sessionId, let messageId):
      return ["type": "queue-send-now", "sessionId": sessionId, "messageId": messageId]
    case .queueInterruptSend(let sessionId, let messageId):
      return ["type": "queue-interrupt-send", "sessionId": sessionId, "messageId": messageId]
    case .pushSubscribe(let endpoint, let p256dh, let auth):
      return [
        "type": "push-subscribe",
        "subscription": ["endpoint": endpoint, "keys": ["p256dh": p256dh, "auth": auth]],
      ]
    case .pushUnsubscribe:
      return ["type": "push-unsubscribe"]
    case .presence(let visible):
      return ["type": "presence", "visible": visible]
    }
  }

  private func withImages(_ base: [String: Any], _ images: [AttachedImage]?) -> [String: Any] {
    var obj = base
    if let images, !images.isEmpty { obj["images"] = images.map { $0.json() } }
    return obj
  }
}

struct AppearanceUpdate {
  var theme: HostAppearance
  var terminal: TerminalPalette?
  var compactReadOnlyTools: Bool
  var expandLiveEdits: Bool
}
