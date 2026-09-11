import Combine
import Network
import SwiftUI
import UserNotifications

@MainActor
final class AppModel: ObservableObject {
  @Published var devices: [StoredDevice]
  @Published var activeDeviceId: String?
  @Published var adding = false
  @Published var pendingInvite: String?
  @Published var state: ConnState = .connecting
  @Published var catalog: [CatalogEntry] = []
  @Published var pinnedOrder: [String] = []
  @Published var projects: [ProjectEntry] = []
  @Published var projectGroups: [ProjectGroupEntry] = []
  @Published var providers: [ProviderEntry] = []
  @Published var activeId: String?
  @Published var view: GuestSessionView?
  @Published var syncing = false
  @Published var historyPending = Set<String>()
  @Published var okFlash = false
  @Published var drawerOpen = false
  @Published var composing = false
  @Published var composeProjectId: String?
  @Published var configOpen = false
  @Published var pushEnabled: Bool
  @Published var pushBusy = false
  @Published var pushError: String?
  @Published var pushConfigReady = false
  @Published var themePreference: ThemePreference
  @Published var hostTheme: HostAppearance = .system
  @Published var terminal: TerminalPalette?
  @Published var compactReadOnlyTools = true
  @Published var bannerTick = 0

  private var client: PairClient?
  private var freshIds = Set<String>()
  private var okFlashWork: DispatchWorkItem?
  private var prevBanner: String?
  private var pathMonitor: NWPathMonitor?
  private var networkIdentity: NetworkIdentity?

  var device: StoredDevice? { DeviceList.pickActive(devices, activeId: activeDeviceId) }

  var connectionLabel: String { state.label }

  var banner: (label: String, tone: String)? {
    if state != .online && state != .unauthorized {
      return (state.label, "progress")
    }
    if state == .online && syncing && activeId != nil {
      return ("同步中…", "progress")
    }
    if okFlash { return ("已是最新", "ok") }
    return nil
  }

  var canCreate: Bool { state == .online && !projects.isEmpty }
  var entry: CatalogEntry? { catalog.first(where: { $0.id == activeId }) }
  var tabGroup: (parent: CatalogEntry, children: [CatalogEntry])? {
    guard let entry else { return nil }
    let parent = entry.parentId.flatMap { pid in catalog.first(where: { $0.id == pid }) } ?? entry
    let children = catalog.filter { $0.parentId == parent.id }
    return children.isEmpty ? nil : (parent, children)
  }
  var configurable: Bool { entry != nil && entry?.parentId == nil }
  var modelLabel: String? {
    guard configurable, let entry, state == .online else { return nil }
    if let p = providers.first(where: { $0.id == entry.providerId }),
      let m = p.models.first(where: { $0.id == entry.modelId })
    {
      return m.display
    }
    return entry.modelId ?? "选择模型"
  }

  var palette: EnsoPalette {
    ThemeResolver.resolve(
      preference: themePreference,
      host: hostTheme,
      terminal: terminal,
      systemDark: UITraitCollection.current.userInterfaceStyle == .dark
    )
  }

  init() {
    let devices = DeviceStore.loadDevices()
    self.devices = devices
    self.activeDeviceId = DeviceStore.loadActiveDeviceId()
    self.pushEnabled = DeviceStore.pushEnabled
    self.themePreference = ThemePreference(rawValue: DeviceStore.themePreference) ?? .auto
    let active = DeviceList.pickActive(devices, activeId: self.activeDeviceId)
    self.activeId = active.map { DeviceStore.loadLastSession($0.pairId) } ?? nil
    startPathMonitor()
  }

  func start() {
    reconnectIfNeeded()
  }

  func handleIncomingURL(_ url: URL) {
    let text = url.absoluteString
    guard (try? PairURI.parse(text)) != nil else { return }
    pendingInvite = text
    if !devices.isEmpty { adding = true }
  }

  func reconnectIfNeeded() {
    client?.close()
    client = nil
    guard let device else { return }
    pushConfigReady = false
    historyPending = []
    let pairId = device.pairId
    var events = PairClient.Events()
    events.onState = { [weak self] s in self?.state = s }
    events.onCatalog = { [weak self] entries, order in
      self?.catalog = entries
      self?.pinnedOrder = order
    }
    events.onProjects = { [weak self] next, groups in
      self?.projects = next
      self?.projectGroups = groups
    }
    events.onProviders = { [weak self] p in self?.providers = p }
    events.onSession = { [weak self] id, next in
      guard let self, id == self.activeId else { return }
      self.view = next
      self.notifyIfNeeded(next)
    }
    events.onSync = { [weak self] s in self?.syncing = s == .syncing }
    events.onGhostSession = { [weak self] id in
      if id == self?.activeId { self?.activeId = nil }
    }
    events.onHistoryPending = { [weak self] id, pending in
      guard let self else { return }
      if pending { self.historyPending.insert(id) } else { self.historyPending.remove(id) }
    }
    events.onPushConfig = { [weak self] _ in
      self?.pushConfigReady = true
    }
    events.onAppearance = { [weak self] update in
      self?.hostTheme = update.theme
      self?.terminal = update.terminal
      self?.compactReadOnlyTools = update.compactReadOnlyTools
    }
    let client = PairClient(device: device.credentials, events: events)
    self.client = client
    client.connect()
    client.subscribe(activeId, fresh: activeId.map { freshIds.contains($0) } ?? false)
    if let activeId { view = client.getSession(activeId) }
    DeviceStore.saveLastSession(pairId: pairId, sessionId: activeId)
  }

  func setActiveSession(_ id: String?) {
    activeId = id
    if let id { freshIds.remove(id) }
    client?.subscribe(id, fresh: id.map { freshIds.contains($0) } ?? false)
    view = id.flatMap { client?.getSession($0) }
    if let pairId = device?.pairId { DeviceStore.saveLastSession(pairId: pairId, sessionId: id) }
  }

  func onAppearSelectFirst() {
    if activeId == nil, let first = catalog.first(where: { $0.parentId == nil }) {
      setActiveSession(first.id)
    }
  }

  func updateBannerFlash() {
    let label = banner?.tone == "progress" ? banner?.label : nil
    if prevBanner != nil && label == nil {
      okFlash = true
      okFlashWork?.cancel()
      let work = DispatchWorkItem { [weak self] in self?.okFlash = false }
      okFlashWork = work
      DispatchQueue.main.asyncAfter(deadline: .now() + 1.5, execute: work)
    }
    prevBanner = label
  }

  func addDevice(_ d: PairedDevice) {
    let next = DeviceList.upsert(devices, d)
    devices = next
    DeviceStore.saveDevices(next)
    DeviceStore.saveActiveDeviceId(d.pairId)
    activeDeviceId = d.pairId
    resetHostState(DeviceStore.loadLastSession(d.pairId))
    adding = false
    pendingInvite = nil
    reconnectIfNeeded()
  }

  func switchDevice(_ pairId: String) {
    guard pairId != device?.pairId else { return }
    DeviceStore.saveActiveDeviceId(pairId)
    activeDeviceId = pairId
    state = .connecting
    resetHostState(DeviceStore.loadLastSession(pairId))
    drawerOpen = false
    reconnectIfNeeded()
  }

  func unpairDevice(_ pairId: String) {
    if let target = devices.first(where: { $0.pairId == pairId }) {
      Task { await Handshake.revoke(relayUrl: target.relayUrl, pairId: target.pairId, token: target.token) }
    }
    DeviceStore.clearDeviceData(pairId)
    let next = DeviceList.remove(devices, pairId: pairId)
    devices = next
    DeviceStore.saveDevices(next)
    if pairId == device?.pairId {
      let fallback = DeviceList.pickActive(next, activeId: nil)
      DeviceStore.saveActiveDeviceId(fallback?.pairId)
      activeDeviceId = fallback?.pairId
      if fallback != nil { state = .connecting }
      resetHostState(fallback.map { DeviceStore.loadLastSession($0.pairId) } ?? nil)
      if fallback == nil { drawerOpen = false }
      reconnectIfNeeded()
    }
  }

  func renameDevice(pairId: String, label: String) {
    let next = DeviceList.rename(devices, pairId: pairId, label: label)
    devices = next
    DeviceStore.saveDevices(next)
  }

  func send(_ command: PhoneCommand) { client?.send(command) }

  func sendMessage(text: String, images: [AttachedImage]) {
    guard let activeId else { return }
    send(
      view?.isRunning == true
        ? .enqueue(sessionId: activeId, text: text, images: images.isEmpty ? nil : images)
        : .prompt(sessionId: activeId, text: text, images: images.isEmpty ? nil : images)
    )
  }

  func spawn(_ req: NewSessionRequest) {
    let sessionId = UUID().uuidString.lowercased()
    send(
      .spawn(
        sessionId: sessionId,
        projectId: req.projectId,
        providerId: req.providerId,
        modelId: req.modelId,
        approvalMode: req.approvalMode,
        reasoningEnabled: req.reasoningEnabled ? true : nil,
        thinkingLevel: req.reasoningEnabled ? req.thinkingLevel : nil
      )
    )
    freshIds.insert(sessionId)
    composing = false
    composeProjectId = nil
    setActiveSession(sessionId)
  }

  func loadOlder() {
    guard let activeId else { return }
    client?.requestHistory(activeId)
  }

  func setTheme(_ pref: ThemePreference) {
    themePreference = pref
    DeviceStore.themePreference = pref.rawValue
  }

  func scenePhase(_ phase: ScenePhase) {
    switch phase {
    case .active:
      client?.nudge(replace: false)
      send(.presence(visible: true))
    case .background, .inactive:
      send(.presence(visible: false))
    @unknown default:
      break
    }
  }

  func togglePush(_ next: Bool) {
    pushError = nil
    if !next {
      DeviceStore.pushEnabled = false
      pushEnabled = false
      send(.pushUnsubscribe)
      return
    }
    pushEnabled = true
    pushBusy = true
    Task {
      let granted = await requestNotificationPermission()
      pushBusy = false
      if !granted {
        pushEnabled = false
        pushError = "通知权限被拒绝，请在系统设置中允许后重试。"
        return
      }
      DeviceStore.pushEnabled = true
    }
  }

  private func requestNotificationPermission() async -> Bool {
    do {
      return try await UNUserNotificationCenter.current().requestAuthorization(options: [.alert, .sound, .badge])
    } catch {
      return false
    }
  }

  private func notifyIfNeeded(_ view: GuestSessionView) {
    guard DeviceStore.pushEnabled else { return }
    let scene = UIApplication.shared.connectedScenes.compactMap { $0 as? UIWindowScene }
    let active = scene.contains { $0.activationState == .foregroundActive }
    if active { return }
    if let approval = view.approvals.last {
      localNotify(title: "需要审批", body: entry?.title ?? approval.tool, sessionId: activeId)
    } else if let ask = view.asks.last {
      localNotify(title: "需要回答", body: ask.question, sessionId: activeId)
    }
  }

  private func localNotify(title: String, body: String, sessionId: String?) {
    let content = UNMutableNotificationContent()
    content.title = title
    content.body = body
    content.sound = .default
    if let sessionId { content.userInfo = ["sessionId": sessionId] }
    let req = UNNotificationRequest(identifier: UUID().uuidString, content: content, trigger: nil)
    UNUserNotificationCenter.current().add(req)
  }

  private func resetHostState(_ nextActiveId: String?) {
    catalog = []
    projects = []
    projectGroups = []
    providers = []
    view = nil
    syncing = false
    activeId = nextActiveId
  }

  private func startPathMonitor() {
    let monitor = NWPathMonitor()
    pathMonitor = monitor
    monitor.pathUpdateHandler = { [weak self] path in
      let next = NetworkIdentity(path)
      DispatchQueue.main.async {
        guard let self else { return }
        if self.networkIdentity == next { return }
        let first = self.networkIdentity == nil
        self.networkIdentity = next
        if first { return }
        if next.online { self.client?.nudge(replace: true) }
      }
    }
    monitor.start(queue: DispatchQueue(label: "enso.path"))
  }
}
