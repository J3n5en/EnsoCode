import CryptoKit
import Foundation
import Security

enum PairCryptoError: Error, Equatable {
  case malformed
  case unboxFailed
  case frameTooShort
  case unsupportedVersion(UInt8)
  case decryptFailed
  case invalidJSON
  case invalidKeyLength
}

enum Base64URL {
  static func encode(_ data: Data) -> String {
    data.base64EncodedString()
      .replacingOccurrences(of: "+", with: "-")
      .replacingOccurrences(of: "/", with: "_")
      .replacingOccurrences(of: "=", with: "")
  }

  static func decode(_ text: String) -> Data? {
    var b64 = text.replacingOccurrences(of: "-", with: "+").replacingOccurrences(of: "_", with: "/")
    let pad = (4 - b64.count % 4) % 4
    if pad > 0 { b64 += String(repeating: "=", count: pad) }
    return Data(base64Encoded: b64)
  }
}

enum RandomBytes {
  static func generate(_ count: Int) -> Data {
    var data = Data(count: count)
    let status = data.withUnsafeMutableBytes { SecRandomCopyBytes(kSecRandomDefault, count, $0.baseAddress!) }
    if status == errSecSuccess { return data }
    var fallback = Data(count: count)
    for i in 0..<count { fallback[i] = UInt8.random(in: 0...255) }
    return fallback
  }
}

enum NaClBox {
  static let publicKeyBytes = 32
  static let secretKeyBytes = 32
  static let nonceBytes = 24
  static let zeroBytes = 32
  static let boxZeroBytes = 16

  struct Keypair {
    var publicKey: Data
    var secretKey: Data
  }

  static func keypair() -> Keypair {
    var pk = Data(count: publicKeyBytes)
    var sk = Data(count: secretKeyBytes)
    pk.withUnsafeMutableBytes { pkb in
      sk.withUnsafeMutableBytes { skb in
        _ = nacl_box_keypair(
          pkb.bindMemory(to: UInt8.self).baseAddress,
          skb.bindMemory(to: UInt8.self).baseAddress
        )
      }
    }
    return Keypair(publicKey: pk, secretKey: sk)
  }

  static func box(message: Data, nonce: Data, publicKey: Data, secretKey: Data) -> Data? {
    guard nonce.count == nonceBytes, publicKey.count == publicKeyBytes, secretKey.count == secretKeyBytes
    else { return nil }
    var padded = Data(count: zeroBytes)
    padded.append(message)
    var cipher = Data(count: padded.count)
    let rc = padded.withUnsafeBytes { mb in
      cipher.withUnsafeMutableBytes { cb in
        nonce.withUnsafeBytes { nb in
          publicKey.withUnsafeBytes { pkb in
            secretKey.withUnsafeBytes { skb in
              nacl_box(
                cb.bindMemory(to: UInt8.self).baseAddress,
                mb.bindMemory(to: UInt8.self).baseAddress,
                UInt64(padded.count),
                nb.bindMemory(to: UInt8.self).baseAddress,
                pkb.bindMemory(to: UInt8.self).baseAddress,
                skb.bindMemory(to: UInt8.self).baseAddress
              )
            }
          }
        }
      }
    }
    guard rc == 0 else { return nil }
    return Data(cipher.dropFirst(boxZeroBytes))
  }

  static func open(boxed: Data, nonce: Data, publicKey: Data, secretKey: Data) -> Data? {
    guard nonce.count == nonceBytes, publicKey.count == publicKeyBytes, secretKey.count == secretKeyBytes
    else { return nil }
    var cipher = Data(count: boxZeroBytes)
    cipher.append(boxed)
    var message = Data(count: cipher.count)
    let rc = cipher.withUnsafeBytes { cb in
      message.withUnsafeMutableBytes { mb in
        nonce.withUnsafeBytes { nb in
          publicKey.withUnsafeBytes { pkb in
            secretKey.withUnsafeBytes { skb in
              nacl_box_open(
                mb.bindMemory(to: UInt8.self).baseAddress,
                cb.bindMemory(to: UInt8.self).baseAddress,
                UInt64(cipher.count),
                nb.bindMemory(to: UInt8.self).baseAddress,
                pkb.bindMemory(to: UInt8.self).baseAddress,
                skb.bindMemory(to: UInt8.self).baseAddress
              )
            }
          }
        }
      }
    }
    guard rc == 0 else { return nil }
    return Data(message.dropFirst(zeroBytes))
  }
}

struct BoxedContentKey {
  var ephPublicKey: Data
  var nonce: Data
  var boxed: Data

  func encode() -> String {
    [Base64URL.encode(ephPublicKey), Base64URL.encode(nonce), Base64URL.encode(boxed)].joined(separator: ".")
  }

  static func decode(_ text: String) throws -> BoxedContentKey {
    let parts = text.split(separator: ".", omittingEmptySubsequences: false).map(String.init)
    guard parts.count == 3,
      let eph = Base64URL.decode(parts[0]),
      let nonce = Base64URL.decode(parts[1]),
      let boxed = Base64URL.decode(parts[2])
    else { throw PairCryptoError.malformed }
    return BoxedContentKey(ephPublicKey: eph, nonce: nonce, boxed: boxed)
  }
}

enum PairCrypto {
  static let contentKeyLen = 32
  static let nonceLen = 12
  static let tagLen = 16
  static let version: UInt8 = 1

  static func generateContentKey() -> Data {
    RandomBytes.generate(contentKeyLen)
  }

  static func boxContentKey(_ contentKey: Data, recipientPublicKey: Data) throws -> BoxedContentKey {
    let eph = NaClBox.keypair()
    let nonce = RandomBytes.generate(NaClBox.nonceBytes)
    guard let boxed = NaClBox.box(
      message: contentKey,
      nonce: nonce,
      publicKey: recipientPublicKey,
      secretKey: eph.secretKey
    ) else { throw PairCryptoError.unboxFailed }
    return BoxedContentKey(ephPublicKey: eph.publicKey, nonce: nonce, boxed: boxed)
  }

  static func openBoxedContentKey(_ boxed: BoxedContentKey, recipientSecretKey: Data) throws -> Data {
    guard let out = NaClBox.open(
      boxed: boxed.boxed,
      nonce: boxed.nonce,
      publicKey: boxed.ephPublicKey,
      secretKey: recipientSecretKey
    ) else { throw PairCryptoError.unboxFailed }
    return out
  }

  static func sealFrame(contentKey: Data, payload: Any) throws -> Data {
    guard contentKey.count == contentKeyLen else { throw PairCryptoError.invalidKeyLength }
    guard let plaintext = JSONUtil.data(payload) else { throw PairCryptoError.invalidJSON }
    let key = SymmetricKey(data: contentKey)
    let nonceData = RandomBytes.generate(nonceLen)
    let nonce = try AES.GCM.Nonce(data: nonceData)
    let sealed = try AES.GCM.seal(plaintext, using: key, nonce: nonce)
    guard let combined = sealed.combined else { throw PairCryptoError.decryptFailed }
    var frame = Data([version])
    frame.append(combined)
    return frame
  }

  static func openFrame(contentKey: Data, frame: Data) throws -> Any {
    guard contentKey.count == contentKeyLen else { throw PairCryptoError.invalidKeyLength }
    guard frame.count >= 1 + nonceLen + tagLen else { throw PairCryptoError.frameTooShort }
    guard frame[0] == version else { throw PairCryptoError.unsupportedVersion(frame[0]) }
    let combined = frame.subdata(in: 1..<frame.count)
    let box: AES.GCM.SealedBox
    do {
      box = try AES.GCM.SealedBox(combined: combined)
    } catch {
      throw PairCryptoError.decryptFailed
    }
    let key = SymmetricKey(data: contentKey)
    let plaintext: Data
    do {
      plaintext = try AES.GCM.open(box, using: key)
    } catch {
      throw PairCryptoError.decryptFailed
    }
    guard let json = JSONUtil.any(plaintext) else { throw PairCryptoError.invalidJSON }
    return json
  }
}
