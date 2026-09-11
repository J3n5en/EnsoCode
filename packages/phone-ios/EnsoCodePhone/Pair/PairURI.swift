import Foundation

struct PairInvite: Equatable {
  var relay: String
  var publicKey: Data
}

enum PairURI {
  static func parse(_ raw: String) throws -> PairInvite {
    let text = raw.trimmingCharacters(in: .whitespacesAndNewlines)
    if let custom = text.range(of: #"^enso://pair\?(.*)$"#, options: .regularExpression) {
      let query = String(text[custom].dropFirst("enso://pair?".count))
      return try fromParams(URLComponents(string: "x://x?\(query)")?.queryItems ?? [], fallbackRelay: nil)
    }
    if text.lowercased().hasPrefix("http://") || text.lowercased().hasPrefix("https://") {
      guard let url = URL(string: text) else { throw PairError.notPairURI }
      var query = url.fragment ?? ""
      if !query.contains("pk=") { query = url.query ?? "" }
      let items = Self.queryItems(query)
      var origin = "\(url.scheme ?? "https")://\(url.host ?? "")"
      if let port = url.port { origin += ":\(port)" }
      return try fromParams(items, fallbackRelay: origin)
    }
    throw PairError.notPairURI
  }

  static func buildLink(_ invite: PairInvite) -> String {
    let pk = Base64URL.encode(invite.publicKey)
    let base = invite.relay.replacingOccurrences(of: #"/+$"#, with: "", options: .regularExpression)
    return "\(base)/#relay=\(invite.relay.addingPercentEncoding(withAllowedCharacters: .urlQueryAllowed) ?? invite.relay)&pk=\(pk)"
  }

  static func buildURI(_ invite: PairInvite) -> String {
    let pk = Base64URL.encode(invite.publicKey)
    let relay = invite.relay.addingPercentEncoding(withAllowedCharacters: .urlQueryAllowed) ?? invite.relay
    return "enso://pair?relay=\(relay)&pk=\(pk)"
  }

  private static func queryItems(_ query: String) -> [URLQueryItem] {
    var items: [URLQueryItem] = []
    for pair in query.split(separator: "&") {
      let parts = pair.split(separator: "=", maxSplits: 1).map(String.init)
      let name = parts[0].removingPercentEncoding ?? parts[0]
      let value = parts.count > 1 ? (parts[1].removingPercentEncoding ?? parts[1]) : ""
      items.append(URLQueryItem(name: name, value: value))
    }
    return items
  }

  private static func fromParams(_ items: [URLQueryItem], fallbackRelay: String?) throws -> PairInvite {
    var relay: String?
    var pk: String?
    for item in items {
      if item.name == "relay" { relay = item.value }
      if item.name == "pk" { pk = item.value }
    }
    relay = relay ?? fallbackRelay
    guard let relay, let pk, let publicKey = Base64URL.decode(pk), !relay.isEmpty else {
      throw PairError.missingRelayOrKey
    }
    return PairInvite(relay: relay, publicKey: publicKey)
  }
}

enum PairError: LocalizedError, Equatable {
  case notPairURI
  case missingRelayOrKey
  case relay(String)
  case network

  var errorDescription: String? {
    switch self {
    case .notPairURI: return "not an enso pair uri"
    case .missingRelayOrKey: return "pair uri missing relay or pk"
    case .relay(let message): return message
    case .network: return "网络错误，请重试"
    }
  }
}

enum RelayURL {
  static let `default` = "https://enso-relay.j3.do"

  static func normalize(_ url: String) -> String {
    url.trimmingCharacters(in: .whitespacesAndNewlines).replacingOccurrences(
      of: #"/+$"#,
      with: "",
      options: .regularExpression
    )
  }

  static func webSocket(_ relayUrl: String) -> String {
    normalize(relayUrl).replacingOccurrences(of: #"^http"#, with: "ws", options: .regularExpression)
  }

  static func backoffDelay(attempt: Int) -> TimeInterval {
    let base = min(30_000.0, 1000.0 * pow(2.0, Double(max(0, attempt))))
    return (base * (0.7 + Double.random(in: 0..<0.6)) / 1000.0)
  }
}
