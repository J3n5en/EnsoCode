import CryptoKit
import Foundation
import Security

/// RFC 8291 (`aes128gcm`) 端到端 Web Push 加解密与密钥管理：
/// - 与桌面端 `web-push` 完全互通：中继只透传密文，主 App 与 Notification Service Extension 共享同一套
///   P-256 ECDH 私钥 + 16 字节 auth secret（存在 Keychain Access Group 中，无需额外 App Group 也能跨扩展共享）。
public enum WebPushCryptoError: Error, Equatable {
    case invalidHeader
    case invalidKeyLength
    case invalidRecordSize
    case invalidPadding
    case decryptFailed
    case invalidVapidKey
}

public struct WebPushKeyMaterial: Codable, Equatable, Sendable {
    /// 32 字节 P-256 原始私钥
    public let privateKeyRaw: Data
    /// 65 字节未压缩 P-256 公钥 (`0x04 || X || Y`)
    public let publicKeyX963: Data
    /// 16 字节随机 auth secret
    public let authSecret: Data

    public init(privateKeyRaw: Data, publicKeyX963: Data, authSecret: Data) {
        self.privateKeyRaw = privateKeyRaw
        self.publicKeyX963 = publicKeyX963
        self.authSecret = authSecret
    }

    public var p256dhBase64Url: String { WebPushCrypto.base64UrlEncode(publicKeyX963) }
    public var authBase64Url: String { WebPushCrypto.base64UrlEncode(authSecret) }
}

public struct DecryptedPushPayload: Codable, Equatable, Sendable {
    public let title: String
    public let body: String
    public let sessionId: String
    public let pending: Bool
}

public enum WebPushCrypto {
    /// 生成一对新的 P-256 ECDH 密钥 + 16 字节 auth secret
    public static func generateKeyMaterial() -> WebPushKeyMaterial {
        let priv = P256.KeyAgreement.PrivateKey()
        var authBytes = [UInt8](repeating: 0, count: 16)
        let status = SecRandomCopyBytes(kSecRandomDefault, authBytes.count, &authBytes)
        if status != errSecSuccess {
            for i in 0..<authBytes.count { authBytes[i] = UInt8.random(in: 0...255) }
        }
        return WebPushKeyMaterial(
            privateKeyRaw: priv.rawRepresentation,
            publicKeyX963: priv.publicKey.x963Representation,
            authSecret: Data(authBytes)
        )
    }

    /// 根据 VAPID 公钥 base64url 计算 SHA-256 base64url 指纹（拼入推送 URL `?k=`）
    public static func vapidKeyHash(vapidPublicKeyBase64Url: String) throws -> String {
        guard let raw = base64UrlDecode(vapidPublicKeyBase64Url), raw.count == 65, raw[0] == 0x04 else {
            throw WebPushCryptoError.invalidVapidKey
        }
        let digest = SHA256.hash(data: raw)
        return base64UrlEncode(Data(digest))
    }

    /// 解密 RFC 8291 (`aes128gcm`) 密文，返回明文字节。
    /// Header 结构 (RFC 8188 / RFC 8291):
    ///   salt (16B) || rs (4B big-endian) || idlen (1B, 必须为 65) || keyid (65B 发送方未压缩 P-256 公钥) || ciphertext...
    public static func decryptAes128Gcm(
        ciphertext: Data,
        privateKeyRaw: Data,
        authSecret: Data
    ) throws -> Data {
        guard authSecret.count == 16 else { throw WebPushCryptoError.invalidKeyLength }
        let minHeaderLen = 16 + 4 + 1 + 65
        guard ciphertext.count > minHeaderLen + 16 else { throw WebPushCryptoError.invalidHeader }

        let salt = ciphertext.subdata(in: 0..<16)
        let rs =
            (UInt32(ciphertext[16]) << 24)
            | (UInt32(ciphertext[17]) << 16)
            | (UInt32(ciphertext[18]) << 8)
            | UInt32(ciphertext[19])
        guard rs >= 18 else { throw WebPushCryptoError.invalidRecordSize }

        let idLen = Int(ciphertext[20])
        guard idLen == 65, ciphertext.count > 21 + idLen + 16 else {
            throw WebPushCryptoError.invalidHeader
        }
        let senderPubBytes = ciphertext.subdata(in: 21..<(21 + idLen))
        let bodyOffset = 21 + idLen

        let receiverPriv: P256.KeyAgreement.PrivateKey
        let senderPub: P256.KeyAgreement.PublicKey
        do {
            receiverPriv = try P256.KeyAgreement.PrivateKey(rawRepresentation: privateKeyRaw)
            senderPub = try P256.KeyAgreement.PublicKey(x963Representation: senderPubBytes)
        } catch {
            throw WebPushCryptoError.invalidKeyLength
        }

        let receiverPubBytes = receiverPriv.publicKey.x963Representation
        let sharedSecret: SharedSecret
        do {
            sharedSecret = try receiverPriv.sharedSecretFromKeyAgreement(with: senderPub)
        } catch {
            throw WebPushCryptoError.decryptFailed
        }

        // RFC 8291 Section 3.3:
        // key_info = "WebPush: info\0" || ua_public (65B) || as_public (65B)
        // IKM = HKDF-SHA256(salt=auth_secret, ikm=ecdh_secret, info=key_info, L=32)
        var keyInfo = Data("WebPush: info\u{00}".utf8)
        keyInfo.append(receiverPubBytes)
        keyInfo.append(senderPubBytes)
        let ikm = sharedSecret.hkdfDerivedSymmetricKey(
            using: SHA256.self,
            salt: authSecret,
            sharedInfo: keyInfo,
            outputByteCount: 32
        )

        // RFC 8188 Section 2.2 / 2.3:
        // CEK = HKDF-SHA256(salt=header.salt, ikm=IKM, info="Content-Encoding: aes128gcm\0", L=16)
        // NONCE = HKDF-SHA256(salt=header.salt, ikm=IKM, info="Content-Encoding: nonce\0", L=12)
        let cekInfo = Data("Content-Encoding: aes128gcm\u{00}".utf8)
        let nonceInfo = Data("Content-Encoding: nonce\u{00}".utf8)
        let cek = HKDF<SHA256>.deriveKey(
            inputKeyMaterial: ikm,
            salt: salt,
            info: cekInfo,
            outputByteCount: 16
        )
        let baseNonceKey = HKDF<SHA256>.deriveKey(
            inputKeyMaterial: ikm,
            salt: salt,
            info: nonceInfo,
            outputByteCount: 12
        )
        let baseNonce = baseNonceKey.withUnsafeBytes { Data($0) }

        // 支持单条或多条 RFC 8188 记录解密
        var output = Data()
        var offset = bodyOffset
        var seq: UInt64 = 0
        let recordSize = Int(rs)
        var sawFinal = false

        while offset < ciphertext.count {
            let end = min(offset + recordSize, ciphertext.count)
            let record = ciphertext.subdata(in: offset..<end)
            guard record.count > 16 else { throw WebPushCryptoError.decryptFailed }

            let ct = record.prefix(record.count - 16)
            let tag = record.suffix(16)
            let nonceData = xorNonce(baseNonce, seq: seq)
            let plain: Data
            do {
                let nonce = try AES.GCM.Nonce(data: nonceData)
                let box = try AES.GCM.SealedBox(nonce: nonce, ciphertext: ct, tag: tag)
                plain = try AES.GCM.open(box, using: cek)
            } catch {
                throw WebPushCryptoError.decryptFailed
            }

            // 去掉尾部 0x00 填充，最后一个非零字节为分隔符（0x02 表示末块，0x01 表示非末块）
            var delimIdx = plain.count - 1
            while delimIdx >= 0 && plain[delimIdx] == 0x00 {
                delimIdx -= 1
            }
            guard delimIdx >= 0 else { throw WebPushCryptoError.invalidPadding }
            let delim = plain[delimIdx]
            let isLast = (end == ciphertext.count)
            if isLast {
                guard delim == 0x02 else { throw WebPushCryptoError.invalidPadding }
                sawFinal = true
            } else {
                guard delim == 0x01 else { throw WebPushCryptoError.invalidPadding }
            }
            output.append(plain.prefix(delimIdx))
            offset = end
            seq += 1
        }
        guard sawFinal else { throw WebPushCryptoError.invalidPadding }
        return output
    }

    /// 解密并解析 EnsoCode 标准推送 JSON (`{ title, body, sessionId, pending }`)
    public static func decryptPushPayload(
        ciphertextBase64: String,
        keys: WebPushKeyMaterial
    ) throws -> DecryptedPushPayload {
        guard let raw = Data(base64Encoded: ciphertextBase64) else {
            throw WebPushCryptoError.invalidHeader
        }
        let plain = try decryptAes128Gcm(
            ciphertext: raw,
            privateKeyRaw: keys.privateKeyRaw,
            authSecret: keys.authSecret
        )
        return try JSONDecoder().decode(DecryptedPushPayload.self, from: plain)
    }

    private static func xorNonce(_ base: Data, seq: UInt64) -> Data {
        var out = [UInt8](base)
        for i in 0..<8 {
            let shift = UInt64((7 - i) * 8)
            out[4 + i] ^= UInt8((seq >> shift) & 0xFF)
        }
        return Data(out)
    }

    public static func base64UrlEncode(_ data: Data) -> String {
        data.base64EncodedString()
            .replacingOccurrences(of: "+", with: "-")
            .replacingOccurrences(of: "/", with: "_")
            .replacingOccurrences(of: "=", with: "")
    }

    public static func base64UrlDecode(_ input: String) -> Data? {
        var b64 = input
            .replacingOccurrences(of: "-", with: "+")
            .replacingOccurrences(of: "_", with: "/")
        let rem = b64.count % 4
        if rem != 0 { b64 += String(repeating: "=", count: 4 - rem) }
        return Data(base64Encoded: b64)
    }
}

/// 跨主 App、NotificationServiceExtension 与后续 Widget/LiveActivity 扩展共享的 Keychain 密钥仓库。
/// 依赖 `keychain-access-groups: ["$(AppIdentifierPrefix)com.j3n5en.ensocode.shared"]`。
public final class SharedPushKeyStore: @unchecked Sendable {
    public static let defaultService = "com.j3n5en.ensocode.webpush"
    public static let defaultAccount = "default-e2e-keys"
    public static let sharedAccessGroupSuffix = "com.j3n5en.ensocode.shared"

    private let service: String
    private let account: String
    private let accessGroup: String?

    public init(
        service: String = SharedPushKeyStore.defaultService,
        account: String = SharedPushKeyStore.defaultAccount,
        accessGroup: String? = nil
    ) {
        self.service = service
        self.account = account
        self.accessGroup = accessGroup
    }

    /// 从主 App 或 NSE 的 Info.plist (`AppIdentifierPrefix`) 推导出完整 Access Group
    public static func resolvedAccessGroup(bundle: Bundle = .main) -> String? {
        guard let prefix = bundle.object(forInfoDictionaryKey: "AppIdentifierPrefix") as? String,
              !prefix.isEmpty
        else { return nil }
        return prefix + sharedAccessGroupSuffix
    }

    public func load() -> WebPushKeyMaterial? {
        var query = baseQuery()
        query[kSecReturnData as String] = true
        query[kSecMatchLimit as String] = kSecMatchLimitOne
        var item: CFTypeRef?
        let status = SecItemCopyMatching(query as CFDictionary, &item)
        guard status == errSecSuccess, let data = item as? Data else { return nil }
        return try? JSONDecoder().decode(WebPushKeyMaterial.self, from: data)
    }

    @discardableResult
    public func save(_ material: WebPushKeyMaterial) -> Bool {
        guard let data = try? JSONEncoder().encode(material) else { return false }
        let query = baseQuery()
        SecItemDelete(query as CFDictionary)
        var add = query
        add[kSecValueData as String] = data
        add[kSecAttrAccessible as String] = kSecAttrAccessibleAfterFirstUnlockThisDeviceOnly
        return SecItemAdd(add as CFDictionary, nil) == errSecSuccess
    }

    public func loadOrCreate() -> WebPushKeyMaterial {
        if let existing = load() { return existing }
        let fresh = WebPushCrypto.generateKeyMaterial()
        _ = save(fresh)
        return fresh
    }

    private func baseQuery() -> [String: Any] {
        var q: [String: Any] = [
            kSecClass as String: kSecClassGenericPassword,
            kSecAttrService as String: service,
            kSecAttrAccount as String: account,
        ]
        if let accessGroup, !accessGroup.isEmpty {
            q[kSecAttrAccessGroup as String] = accessGroup
        }
        return q
    }
}
