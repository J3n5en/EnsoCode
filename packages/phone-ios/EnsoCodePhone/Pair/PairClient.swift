import Foundation

final class PairClient: NSObject, URLSessionWebSocketDelegate {
  struct Events {
    var onState: (ConnState) -> Void = { _ in }
    var onCatalog: ([CatalogEntry], [String]) -> Void = { _, _ in }
    var onProjects: ([ProjectEntry], [ProjectGroupEntry]) -> Void = { _, _ in }
    var onProviders: ([ProviderEntry]) -> Void = { _ in }
    var onSession: (String, GuestSessionView) -> Void = { _, _ in }
    var onPushConfig: (String) -> Void = { _ in }
    var onSync: (SyncState) -> Void = { _ in }
    var onGhostSession: (String) -> Void = { _ in }
    var onHistoryPending: (String, Bool) -> Void = { _, _ in }
    var onAppearance: (AppearanceUpdate) -> Void = { _ in }
  }

  private let device: PairedDevice
  private let contentKey: Data
  private var events: Events
  private var ws: URLSessionWebSocketTask?
  private var session: URLSession?
  private var attempt = 0
  private var reconnectWork: DispatchWorkItem?
  private var closed = false
  private var revoked = false
  private var subscribedId: String?
  private var sessions: [String: GuestSessionView] = [:]
  private var historyPending = Set<String>()
  private var sync = SyncTracking()
  private var heartbeatTimer: DispatchSourceTimer?
  private var heartbeatDeadline: DispatchWorkItem?
  private var listenGeneration = 0
  private var socketSettled = true
  private var replacePending = false
  private let queue = DispatchQueue(label: "enso.pair.client")

  init(device: PairedDevice, events: Events) {
    self.device = device
    self.events = events
    self.contentKey = Base64URL.decode(device.contentKey) ?? Data()
    super.init()
  }

  func connect() {
    queue.async { [weak self] in self?.connectLocked() }
  }

  func close() {
    queue.async { [weak self] in
      guard let self else { return }
      self.closed = true
      self.reconnectWork?.cancel()
      self.stopHeartbeat()
      self.ws?.cancel(with: .goingAway, reason: nil)
      self.ws = nil
      self.session?.invalidateAndCancel()
      self.session = nil
    }
  }

  func nudge(replace: Bool) {
    queue.async { [weak self] in
      guard let self, !self.closed, !self.revoked else { return }
      if replace {
        self.attempt = 0
        self.reconnectWork?.cancel()
        if self.ws != nil {
          self.replacePending = true
          self.ws?.cancel(with: .goingAway, reason: nil)
        } else {
          self.connectLocked()
        }
        return
      }
      self.probe()
    }
  }

  func send(_ command: PhoneCommand) {
    queue.async { [weak self] in
      guard let self else { return }
      if self.ws?.state != .running { return }
      self.sendSealed(command.json())
    }
  }

  func subscribe(_ sessionId: String?, fresh: Bool = false) {
    queue.async { [weak self] in
      guard let self else { return }
      self.subscribedId = sessionId
      if !self.historyPending.isEmpty {
        let pending = self.historyPending
        self.historyPending.removeAll()
        for id in pending { self.emit { $0.onHistoryPending(id, false) } }
      }
      self.setSync(SyncProjection.applySubscribe(self.sync, sessionId: sessionId, fresh: fresh))
      if sessionId == nil {
        self.sendSealed(PhoneCommand.subscribe(sessionId: nil, sinceIndex: nil).json())
        return
      }
      let since = DeviceStore.loadCursors(self.device.pairId)[sessionId!]
      self.sendSealed(PhoneCommand.subscribe(sessionId: sessionId, sinceIndex: since).json())
    }
  }

  func getSession(_ sessionId: String) -> GuestSessionView? {
    queue.sync { sessions[sessionId] }
  }

  func hasOlder(_ sessionId: String) -> Bool {
    queue.sync {
      guard let view = sessions[sessionId], !view.messages.isEmpty, let min = view.messages.keys.min() else {
        return false
      }
      return min > 0
    }
  }

  func requestHistory(_ sessionId: String) {
    queue.async { [weak self] in
      guard let self else { return }
      guard !self.historyPending.contains(sessionId), self.hasOlderLocked(sessionId),
        let view = self.sessions[sessionId], let min = view.messages.keys.min()
      else { return }
      self.historyPending.insert(sessionId)
      self.emit { $0.onHistoryPending(sessionId, true) }
      self.sendSealed(PhoneCommand.history(sessionId: sessionId, beforeIndex: min).json())
    }
  }

  private func hasOlderLocked(_ sessionId: String) -> Bool {
    guard let view = sessions[sessionId], !view.messages.isEmpty, let min = view.messages.keys.min() else {
      return false
    }
    return min > 0
  }

  private func connectLocked() {
    if closed { return }
    dropSocket(settle: true)
    socketSettled = false
    emit { $0.onState(.connecting) }
    let base = RelayURL.webSocket(device.relayUrl)
    let pair = device.pairId.addingPercentEncoding(withAllowedCharacters: .urlPathAllowed) ?? device.pairId
    let token = device.token.addingPercentEncoding(withAllowedCharacters: .urlQueryAllowed) ?? device.token
    guard let url = URL(string: "\(base)/v1/pair/\(pair)?role=guest&token=\(token)") else {
      scheduleReconnect()
      return
    }
    listenGeneration += 1
    let gen = listenGeneration
    let config = URLSessionConfiguration.default
    config.waitsForConnectivity = true
    let sess = URLSession(configuration: config, delegate: self, delegateQueue: nil)
    session = sess
    let task = sess.webSocketTask(with: url)
    ws = task
    task.resume()
    listen(gen)
  }

  func urlSession(
    _ session: URLSession,
    webSocketTask: URLSessionWebSocketTask,
    didOpenWithProtocol protocol: String?
  ) {
    queue.async { [weak self] in
      guard let self, webSocketTask === self.ws else { return }
      self.attempt = 0
      self.startHeartbeat()
      self.sendSealed(PhoneCommand.snapshot.json())
      if let id = self.subscribedId { self.subscribeLocked(id) }
    }
  }

  func urlSession(
    _ session: URLSession,
    webSocketTask: URLSessionWebSocketTask,
    didCloseWith closeCode: URLSessionWebSocketTask.CloseCode,
    reason: Data?
  ) {
    queue.async { [weak self] in
      guard let self, webSocketTask === self.ws else { return }
      self.handleClosed(code: closeCode)
    }
  }

  private func subscribeLocked(_ sessionId: String) {
    let since = DeviceStore.loadCursors(device.pairId)[sessionId]
    sendSealed(PhoneCommand.subscribe(sessionId: sessionId, sinceIndex: since).json())
  }

  private func listen(_ gen: Int) {
    ws?.receive { [weak self] result in
      guard let self else { return }
      self.queue.async {
        guard gen == self.listenGeneration, let ws = self.ws else { return }
        self.alive()
        switch result {
        case .success(let message):
          self.handleMessage(message)
          self.listen(gen)
        case .failure:
          if gen == self.listenGeneration {
            self.handleClosed(code: .abnormalClosure)
          }
        }
      }
    }
  }

  private func handleMessage(_ message: URLSessionWebSocketTask.Message) {
    switch message {
    case .string(let text):
      if text == "pong" { return }
      guard let data = text.data(using: .utf8), let obj = JSONUtil.object(data) else { return }
      switch JSONUtil.string(obj["type"]) {
      case "host-online":
        emit { $0.onState(.online) }
        sendSealed(PhoneCommand.snapshot.json())
        if let id = subscribedId { subscribeLocked(id) }
      case "host-offline":
        emit { $0.onState(.hostOffline) }
      case "revoked":
        revoked = true
        emit { $0.onState(.unauthorized) }
        stopHeartbeat()
        ws?.cancel(with: .policyViolation, reason: nil)
      default:
        break
      }
    case .data(let data):
      handleFrame(data)
    @unknown default:
      break
    }
  }

  private func handleFrame(_ frame: Data) {
    let payload: Any
    do { payload = try PairCrypto.openFrame(contentKey: contentKey, frame: frame) } catch { return }
    guard let obj = JSONUtil.dict(payload), let type = JSONUtil.string(obj["type"]) else { return }
    switch type {
    case "catalog":
      let entries = (JSONUtil.array(obj["entries"]) ?? []).compactMap { JSONUtil.dict($0).flatMap(CatalogEntry.parse) }
      let (tracking, ghost) = SyncProjection.applyCatalog(
        sync,
        subscribedId: subscribedId,
        catalogIds: entries.map(\.id)
      )
      let ghostId = ghost ? subscribedId : nil
      setSync(tracking)
      if let ghostId { emit { $0.onGhostSession(ghostId) } }
      emit { $0.onCatalog(entries, JSONUtil.stringArray(obj["pinnedOrder"]) ?? []) }
    case "projects":
      let projects = (JSONUtil.array(obj["projects"]) ?? []).compactMap { JSONUtil.dict($0).flatMap(ProjectEntry.parse) }
      let groups = (JSONUtil.array(obj["groups"]) ?? []).compactMap { JSONUtil.dict($0).flatMap(ProjectGroupEntry.parse) }
      emit { $0.onProjects(projects, groups) }
    case "providers":
      let providers = (JSONUtil.array(obj["providers"]) ?? []).compactMap {
        JSONUtil.dict($0).flatMap(ProviderEntry.parse)
      }
      emit { $0.onProviders(providers) }
    case "appearance":
      let theme = JSONUtil.string(obj["theme"]).flatMap(HostAppearance.init(rawValue:)) ?? .system
      emit {
        $0.onAppearance(
          AppearanceUpdate(
            theme: theme,
            terminal: JSONUtil.dict(obj["terminal"]).flatMap(TerminalPalette.parse),
            compactReadOnlyTools: JSONUtil.bool(obj["compactReadOnlyTools"]) ?? true,
            expandLiveEdits: JSONUtil.bool(obj["expandLiveEdits"]) ?? true
          )
        )
      }
    case "agent-event":
      if let event = JSONUtil.dict(obj["event"]) { applyAgentEvent(event) }
    case "push-config":
      if let key = JSONUtil.string(obj["vapidPublicKey"]) { emit { $0.onPushConfig(key) } }
    case "history":
      guard let sessionId = JSONUtil.string(obj["sessionId"]) else { break }
      historyPending.remove(sessionId)
      emit { $0.onHistoryPending(sessionId, false) }
      guard let view = sessions[sessionId] else { break }
      let next = GuestProjection.applyHistory(
        view,
        baseIndex: JSONUtil.int(obj["baseIndex"]) ?? 0,
        messages: JSONUtil.array(obj["messages"]) ?? []
      )
      sessions[sessionId] = next
      emit { $0.onSession(sessionId, next) }
    default:
      break
    }
  }

  private func applyAgentEvent(_ event: [String: Any]) {
    let type = JSONUtil.string(event["type"])
    if type == "worker-exited" {
      sessions = GuestProjection.markAllFailed(sessions)
      for (id, view) in sessions { emit { $0.onSession(id, view) } }
      return
    }
    if type == "snapshot" {
      let snapshotIds = (JSONUtil.array(event["sessions"]) ?? []).compactMap { item -> String? in
        guard let d = JSONUtil.dict(item) else { return nil }
        return JSONUtil.string(d["sessionId"]) ?? JSONUtil.string(JSONUtil.dict(d["identity"])?["sessionId"])
      }
      setSync(SyncProjection.applySnapshot(sync, subscribedId: subscribedId, snapshotIds: snapshotIds))
      for result in GuestProjection.applySnapshot(sessions: sessions, event: event) {
        if let last = result.lastIndex { DeviceStore.saveCursor(pairId: device.pairId, sessionId: result.id, index: last) }
        sessions[result.id] = result.view
        emit { $0.onSession(result.id, result.view) }
      }
      return
    }
    guard let sessionId = JSONUtil.string(event["sessionId"]) else { return }
    let result = GuestProjection.applyEvent(sessions[sessionId] ?? GuestSessionView(), event: event)
    if let last = result.lastIndex { DeviceStore.saveCursor(pairId: device.pairId, sessionId: sessionId, index: last) }
    sessions[sessionId] = result.view
    emit { $0.onSession(sessionId, result.view) }
  }

  private func sendSealed(_ payload: [String: Any]) {
    guard let frame = try? PairCrypto.sealFrame(contentKey: contentKey, payload: payload) else { return }
    guard let ws, ws.state == .running else { return }
    ws.send(.data(frame)) { _ in }
  }

  private func dropSocket(settle: Bool) {
    if settle { socketSettled = true }
    listenGeneration += 1
    stopHeartbeat()
    ws?.cancel(with: .goingAway, reason: nil)
    ws = nil
    session?.invalidateAndCancel()
    session = nil
  }

  private func handleClosed(code: URLSessionWebSocketTask.CloseCode) {
    if socketSettled { return }
    socketSettled = true
    stopHeartbeat()
    ws = nil
    session?.invalidateAndCancel()
    session = nil
    if code == .policyViolation || revoked {
      revoked = true
      replacePending = false
      emit { $0.onState(.unauthorized) }
      return
    }
    if replacePending {
      replacePending = false
      connectLocked()
      return
    }
    emit { $0.onState(.offline) }
    scheduleReconnect()
  }

  private func scheduleReconnect() {
    if closed || revoked { return }
    reconnectWork?.cancel()
    let delay = RelayURL.backoffDelay(attempt: attempt)
    attempt += 1
    let work = DispatchWorkItem { [weak self] in self?.connectLocked() }
    reconnectWork = work
    queue.asyncAfter(deadline: .now() + delay, execute: work)
  }

  private func startHeartbeat() {
    stopHeartbeat()
    let timer = DispatchSource.makeTimerSource(queue: queue)
    timer.schedule(deadline: .now() + 25, repeating: 25)
    timer.setEventHandler { [weak self] in self?.probe() }
    heartbeatTimer = timer
    timer.resume()
  }

  private func stopHeartbeat() {
    heartbeatTimer?.cancel()
    heartbeatTimer = nil
    alive()
  }

  private func probe() {
    guard let ws, ws.state == .running else { return }
    ws.send(.string("ping")) { _ in }
    ws.sendPing { [weak self] error in
      guard error == nil else { return }
      self?.queue.async { self?.alive() }
    }
    guard heartbeatDeadline == nil else { return }
    let work = DispatchWorkItem { [weak self] in
      self?.heartbeatDeadline = nil
      self?.handleClosed(code: .abnormalClosure)
    }
    heartbeatDeadline = work
    queue.asyncAfter(deadline: .now() + 10, execute: work)
  }

  private func alive() {
    heartbeatDeadline?.cancel()
    heartbeatDeadline = nil
  }

  private func setSync(_ next: SyncTracking) {
    let changed = next.state != sync.state
    sync = next
    if changed { emit { $0.onSync(next.state) } }
  }

  private func emit(_ body: @escaping (Events) -> Void) {
    let events = self.events
    DispatchQueue.main.async { body(events) }
  }
}
