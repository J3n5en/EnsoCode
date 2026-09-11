import Foundation
import UIKit

enum Handshake {
  static func claim(relayUrl: String, hostPublicKey: Data, deviceName: String) async throws -> PairedDevice {
    let relay = RelayURL.normalize(relayUrl)
    let contentKey = PairCrypto.generateContentKey()
    let boxed = try PairCrypto.boxContentKey(contentKey, recipientPublicKey: hostPublicKey)
    let json = try await postJSON(
      "\(relay)/v1/pair/claim",
      body: [
        "publicKey": Base64URL.encode(hostPublicKey),
        "boxedKey": boxed.encode(),
        "deviceName": deviceName,
      ]
    )
    guard let pairId = JSONUtil.string(json["pairId"]),
      let token = JSONUtil.string(json["deviceToken"])
    else { throw PairError.relay("relay missing pairId") }
    return PairedDevice(
      pairId: pairId,
      token: token,
      contentKey: Base64URL.encode(contentKey),
      deviceName: deviceName,
      relayUrl: relay,
      pairedAt: Int64(Date().timeIntervalSince1970 * 1000)
    )
  }

  static func revoke(relayUrl: String, pairId: String, token: String) async {
    let relay = RelayURL.normalize(relayUrl)
    let encodedPair = pairId.addingPercentEncoding(withAllowedCharacters: .urlPathAllowed) ?? pairId
    let encodedToken = token.addingPercentEncoding(withAllowedCharacters: .urlQueryAllowed) ?? token
    guard let url = URL(string: "\(relay)/v1/pair/\(encodedPair)?token=\(encodedToken)") else { return }
    var req = URLRequest(url: url)
    req.httpMethod = "DELETE"
    req.timeoutInterval = 10
    _ = try? await URLSession.shared.data(for: req)
  }

  static func deviceName() -> String {
    UIDevice.current.userInterfaceIdiom == .pad ? "iPad" : "iPhone"
  }

  private static func postJSON(_ urlString: String, body: [String: Any]) async throws -> [String: Any] {
    guard let url = URL(string: urlString), let payload = JSONUtil.data(body) else { throw PairError.network }
    var lastError: Error = PairError.network
    for attempt in 0..<2 {
      do {
        var req = URLRequest(url: url)
        req.httpMethod = "POST"
        req.setValue("application/json", forHTTPHeaderField: "content-type")
        req.httpBody = payload
        req.timeoutInterval = 10
        let (data, response) = try await URLSession.shared.data(for: req)
        let json = JSONUtil.object(data) ?? [:]
        let status = (response as? HTTPURLResponse)?.statusCode ?? 0
        if (200..<300).contains(status) { return json }
        throw PairError.relay(JSONUtil.string(json["error"]) ?? "relay \(status)")
      } catch let error as PairError {
        throw error
      } catch {
        lastError = error
        if attempt == 1 { throw PairError.network }
      }
    }
    throw lastError
  }
}
