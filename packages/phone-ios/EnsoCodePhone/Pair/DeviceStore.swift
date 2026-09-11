import Foundation
import Security

enum DeviceStore {
  private static let service = "com.j3n5en.enso-code.phone"
  private static let devicesAccount = "devices"
  private static let activeKey = "enso-phone-active-device"
  private static let pushKey = "enso-phone-push"
  private static let themeKey = "enso-phone-theme"
  private static let groupKey = "enso-phone-selected-project-group"

  static func loadDevices() -> [StoredDevice] {
    if let data = keychainGet(devicesAccount),
      let arr = (try? JSONSerialization.jsonObject(with: data)) as? [Any]
    {
      return arr.compactMap { JSONUtil.dict($0).flatMap(StoredDevice.parse) }
    }
    if let raw = UserDefaults.standard.string(forKey: "enso-phone-devices") {
      let list = DeviceList.migrate(listRaw: raw, legacyRaw: UserDefaults.standard.string(forKey: "enso-phone-pairing"))
      saveDevices(list)
      UserDefaults.standard.removeObject(forKey: "enso-phone-devices")
      UserDefaults.standard.removeObject(forKey: "enso-phone-pairing")
      return list
    }
    return []
  }

  static func saveDevices(_ devices: [StoredDevice]) {
    let arr = devices.map { $0.json() }
    if let data = JSONUtil.data(arr) { keychainSet(data, account: devicesAccount) }
  }

  static func loadActiveDeviceId() -> String? {
    UserDefaults.standard.string(forKey: activeKey)
  }

  static func saveActiveDeviceId(_ pairId: String?) {
    if let pairId { UserDefaults.standard.set(pairId, forKey: activeKey) }
    else { UserDefaults.standard.removeObject(forKey: activeKey) }
  }

  static func clearDeviceData(_ pairId: String) {
    UserDefaults.standard.removeObject(forKey: cursorKey(pairId))
    UserDefaults.standard.removeObject(forKey: lastSessionKey(pairId))
  }

  static func loadCursors(_ pairId: String) -> [String: Int] {
    guard let raw = UserDefaults.standard.string(forKey: cursorKey(pairId)),
      let data = raw.data(using: .utf8),
      let obj = JSONUtil.object(data)
    else { return [:] }
    var out: [String: Int] = [:]
    for (k, v) in obj { if let i = JSONUtil.int(v) { out[k] = i } }
    return out
  }

  static func saveCursor(pairId: String, sessionId: String, index: Int) {
    var cursors = loadCursors(pairId)
    if cursors[sessionId] == index { return }
    cursors[sessionId] = index
    if let data = JSONUtil.data(cursors), let raw = String(data: data, encoding: .utf8) {
      UserDefaults.standard.set(raw, forKey: cursorKey(pairId))
    }
  }

  static func loadLastSession(_ pairId: String) -> String? {
    UserDefaults.standard.string(forKey: lastSessionKey(pairId))
  }

  static func saveLastSession(pairId: String, sessionId: String?) {
    if let sessionId { UserDefaults.standard.set(sessionId, forKey: lastSessionKey(pairId)) }
    else { UserDefaults.standard.removeObject(forKey: lastSessionKey(pairId)) }
  }

  static var pushEnabled: Bool {
    get { UserDefaults.standard.string(forKey: pushKey) == "on" }
    set { UserDefaults.standard.set(newValue ? "on" : "off", forKey: pushKey) }
  }

  static var themePreference: String {
    get { UserDefaults.standard.string(forKey: themeKey) ?? "auto" }
    set {
      if newValue == "auto" { UserDefaults.standard.removeObject(forKey: themeKey) }
      else { UserDefaults.standard.set(newValue, forKey: themeKey) }
    }
  }

  static var selectedGroupId: String {
    get { UserDefaults.standard.string(forKey: groupKey) ?? ProjectGroups.allId }
    set { UserDefaults.standard.set(newValue, forKey: groupKey) }
  }

  private static func cursorKey(_ pairId: String) -> String { "enso-phone-cursors:\(pairId)" }
  private static func lastSessionKey(_ pairId: String) -> String { "enso-phone-last-session:\(pairId)" }

  private static func keychainSet(_ data: Data, account: String) {
    let query: [String: Any] = [
      kSecClass as String: kSecClassGenericPassword,
      kSecAttrService as String: service,
      kSecAttrAccount as String: account,
    ]
    SecItemDelete(query as CFDictionary)
    var add = query
    add[kSecValueData as String] = data
    add[kSecAttrAccessible as String] = kSecAttrAccessibleAfterFirstUnlockThisDeviceOnly
    SecItemAdd(add as CFDictionary, nil)
  }

  private static func keychainGet(_ account: String) -> Data? {
    let query: [String: Any] = [
      kSecClass as String: kSecClassGenericPassword,
      kSecAttrService as String: service,
      kSecAttrAccount as String: account,
      kSecReturnData as String: true,
      kSecMatchLimit as String: kSecMatchLimitOne,
    ]
    var out: AnyObject?
    let status = SecItemCopyMatching(query as CFDictionary, &out)
    guard status == errSecSuccess else { return nil }
    return out as? Data
  }
}
