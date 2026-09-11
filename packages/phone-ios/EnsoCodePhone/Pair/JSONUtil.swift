import Foundation

enum JSONUtil {
  static func object(_ data: Data) -> [String: Any]? {
    (try? JSONSerialization.jsonObject(with: data)) as? [String: Any]
  }

  static func any(_ data: Data) -> Any? {
    try? JSONSerialization.jsonObject(with: data, options: [.fragmentsAllowed])
  }

  static func data(_ value: Any) -> Data? {
    guard JSONSerialization.isValidJSONObject(value) || value is NSNull || value is String
      || value is NSNumber
    else { return nil }
    return try? JSONSerialization.data(withJSONObject: value, options: [.fragmentsAllowed])
  }

  static func string(_ value: Any?) -> String? {
    value as? String
  }

  static func bool(_ value: Any?) -> Bool? {
    if let b = value as? Bool { return b }
    if let n = value as? NSNumber { return n.boolValue }
    return nil
  }

  static func int(_ value: Any?) -> Int? {
    if let i = value as? Int { return i }
    if let n = value as? NSNumber { return n.intValue }
    if let d = value as? Double { return Int(d) }
    return nil
  }

  static func int64(_ value: Any?) -> Int64? {
    if let i = value as? Int64 { return i }
    if let i = value as? Int { return Int64(i) }
    if let n = value as? NSNumber { return n.int64Value }
    if let d = value as? Double { return Int64(d) }
    return nil
  }

  static func double(_ value: Any?) -> Double? {
    if let d = value as? Double { return d }
    if let n = value as? NSNumber { return n.doubleValue }
    if let i = value as? Int { return Double(i) }
    return nil
  }

  static func dict(_ value: Any?) -> [String: Any]? {
    value as? [String: Any]
  }

  static func array(_ value: Any?) -> [Any]? {
    value as? [Any]
  }

  static func stringArray(_ value: Any?) -> [String]? {
    guard let arr = value as? [Any] else { return nil }
    return arr.compactMap { $0 as? String }
  }
}
